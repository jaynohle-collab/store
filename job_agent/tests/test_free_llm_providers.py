"""Additional free OpenAI-compatible providers: wiring, order, safety."""

from __future__ import annotations

import json
import os
import unittest
from unittest import mock

import httpx

from job_agent.auto_discovery.evaluate.providers import (
    FallbackEvaluationProvider,
    OpenRouterProvider,
    ProviderAuthError,
    QuotaExhaustedError,
    SambaNovaProvider,
    configured_providers,
)
from job_agent.auto_discovery.types import AdapterError

ALL_KEYS = (
    "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "GITHUB_MODELS_TOKEN", "MISTRAL_API_KEY",
    "SAMBANOVA_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY",
    "AUTO_DISCOVERY_LLM_PROVIDER", "AUTO_DISCOVERY_PROVIDER_ORDER", "AUTO_DISCOVERY_ALLOW_PAID_PROVIDERS",
    "OPENROUTER_MODEL", "CEREBRAS_MODEL",
)
OK = {"choices": [{"message": {"content": json.dumps({"ok": True})}}]}


def env(**values: str):
    clean = {k: "" for k in ALL_KEYS}
    clean.update(values)
    return mock.patch.dict(os.environ, clean, clear=False)


class ProviderRegistryTests(unittest.TestCase):
    def test_default_order_and_paid_excluded(self):
        with env(GEMINI_API_KEY="g", GROQ_API_KEY="q", CEREBRAS_API_KEY="c", GITHUB_MODELS_TOKEN="t",
                 MISTRAL_API_KEY="m", SAMBANOVA_API_KEY="s", NVIDIA_API_KEY="n", OPENROUTER_API_KEY="o",
                 OPENAI_API_KEY="p"):
            names = [p.name for p in configured_providers()]
        self.assertEqual(
            names,
            ["gemini", "groq", "cerebras", "github_models", "mistral", "sambanova", "nvidia", "openrouter"],
        )

    def test_custom_order_puts_listed_first(self):
        with env(GEMINI_API_KEY="g", GROQ_API_KEY="q", CEREBRAS_API_KEY="c",
                 AUTO_DISCOVERY_PROVIDER_ORDER="cerebras, groq"):
            self.assertEqual([p.name for p in configured_providers()], ["cerebras", "groq", "gemini"])

    def test_model_env_overrides_default(self):
        with env(CEREBRAS_API_KEY="c", CEREBRAS_MODEL="qwen-3-32b"):
            self.assertEqual(configured_providers()[0].model, "qwen-3-32b")

    def test_openrouter_rejects_paid_model(self):
        with env(OPENROUTER_API_KEY="o", OPENROUTER_MODEL="openai/gpt-5"), self.assertRaises(AdapterError):
            configured_providers()


class OpenAICompatibleRequestTests(unittest.TestCase):
    def test_json_mode_off_for_sambanova(self):
        seen: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(json.loads(request.content))
            assert str(request.url) == "https://api.sambanova.ai/v1/chat/completions"
            return httpx.Response(200, json=OK)

        p = SambaNovaProvider("k", transport=httpx.MockTransport(handler))
        self.assertEqual(p.complete_json(system="s", user="u", schema={}), {"ok": True})
        self.assertNotIn("response_format", seen[0])

    def test_openrouter_rediscovery_only_picks_free_models(self):
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "GET":
                return httpx.Response(200, json={"data": [
                    {"id": "openai/gpt-5"}, {"id": "qwen/qwen3-32b:free"}]})
            model = json.loads(request.content)["model"]
            calls.append(model)
            return httpx.Response(200 if model.endswith(":free") and model != OpenRouterProvider.default_model else 404,
                                  json=OK if model == "qwen/qwen3-32b:free" else {"error": {"message": "gone"}})

        p = OpenRouterProvider("k", transport=httpx.MockTransport(handler))
        p.complete_json(system="s", user="u", schema={})
        self.assertEqual(p.model, "qwen/qwen3-32b:free")
        self.assertNotIn("openai/gpt-5", calls)


class _Stub:
    def __init__(self, name, errors):
        self.name = name
        self.errors = list(errors)
        self.calls = 0

    def complete_json(self, **_):
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return {"ok": self.name}


class FallbackBenchTests(unittest.TestCase):
    def test_auth_error_benches_immediately(self):
        dead = _Stub("dead", [ProviderAuthError("403")] * 5)
        live = _Stub("live", [])
        chain = FallbackEvaluationProvider([dead, live])  # type: ignore[list-item]
        for _ in range(4):
            chain.complete_json(system="s", user="u", schema={})
        self.assertEqual(dead.calls, 1)

    def test_quota_benches_after_three_strikes(self):
        tired = _Stub("tired", [QuotaExhaustedError("429")] * 10)
        live = _Stub("live", [])
        chain = FallbackEvaluationProvider([tired, live])  # type: ignore[list-item]
        for _ in range(6):
            chain.complete_json(system="s", user="u", schema={})
        self.assertEqual(tired.calls, 3)


if __name__ == "__main__":
    unittest.main()
