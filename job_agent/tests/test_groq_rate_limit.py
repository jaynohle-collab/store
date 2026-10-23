"""Groq free-tier per-minute 429s are waited out instead of opening the circuit."""

from __future__ import annotations

import json
import unittest

import httpx

from job_agent.auto_discovery.evaluate.providers import (
    GroqProvider,
    QuotaExhaustedError,
    groq_per_minute_wait,
)

OK = {"choices": [{"message": {"content": json.dumps({"ok": True})}}]}
TPM = {"error": {"code": "rate_limit_exceeded", "message": "Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7900. Please try again in 7.5s."}}
TPD = {"error": {"code": "rate_limit_exceeded", "message": "Rate limit reached on tokens per day (TPD): Limit 200000. Please try again in 1h2m."}}


def _provider(responses: list[httpx.Response], sleeps: list[float]) -> GroqProvider:
    queue = list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        return queue.pop(0)

    p = GroqProvider("k", model="m", transport=httpx.MockTransport(handler))
    p._sleep = sleeps.append  # type: ignore[assignment]
    return p


class GroqRateLimitTests(unittest.TestCase):
    def test_per_minute_429_waits_then_succeeds(self):
        sleeps: list[float] = []
        p = _provider([httpx.Response(429, json=TPM), httpx.Response(200, json=OK)], sleeps)
        self.assertEqual(p.complete_json(system="s", user="u", schema={}), {"ok": True})
        self.assertEqual(len(sleeps), 1)
        self.assertAlmostEqual(sleeps[0], 8.0)

    def test_retry_after_header_wins_and_is_capped(self):
        # parse_retry_after caps headers at 30s; +0.5s safety margin.
        r = httpx.Response(429, json=TPM, headers={"retry-after": "300"})
        self.assertEqual(groq_per_minute_wait(r), 30.5)
        r = httpx.Response(429, json=TPM, headers={"retry-after": "3"})
        self.assertEqual(groq_per_minute_wait(r), 3.5)

    def test_daily_limit_is_not_waited(self):
        sleeps: list[float] = []
        p = _provider([httpx.Response(429, json=TPD)], sleeps)
        with self.assertRaises(QuotaExhaustedError):
            p.complete_json(system="s", user="u", schema={})
        self.assertEqual(sleeps, [])

    def test_waits_are_bounded(self):
        sleeps: list[float] = []
        p = _provider([httpx.Response(429, json=TPM) for _ in range(10)], sleeps)
        p.max_rate_limit_waits = 2
        with self.assertRaises(QuotaExhaustedError):
            p.complete_json(system="s", user="u", schema={})
        self.assertEqual(len(sleeps), 2)


if __name__ == "__main__":
    unittest.main()
