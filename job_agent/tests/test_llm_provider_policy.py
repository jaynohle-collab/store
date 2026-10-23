"""Free-tier-first provider policy and loud outage reporting."""

from __future__ import annotations

import io
import os
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import mock

from job_agent.auto_discovery.evaluate.providers import (
    ProviderAuthError,
    QuotaExhaustedError,
    _raise_for_provider_http,
    configured_providers,
)
from job_agent.examples.automatic_discovery_run import provider_outage_exit_code

_KEYS = {"GEMINI_API_KEY": "g", "GROQ_API_KEY": "q", "OPENAI_API_KEY": "o"}
_CLEAR = ("AUTO_DISCOVERY_LLM_PROVIDER", "AUTO_DISCOVERY_ALLOW_PAID_PROVIDERS", "GROQ_MODEL")


def _env(**extra: str):
    env = dict(_KEYS, **extra)
    patcher = mock.patch.dict(os.environ, env, clear=False)
    patcher.start()
    for key in _CLEAR:
        if key not in extra:
            os.environ.pop(key, None)
    return patcher


class PaidProviderPolicyTests(unittest.TestCase):
    def tearDown(self) -> None:
        mock.patch.stopall()

    def test_openai_excluded_by_default(self):
        _env()
        self.assertEqual([p.name for p in configured_providers()], ["gemini", "groq"])

    def test_openai_included_when_paid_allowed(self):
        _env(AUTO_DISCOVERY_ALLOW_PAID_PROVIDERS="true")
        self.assertEqual(
            [p.name for p in configured_providers()], ["gemini", "groq", "openai"]
        )

    def test_explicit_openai_override_is_honored(self):
        _env(AUTO_DISCOVERY_LLM_PROVIDER="openai")
        self.assertEqual([p.name for p in configured_providers()], ["openai"])

    def test_groq_model_env_is_used(self):
        _env(GROQ_MODEL="llama-3.1-8b-instant")
        groq = [p for p in configured_providers() if p.name == "groq"][0]
        self.assertEqual(groq.model, "llama-3.1-8b-instant")


class AuthErrorClassificationTests(unittest.TestCase):
    def test_401_and_403_are_provider_auth_errors(self):
        for status in (401, 403):
            with self.subTest(status=status), self.assertRaises(ProviderAuthError):
                _raise_for_provider_http("gemini", status, '{"error":{"status":"PERMISSION_DENIED"}}')

    def test_403_quota_is_still_quota(self):
        with self.assertRaises(QuotaExhaustedError):
            _raise_for_provider_http("gemini", 403, "quota exceeded")


class OutageExitCodeTests(unittest.TestCase):
    def _m(self, **kw):
        base = dict(provider_circuit_open=False, errors=[], evaluations_paused=0, candidates_evaluated=0)
        base.update(kw)
        return SimpleNamespace(**base)

    def test_healthy_run_is_zero(self):
        self.assertEqual(provider_outage_exit_code(self._m()), 0)

    def test_total_outage_fails_with_error_annotation(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = provider_outage_exit_code(
                self._m(
                    provider_circuit_open=True,
                    errors=["all_providers_unavailable:gemini HTTP 403"],
                    evaluations_paused=4,
                )
            )
        self.assertEqual(code, 1)
        self.assertIn("::error", buf.getvalue())
        self.assertIn("all_providers_unavailable", buf.getvalue())

    def test_partial_outage_warns_but_passes(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = provider_outage_exit_code(
                self._m(provider_circuit_open=True, evaluations_paused=2, candidates_evaluated=3)
            )
        self.assertEqual(code, 0)
        self.assertIn("::warning", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
