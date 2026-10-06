"""SQLite storage: a domain-check cache and saved lead lists.

Why SQLite: one file, zero ops, transactional, and fast enough for this workload
(thousands of cache rows, tens of saved lists). WAL mode lets the API read while a
batch of lookups is being written. The Store class is the only thing that touches
SQL, so swapping to Postgres (RDS) later means re-implementing one class.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from typing import Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS domain_cache (
    domain      TEXT PRIMARY KEY,
    resolves    INTEGER,          -- 1 / 0 / NULL (lookup inconclusive)
    has_mx      INTEGER,          -- 1 / 0 / NULL (resolver without MX support)
    checked_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS lead_lists (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  REAL NOT NULL,
    lead_count  INTEGER NOT NULL,
    thesis_json TEXT NOT NULL,
    leads_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_lists_created ON lead_lists (created_at DESC);
"""


def _to_db(v: bool | None) -> int | None:
    return None if v is None else int(bool(v))


def _from_db(v: int | None) -> bool | None:
    return None if v is None else bool(v)


class Store:
    def __init__(self, path: str = "triage.db") -> None:
        self.path = path
        self._local = threading.local()
        conn = self._conn()
        if path != ":memory:":
            conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        conn.commit()

    def _conn(self) -> sqlite3.Connection:
        # One connection per thread: sqlite3 connections are not thread-safe,
        # and the domain checker writes from worker threads.
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    # ---------------------------------------------------------- domain cache
    def get_cached_domains(self, domains: Iterable[str], ttl_seconds: float, now: float | None = None) -> dict[str, dict]:
        domains = list(domains)
        if not domains:
            return {}
        cutoff = (now or time.time()) - ttl_seconds
        out: dict[str, dict] = {}
        conn = self._conn()
        for i in range(0, len(domains), 500):  # stay under SQLite's variable limit
            chunk = domains[i : i + 500]
            marks = ",".join("?" * len(chunk))
            rows = conn.execute(
                f"SELECT domain, resolves, has_mx, checked_at FROM domain_cache WHERE domain IN ({marks}) AND checked_at >= ?",
                (*chunk, cutoff),
            ).fetchall()
            for r in rows:
                out[r["domain"]] = {
                    "domain": r["domain"],
                    "resolves": _from_db(r["resolves"]),
                    "has_mx": _from_db(r["has_mx"]),
                    "checked_at": r["checked_at"],
                }
        return out

    def put_domain_results(self, results: Iterable[dict]) -> None:
        conn = self._conn()
        conn.executemany(
            "INSERT INTO domain_cache (domain, resolves, has_mx, checked_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(domain) DO UPDATE SET resolves=excluded.resolves, has_mx=excluded.has_mx, checked_at=excluded.checked_at",
            [(r["domain"], _to_db(r["resolves"]), _to_db(r["has_mx"]), r["checked_at"]) for r in results],
        )
        conn.commit()

    def purge_expired(self, ttl_seconds: float) -> int:
        conn = self._conn()
        cur = conn.execute("DELETE FROM domain_cache WHERE checked_at < ?", (time.time() - ttl_seconds,))
        conn.commit()
        return cur.rowcount

    # ------------------------------------------------------------ lead lists
    def save_list(self, name: str, thesis: dict, leads: list[dict]) -> dict:
        list_id = uuid.uuid4().hex[:12]
        created = time.time()
        conn = self._conn()
        conn.execute(
            "INSERT INTO lead_lists (id, name, created_at, lead_count, thesis_json, leads_json) VALUES (?, ?, ?, ?, ?, ?)",
            (list_id, name, created, len(leads), json.dumps(thesis), json.dumps(leads)),
        )
        conn.commit()
        return {"id": list_id, "name": name, "created_at": created, "lead_count": len(leads)}

    def list_lists(self, limit: int = 50) -> list[dict]:
        rows = self._conn().execute(
            "SELECT id, name, created_at, lead_count FROM lead_lists ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_list(self, list_id: str) -> dict | None:
        r = self._conn().execute("SELECT * FROM lead_lists WHERE id = ?", (list_id,)).fetchone()
        if r is None:
            return None
        return {
            "id": r["id"],
            "name": r["name"],
            "created_at": r["created_at"],
            "lead_count": r["lead_count"],
            "thesis": json.loads(r["thesis_json"]),
            "leads": json.loads(r["leads_json"]),
        }

    def delete_list(self, list_id: str) -> bool:
        conn = self._conn()
        cur = conn.execute("DELETE FROM lead_lists WHERE id = ?", (list_id,))
        conn.commit()
        return cur.rowcount > 0
