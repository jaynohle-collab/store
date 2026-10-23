"""Groq retired-model recovery: 404 model_not_found -> pick a live model once."""

from __future__ import annotations

import json
import unittest

import httpx

from job_agent.auto_discovery.evaluate.providers import (
    GroqProvider,
    TransientProviderError,
    pick_groq_chat_model,
)

OK = {"choices": [{"message": {"content": json.dumps({"ok": True})}}]}
NOT_FOUND = {"error": {"code": "model_not_found", "message": "The model does not exist"}}


def _transport(models: list[str], live: set[str], calls: list[tuple[str, str]]):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            calls.append(("GET", "/models"))
            return httpx.Response(200, json={"data": [{"id": m, "active": True} for m in models]})
        model = json.loads(request.content)["model"]
        calls.append(("POST", model))
        if model in live:
            return httpx.Response(200, json=OK)
        return httpx.Response(404, json=NOT_FOUND)

    return httpx.MockTransport(handler)


class GroqModelDiscoveryTests(unittest.TestCase):
    def test_retired_default_switches_to_live_model(self):
        calls: list[tuple[str, str]] = []
        models = ["whisper-large-v3", "openai/gpt-oss-120b", "llama-3.1-8b-instant"]
        provider = GroqProvider(
            "k", model="llama-3.3-70b-versatile",
            transport=_transport(models, {"openai/gpt-oss-120b"}, calls),
        )
        out = provider.complete_json(system="s", user="u", schema={})
        self.assertEqual(out, {"ok": True})
        self.assertEqual(provider.model, "openai/gpt-oss-120b")
        self.assertEqual(
            calls,
            [("POST", "llama-3.3-70b-versatile"), ("GET", "/models"), ("POST", "openai/gpt-oss-120b")],
        )
        # Later calls use the new model directly, no second lookup.
        provider.complete_json(system="s", user="u", schema={})
        self.assertEqual(calls[-1], ("POST", "openai/gpt-oss-120b"))
        self.assertEqual(sum(1 for c in calls if c[0] == "GET"), 1)

    def test_no_usable_model_raises_transient_for_fallback(self):
        calls: list[tuple[str, str]] = []
        provider = GroqProvider("k", transport=_transport(["whisper-large-v3"], set(), calls))
        with self.assertRaises(TransientProviderError):
            provider.complete_json(system="s", user="u", schema={})

    def test_picker_skips_non_chat_and_prefers_known_models(self):
        self.assertEqual(
            pick_groq_chat_model(["whisper-large-v3", "llama-guard-4-12b", "qwen/qwen3-32b"]),
            "qwen/qwen3-32b",
        )
        self.assertEqual(pick_groq_chat_model(["new-llama-5-90b", "new-llama-5-8b"]), "new-llama-5-90b")
        self.assertIsNone(pick_groq_chat_model(["whisper-large-v3"]))
        self.assertIsNone(pick_groq_chat_model(["llama-3.3-70b-versatile"], exclude="llama-3.3-70b-versatile"))


if __name__ == "__main__":
    unittest.main()
