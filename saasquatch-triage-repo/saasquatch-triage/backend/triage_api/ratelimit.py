"""Token-bucket rate limiter, per client key. In-process: fine for one container;
behind several replicas this moves to Redis or the API gateway."""
from __future__ import annotations

import threading
import time


class RateLimiter:
    def __init__(self, rate_per_sec: float, burst: int) -> None:
        self.rate = rate_per_sec
        self.burst = burst
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, cost: float = 1.0, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            tokens, last = self._buckets.get(key, (float(self.burst), now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            if tokens < cost:
                self._buckets[key] = (tokens, now)
                return False
            self._buckets[key] = (tokens - cost, now)
            if len(self._buckets) > 10_000:  # bound memory
                self._buckets.pop(next(iter(self._buckets)))
            return True
