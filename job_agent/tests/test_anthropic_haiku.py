"""Offline Haiku transport, fail-closed budget and workflow contract tests."""

import asyncio
import hashlib
import json
import os
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import httpx

from job_agent.auto_discovery.evaluate.anthropic import (
    AnthropicHaikuProvider, HaikuBudgetError, RemoteHaikuBudget,
    HAIKU_MODEL, HAIKU_MAX_REQUEST_BYTES, HAIKU_MAX_OUTPUT_TOKENS,
)
from job_agent.auto_discovery.evaluate.providers import (
    AllProvidersUnavailableError, FallbackEvaluationProvider,
    InvalidModelOutputError, ProviderAuthError, QuotaExhaustedError,
    TransientProviderError, configured_providers,
)
from job_agent.auto_discovery.types import AdapterError

NOW = datetime(2026, 11, 11, 12, tzinfo=timezone.utc).timestamp()
INPUT = {"system": "Evaluate one job. Return JSON only.", "user": "Public job description", "schema": {"type": "object"}}


def claim(**overrides):
    return {
        "allowed": True, "policy_version": "haiku-5-5-v1", "model": HAIKU_MODEL,
        "max_request_bytes": 16000, "max_output_tokens": 2048,
        "reserved_micro_usd": 5000, "server_time": "2026-11-11T12:00:00Z",
        "dispatch_before": "2026-11-11T12:00:05Z", **overrides,
    }


def success():
    return httpx.Response(200, json={
        "stop_reason": "end_turn", "content": [{"type": "text", "text": '{"score": 70}'}],
    })


class HaikuTransportTests(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"HAIKU_PAID_EXECUTION_APPROVED": "true"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.calls = []
        self.budget = mock.Mock()
        self.budget.claim.return_value = claim()

    def provider(self, response=None):
        def handler(request):
            self.calls.append(request)
            if isinstance(response, Exception):
                raise response
            return response if response is not None else success()
        return AnthropicHaikuProvider(
            "fake-test-key", transport=httpx.MockTransport(handler),
            budget=self.budget, clock=lambda: NOW,
        )

    def test_messages_request_is_pinned_bounded_and_digest_bound(self):
        result = self.provider().complete_json(**INPUT)
        self.assertEqual(result, {"score": 70})
        self.assertEqual(len(self.calls), 1)
        request = self.calls[0]
        self.assertEqual(str(request.url), "https://api.anthropic.com/v1/messages")
        self.assertEqual(request.headers["x-api-key"], "fake-test-key")
        self.assertEqual(request.headers["anthropic-version"], "2023-06-01")
        payload = json.loads(request.content)
        self.assertEqual(payload["model"], HAIKU_MODEL)
        self.assertEqual(payload["max_tokens"], HAIKU_MAX_OUTPUT_TOKENS)
        self.assertNotIn("temperature", payload)
        self.assertNotIn("top_p", payload)
        self.assertNotIn("top_k", payload)
        self.assertEqual(payload["output_config"], {"effort": "low"})
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertLessEqual(len(request.content), HAIKU_MAX_REQUEST_BYTES)
        self.assertEqual(len(payload["messages"]), 1)
        self.budget.claim.assert_called_once_with(hashlib.sha256(request.content).hexdigest())

    def test_key_and_paid_override_cannot_bypass_approval(self):
        os.environ.pop("HAIKU_PAID_EXECUTION_APPROVED")
        os.environ["AUTO_DISCOVERY_ALLOW_PAID_PROVIDERS"] = "true"
        with self.assertRaises(HaikuBudgetError):
            self.provider().complete_json(**INPUT)
        self.budget.claim.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_wrong_model_cannot_bypass_budget_policy(self):
        with self.assertRaises(ValueError):
            AnthropicHaikuProvider("fake", model="claude-sonnet-4-5")

    def test_oversized_multibyte_request_is_deferred_before_reserving(self):
        with self.assertRaises(TransientProviderError):
            self.provider().complete_json(**dict(INPUT, user="🌎" * 5000))
        self.budget.claim.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_budget_denied_never_calls_provider(self):
        self.budget.claim.side_effect = HaikuBudgetError("daily_limit")
        with self.assertRaises(HaikuBudgetError):
            self.provider().complete_json(**INPUT)
        self.assertEqual(self.calls, [])

    def test_malformed_stale_or_changed_claim_never_dispatches(self):
        for value in [None, {}, claim(allowed=False), claim(model="other"),
                      claim(max_request_bytes=32000), claim(max_output_tokens=4096),
                      claim(reserved_micro_usd=1), claim(policy_version="other"),
                      claim(server_time="2026-11-11T11:59:50Z"),
                      claim(server_time="2026-11-11T12:00:10Z"),
                      claim(dispatch_before="2026-11-11T12:00:01Z"),
                      claim(dispatch_before="2026-11-11T12:00:10Z"),
                      claim(server_time="2026-11-11T12:00:00")]:
            with self.subTest(value=value):
                self.budget.claim.return_value = value
                with self.assertRaises(HaikuBudgetError):
                    self.provider().complete_json(**INPUT)
                self.assertEqual(self.calls, [])

    def test_timeout_does_not_retry_or_refund_and_next_call_has_fresh_claim(self):
        provider = self.provider(httpx.ReadTimeout("private payload must not be logged"))
        for _ in range(2):
            with self.assertRaisesRegex(TransientProviderError, "anthropic transport: ReadTimeout"):
                provider.complete_json(**INPUT)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.budget.claim.call_count, 2)

    def test_http_failures_are_classified_without_body_or_key_leak(self):
        for status, error in [(401, ProviderAuthError), (403, ProviderAuthError),
                              (429, QuotaExhaustedError), (500, TransientProviderError),
                              (529, TransientProviderError), (302, TransientProviderError),
                              (400, TransientProviderError), (413, TransientProviderError)]:
            with self.subTest(status=status):
                provider = self.provider(httpx.Response(status, text="fake-test-key private data", headers={"Location": "https://example.org"}))
                with self.assertRaises(error) as caught:
                    provider.complete_json(**INPUT)
                self.assertNotIn("private", str(caught.exception))
                self.assertNotIn("fake-test-key", str(caught.exception))
        self.assertEqual(len(self.calls), 8)

    def test_incomplete_malformed_and_non_text_outputs_fail_closed(self):
        bodies = [
            {"stop_reason": "max_tokens", "content": [{"type": "text", "text": "{}"}]},
            {"stop_reason": "end_turn", "content": [{"type": "tool_use"}]},
            {"stop_reason": "end_turn", "content": []},
            {"stop_reason": "end_turn", "content": [{"type": "text", "text": "not JSON"}]},
            {"stop_reason": "end_turn", "content": [{"type": "text", "text": "[]"}]},
            [],
            {"stop_reason": "refusal", "content": [{"type": "text", "text": "{}"}]},
            {"stop_reason": "end_turn", "content": [{"type": "thinking", "thinking": ""}]},
        ]
        for body in bodies:
            with self.subTest(body=body), self.assertRaises(InvalidModelOutputError):
                self.provider(httpx.Response(200, json=body)).complete_json(**INPUT)

    def test_only_answer_text_is_parsed_if_thinking_blocks_are_returned(self):
        response = httpx.Response(200, json={
            "stop_reason": "end_turn", "content": [
                {"type": "thinking", "thinking": "", "signature": "synthetic"},
                {"type": "text", "text": '{"score":70}'},
            ],
        })
        self.assertEqual(self.provider(response).complete_json(**INPUT), {"score": 70})

    def test_budget_failure_benches_once_and_preserves_outage_semantics(self):
        self.budget.claim.side_effect = HaikuBudgetError("daily_limit")
        chain = FallbackEvaluationProvider([self.provider()])
        for _ in range(2):
            with self.assertRaises(AllProvidersUnavailableError):
                chain.complete_json(**INPUT)
        self.budget.claim.assert_called_once()
        self.assertEqual(self.calls, [])


class RemoteBudgetTests(unittest.TestCase):
    def test_reserve_then_claim_binds_same_payload(self):
        client = mock.Mock()
        client.call_tool_sync.side_effect = [{"allowed": True, "reservation_id": "r-1"}, claim()]
        self.assertEqual(RemoteHaikuBudget(client).claim("a" * 64), claim())
        self.assertEqual(client.call_tool_sync.call_args_list, [
            mock.call("reserve_haiku_attempt", {"request_sha256": "a" * 64}),
            mock.call("claim_haiku_attempt", {"reservation_id": "r-1", "request_sha256": "a" * 64}),
        ])

    def test_denied_or_uncertain_reservation_is_not_retried(self):
        for result in [None, {}, {"allowed": "true"}, {"allowed": True},
                       {"allowed": False, "reason": "daily_limit"}, RuntimeError("secret")]:
            client = mock.Mock()
            if isinstance(result, Exception):
                client.call_tool_sync.side_effect = result
            else:
                client.call_tool_sync.return_value = result
            with self.subTest(result=result), self.assertRaises(HaikuBudgetError) as caught:
                RemoteHaikuBudget(client).claim("a" * 64)
            self.assertNotIn("secret", str(caught.exception))
            self.assertEqual(client.call_tool_sync.call_count, 1)

    def test_sync_budget_client_works_inside_pipeline_event_loop(self):
        class Client:
            def call_tool_sync(self, name, arguments):
                async def call():
                    return {"allowed": True, "reservation_id": "r-1"} if name.startswith("reserve") else claim()
                return asyncio.run(call())
        async def pipeline():
            self.assertEqual(RemoteHaikuBudget(Client()).claim("a" * 64), claim())
        asyncio.run(pipeline())


class HaikuConfigurationTests(unittest.TestCase):
    def test_secret_or_generic_paid_flag_alone_does_not_enable_haiku(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fake", "AUTO_DISCOVERY_ALLOW_PAID_PROVIDERS": "true"}, clear=True):
            self.assertEqual(configured_providers(), [])

    def test_explicit_haiku_override_requires_gate(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fake", "AUTO_DISCOVERY_LLM_PROVIDER": "haiku"}, clear=True):
            with self.assertRaises(AdapterError):
                configured_providers()

    def test_approved_haiku_is_pinned_and_preferred(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fake", "GEMINI_API_KEY": "fake", "HAIKU_PAID_EXECUTION_APPROVED": "true"}, clear=True):
            providers = configured_providers()
            self.assertEqual([p.name for p in providers], ["anthropic", "gemini"])
            self.assertEqual(providers[0].model, HAIKU_MODEL)

    def test_non_haiku_model_override_is_rejected(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fake", "HAIKU_PAID_EXECUTION_APPROVED": "true", "ANTHROPIC_MODEL": "claude-opus"}, clear=True):
            with self.assertRaises(AdapterError):
                configured_providers()

    def test_manual_workflow_is_pinned_and_default_disabled(self):
        text = (Path(__file__).resolve().parents[2] / ".github/workflows/haiku-job-discovery.yml").read_text()
        self.assertIn("workflow_dispatch:", text)
        self.assertNotRegex(text, r"(?m)^\s*schedule:")
        self.assertIn("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}", text)
        self.assertIn(f"ANTHROPIC_MODEL: {HAIKU_MODEL}", text)
        self.assertIn("AUTO_DISCOVERY_LLM_PROVIDER: anthropic", text)
        self.assertIn("vars.HAIKU_PAID_EXECUTION_APPROVED || 'false'", text)
        self.assertIn("group: automatic-job-discovery", text)
        self.assertNotIn("echo ${{ secrets", text)


class HaikuPendingQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_daily_limit_preserves_pending_and_new_candidates(self):
        from job_agent.auto_discovery.pipeline import AutomaticDiscoveryPipeline
        from job_agent.tests.test_auto_discovery_provider_outage import OutageStore, limits
        from job_agent.tests.test_auto_discovery_ranking import CountingAdapter, listings

        store = OutageStore()
        provider = mock.Mock(name="anthropic")
        provider.name = "anthropic"
        provider.complete_json.side_effect = HaikuBudgetError("daily_limit")
        with mock.patch("job_agent.auto_discovery.pipeline.get_adapter", return_value=CountingAdapter(listings(10))):
            metrics = await AutomaticDiscoveryPipeline(
                store, provider=FallbackEvaluationProvider([provider]), limits=limits(),
            ).run()
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.candidates_rejected, 0)
        self.assertEqual(metrics.candidates_queued, 3)
        self.assertEqual(metrics.pending_paused, 1)
        self.assertTrue(metrics.provider_circuit_open)
        provider.complete_json.assert_called_once()
        names = [name for name, _ in store.calls]
        self.assertIn("preserve_pending_discovery_evaluations", names)
        self.assertNotIn("record_discovery_evaluations", names)
        self.assertNotIn("complete_pending_discovery_evaluation", names)


if __name__ == "__main__":
    unittest.main()
