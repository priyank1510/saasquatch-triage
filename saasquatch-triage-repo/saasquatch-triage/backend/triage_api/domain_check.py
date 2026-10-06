"""Domain and MX checks — the one validation a browser cannot do.

A lead whose email domain has no MX record will bounce no matter how well the
address is formatted, and a website domain that does not resolve usually means
the business is closed or the scrape is stale. Both change what a rep should do.

Lookups are I/O-bound, so a batch fans out over a thread pool with a per-lookup
timeout. Results are cached in SQLite for 7 days: DNS for small businesses rarely
changes, and re-importing the same export should cost zero lookups.
"""
from __future__ import annotations

import re
import socket
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Callable, Iterable

from .storage import Store

try:  # dnspython gives real MX answers; without it we fall back to A/AAAA only
    import dns.exception
    import dns.resolver

    HAVE_DNSPYTHON = True
except ImportError:  # pragma: no cover - depends on environment
    HAVE_DNSPYTHON = False

DOMAIN_RE = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
MAX_BATCH = 500

Lookup = Callable[[str], dict]


def normalize_domain(value: str) -> str | None:
    d = (value or "").strip().lower()
    d = re.sub(r"^[a-z][a-z0-9+.-]*://", "", d)
    d = re.sub(r"^www\d?\.", "", d)
    d = re.split(r"[/?#:\s]", d)[0].rstrip(".")
    if "@" in d:
        d = d.rsplit("@", 1)[1]
    return d if DOMAIN_RE.match(d) else None


def _socket_lookup(domain: str) -> dict:
    try:
        socket.getaddrinfo(domain, None)
        return {"resolves": True, "has_mx": None}
    except socket.gaierror as exc:
        # EAI_NONAME means the name definitively does not exist
        if exc.errno in (socket.EAI_NONAME, getattr(socket, "EAI_NODATA", -999)):
            return {"resolves": False, "has_mx": False}
        return {"resolves": None, "has_mx": None}


def _dnspython_lookup(domain: str, timeout: float) -> dict:  # pragma: no cover - network
    resolver = dns.resolver.Resolver()
    resolver.lifetime = timeout
    try:
        answers = resolver.resolve(domain, "MX")
        has_mx = any(str(r.exchange).rstrip(".") for r in answers)
        return {"resolves": True, "has_mx": has_mx}
    except dns.resolver.NXDOMAIN:
        return {"resolves": False, "has_mx": False}
    except dns.resolver.NoAnswer:
        # No MX: RFC 5321 falls back to the A record, but small-business domains with
        # no MX are almost always parked or web-only. Report resolves, not deliverable.
        try:
            resolver.resolve(domain, "A")
            return {"resolves": True, "has_mx": False}
        except Exception:
            return {"resolves": False, "has_mx": False}
    except (dns.exception.Timeout, dns.resolver.NoNameservers):
        return {"resolves": None, "has_mx": None}


class DomainChecker:
    def __init__(
        self,
        store: Store,
        ttl_seconds: float = 7 * 24 * 3600,
        timeout: float = 3.0,
        max_workers: int = 16,
        lookup: Lookup | None = None,
    ) -> None:
        self.store = store
        self.ttl = ttl_seconds
        self.timeout = timeout
        self.max_workers = max_workers
        if lookup is not None:
            self._lookup = lookup
        elif HAVE_DNSPYTHON:
            self._lookup = lambda d: _dnspython_lookup(d, timeout)
        else:
            self._lookup = _socket_lookup
        self.mode = "custom" if lookup else ("mx" if HAVE_DNSPYTHON else "a-record")

    def check(self, raw_domains: Iterable[str]) -> dict:
        seen: dict[str, None] = {}
        invalid: list[str] = []
        for raw in raw_domains:
            d = normalize_domain(raw)
            if d is None:
                invalid.append(raw)
            else:
                seen.setdefault(d, None)
        domains = list(seen)[:MAX_BATCH]

        cached = self.store.get_cached_domains(domains, self.ttl)
        misses = [d for d in domains if d not in cached]
        fresh: list[dict] = []
        if misses:
            now = time.time()
            with ThreadPoolExecutor(max_workers=min(self.max_workers, len(misses))) as pool:
                futures = {d: pool.submit(self._lookup, d) for d in misses}
                for d, fut in futures.items():
                    try:
                        res = fut.result(timeout=self.timeout + 1)
                    except FutureTimeout:
                        res = {"resolves": None, "has_mx": None}
                    except Exception:
                        res = {"resolves": None, "has_mx": None}
                    fresh.append({"domain": d, "resolves": res.get("resolves"), "has_mx": res.get("has_mx"), "checked_at": now})
            # Only cache conclusive answers; a timeout today may succeed tomorrow.
            self.store.put_domain_results([r for r in fresh if r["resolves"] is not None])

        results = {}
        for d in domains:
            if d in cached:
                results[d] = {**cached[d], "source": "cache"}
        for r in fresh:
            results[r["domain"]] = {**r, "source": "live"}
        return {
            "results": results,
            "invalid": invalid,
            "stats": {"requested": len(domains), "cache_hits": len(cached), "live_lookups": len(fresh)},
            "mode": self.mode,
        }
