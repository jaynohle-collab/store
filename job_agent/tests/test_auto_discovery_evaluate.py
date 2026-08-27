"""Network-isolated gpt-fit-v2 evaluation tests (Milestone 5)."""

from __future__ import annotations

import json
import unittest
from typing import Any

import httpx

from job_agent.auto_discovery.evaluate.gpt_fit_v2 import (
    GPT_FIT_V2_JSON_SCHEMA,
    InvalidModelOutputError,
    build_evaluation_record,
    evaluate_candidate,
    validate_model_output,
)
from job_agent.auto_discovery.evaluate.providers import (
    OpenAIProvider,
    QuotaExhaustedError,
)
from job_agent.auto_discovery.types import LightweightCandidate


def _cand() -> LightweightCandidate:
    return LightweightCandidate(
        client_candidate_id="c1",
        company="Acme",
        title="Staff AI Engineer",
        url="https://boards.greenhouse.io/acme/jobs/1",
        source="greenhouse",
        external_job_id="1",
        location="Remote US",
    )


class FakeProvider:
    name = "fake"

    def __init__(self, payload: dict[str, Any] | Exception):
        self.payload = payload
        self.calls = 0

    def complete_json(self, *, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        if isinstance(self.payload, Exception):
            raise self.payload
        return dict(self.payload)


class GptFitV2Tests(unittest.TestCase):
    def test_schema_construction(self):
        self.assertEqual(GPT_FIT_V2_JSON_SCHEMA["type"], "object")
        required = set(GPT_FIT_V2_JSON_SCHEMA["required"])
        self.assertIn("gpt_relevance_score", required)
        self.assertIn("remote_scope", required)
        self.assertIn("direct_posting_url_verified", required)
        self.assertIn("posting_status", required)

    def test_invalid_llm_json_fails_closed(self):
        provider = FakeProvider(InvalidModelOutputError("bad"))
        # evaluate_candidate wraps non-quota errors as InvalidModelOutputError
        with self.assertRaises(InvalidModelOutputError):
            evaluate_candidate(provider, _cand(), "Build agents.")  # type: ignore[arg-type]

        provider2 = FakeProvider({"gpt_decision": "QUALIFIED"})  # missing fields
        with self.assertRaises(InvalidModelOutputError):
            evaluate_candidate(provider2, _cand(), "Build agents.")  # type: ignore[arg-type]

    def test_quota_error_classified(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                429,
                json={"error": {"message": "insufficient_quota"}},
            )

        provider = OpenAIProvider(
            "sk-test",
            transport=httpx.MockTransport(handler),
        )
        with self.assertRaises(QuotaExhaustedError):
            provider.complete_json(
                system="s",
                user="u",
                schema=GPT_FIT_V2_JSON_SCHEMA,
            )

    def test_match_score_zero_edge(self):
        with self.assertRaises(InvalidModelOutputError):
            validate_model_output(
                {
                    "gpt_relevance_score": 0,
                    "gpt_decision": "QUALIFIED",
                    "reasoning_summary": "no",
                    "remote_scope": "US_NATIONWIDE",
                    "direct_posting_url_verified": True,
                    "posting_status": "OPEN",
                    "hard_rejection_reason": None,
                }
            )

        fields = validate_model_output(
            {
                "gpt_relevance_score": 0,
                "gpt_decision": "REJECTED_LOW_SCORE",
                "reasoning_summary": "not a fit",
                "remote_scope": "US_NATIONWIDE",
                "direct_posting_url_verified": True,
                "posting_status": "OPEN",
                "hard_rejection_reason": None,
            }
        )
        self.assertEqual(fields["gpt_relevance_score"], 0)
        record = build_evaluation_record(
            _cand(),
            description="Build production LLM agents and platforms.",
            model_fields=fields,
        )
        self.assertEqual(record["gpt_decision"], "REJECTED_LOW_SCORE")
        self.assertEqual(record["evaluation_version"], "gpt-fit-v2")
        self.assertTrue(record["description_hash"])


if __name__ == "__main__":
    unittest.main()
