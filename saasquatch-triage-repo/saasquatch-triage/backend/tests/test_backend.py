"""Backend tests (stdlib unittest; no network). Run from backend/:
    python -m unittest discover -s tests -v
"""
import threading
import time
import unittest

from triage_api.domain_check import DomainChecker, normalize_domain
from triage_api.ratelimit import RateLimiter
from triage_api.storage import Store


class FakeDNS:
    def __init__(self, table):
        self.table = table
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, domain):
        with self.lock:
            self.calls.append(domain)
        if domain in self.table:
            return self.table[domain]
        return {"resolves": None, "has_mx": None}  # simulate timeout


class NormalizeDomainTest(unittest.TestCase):
    def test_strips_scheme_www_path_and_email_local_part(self):
        self.assertEqual(normalize_domain("https://www.Acme.com/contact"), "acme.com")
        self.assertEqual(normalize_domain("jane@acme.co"), "acme.co")
        self.assertIsNone(normalize_domain("not a domain"))
        self.assertIsNone(normalize_domain(""))


class DomainCheckerTest(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.dns = FakeDNS({
            "good.com": {"resolves": True, "has_mx": True},
            "webonly.com": {"resolves": True, "has_mx": False},
            "gone.com": {"resolves": False, "has_mx": False},
        })
        self.checker = DomainChecker(self.store, lookup=self.dns)

    def test_live_then_cached(self):
        first = self.checker.check(["good.com", "https://www.webonly.com", "gone.com", "good.com"])
        self.assertEqual(first["stats"], {"requested": 3, "cache_hits": 0, "live_lookups": 3})
        self.assertTrue(first["results"]["good.com"]["has_mx"])
        self.assertFalse(first["results"]["webonly.com"]["has_mx"])
        self.assertFalse(first["results"]["gone.com"]["resolves"])

        second = self.checker.check(["good.com", "gone.com"])
        self.assertEqual(second["stats"]["cache_hits"], 2)
        self.assertEqual(second["stats"]["live_lookups"], 0)
        self.assertEqual(second["results"]["good.com"]["source"], "cache")
        self.assertEqual(len(self.dns.calls), 3, "cache prevented repeat lookups")

    def test_inconclusive_results_are_not_cached(self):
        self.checker.check(["flaky.com"])
        self.checker.check(["flaky.com"])
        self.assertEqual(self.dns.calls.count("flaky.com"), 2)

    def test_expired_cache_entries_are_refreshed(self):
        checker = DomainChecker(self.store, lookup=self.dns, ttl_seconds=0.05)
        checker.check(["good.com"])
        time.sleep(0.1)
        r = checker.check(["good.com"])
        self.assertEqual(r["stats"]["live_lookups"], 1)

    def test_invalid_inputs_reported_not_looked_up(self):
        r = self.checker.check(["???", "good.com"])
        self.assertEqual(r["invalid"], ["???"])
        self.assertNotIn("???", self.dns.calls)

    def test_lookup_exception_does_not_fail_batch(self):
        def boom(d):
            if d == "bad.com":
                raise RuntimeError("resolver crashed")
            return {"resolves": True, "has_mx": True}

        r = DomainChecker(self.store, lookup=boom).check(["bad.com", "ok.com"])
        self.assertIsNone(r["results"]["bad.com"]["resolves"])
        self.assertTrue(r["results"]["ok.com"]["has_mx"])


class StoreListsTest(unittest.TestCase):
    def test_save_list_get_delete(self):
        s = Store(":memory:")
        meta = s.save_list("Q4 HVAC targets", {"mode": "acquisition"}, [{"company": "Acme"}])
        self.assertEqual(meta["lead_count"], 1)
        self.assertEqual(s.list_lists()[0]["name"], "Q4 HVAC targets")
        full = s.get_list(meta["id"])
        self.assertEqual(full["leads"][0]["company"], "Acme")
        self.assertTrue(s.delete_list(meta["id"]))
        self.assertIsNone(s.get_list(meta["id"]))
        self.assertFalse(s.delete_list(meta["id"]))


class RateLimiterTest(unittest.TestCase):
    def test_burst_then_refill(self):
        rl = RateLimiter(rate_per_sec=1, burst=3)
        self.assertTrue(all(rl.allow("ip", now=0) for _ in range(3)))
        self.assertFalse(rl.allow("ip", now=0))
        self.assertTrue(rl.allow("ip", now=1.0))
        self.assertTrue(rl.allow("other", now=0), "buckets are per client")


if __name__ == "__main__":
    unittest.main()
