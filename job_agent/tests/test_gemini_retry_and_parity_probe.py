"""Gemini bounded retry, sanitized diagnostics, and production-parity probe stages."""

from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout
from typing import Any

import httpx

from job_agent.auto_discovery.evaluate.gpt_fit_v2 import (
    GPT_FIT_V2_JSON_SCHEMA,
    SYSTEM_PROMPT,
    build_user_prompt,
)
from job_agent.auto_discovery.evaluate.providers import (
    AllProvidersUnavailableError,
    EvaluationProvider,
    FallbackEvaluationProvider,
    GeminiProvider,
    QuotaExhaustedError,
    TransientProviderError,
    parse_provider_error,
    parse_retry_after,
    sanitize_error_text,
)
from job_agent.auto_discovery.types import AdapterError
from job_agent.examples import gemini_api_probe as probe

API_KEY = "AIzaSyTestKeyMustNeverAppear0123456789"

VALID_V2 = {
    "gpt_relevance_score": 50,
    "gpt_decision": "REJECTED_LOW_SCORE",
    "reasoning_summary": "fixture",
    "remote_scope": "US_NATIONWIDE",
    "direct_posting_url_verified": True,
    "posting_status": "OPEN",
    "hard_rejection_reason": None,
}


def _gemini_ok(payload: dict[str, Any]) -> httpx.Response:
    return httpx.Response(
        200,
        json={"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}]},
    )


def _google_error(status: int, google_status: str, message: str, **kw) -> httpx.Response:
    return httpx.Response(
        status,
        json={"error": {"code": status, "status": google_status, "message": message}},
        **kw,
    )


UNAVAILABLE_MSG = "This model is currently experiencing high demand. Please try again later."


class _Recorder:
    """httpx MockTransport handler returning scripted responses in order."""

    def __init__(self, responses: list[httpx.Response]):
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("unexpected extra Gemini request")
        return self.responses.pop(0)


def _gemini(recorder: _Recorder, sleeps: list[float], **kw) -> GeminiProvider:
    return GeminiProvider(
        API_KEY,
        model="gemini-3.6-flash",
        transport=httpx.MockTransport(recorder),
        sleep=sleeps.append,
        rng=lambda: 0.0,
        **kw,
    )


def _call(provider: EvaluationProvider, description: str = "desc") -> dict[str, Any]:
    return provider.complete_json(
        system=SYSTEM_PROMPT,
        user=build_user_prompt(probe.fixture_candidate(), description),
        schema=GPT_FIT_V2_JSON_SCHEMA,
    )


class _StaticProvider(EvaluationProvider):
    def __init__(self, name: str, outcome: Any):
        self.name = name
        self.outcome = outcome
        self.calls = 0

    def complete_json(self, *, system, user, schema):  # noqa: ARG002
        self.calls += 1
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class GeminiRetryTests(unittest.TestCase):
    def test_503_then_success_retries_once_with_backoff(self) -> None:
        rec = _Recorder([_google_error(503, "UNAVAILABLE", UNAVAILABLE_MSG), _gemini_ok(VALID_V2)])
        sleeps: list[float] = []
        provider = _gemini(rec, sleeps)
        self.assertEqual(_call(provider), VALID_V2)
        self.assertEqual(len(rec.requests), 2)
        self.assertEqual(sleeps, [1.0])
        self.assertEqual([a["http_status"] for a in provider.last_attempts], [503, 200])
        self.assertEqual(provider.last_attempts[0]["error_status"], "UNAVAILABLE")

    def test_repeated_503_is_bounded_to_three_attempts(self) -> None:
        rec = _Recorder([_google_error(503, "UNAVAILABLE", UNAVAILABLE_MSG) for _ in range(3)])
        sleeps: list[float] = []
        provider = _gemini(rec, sleeps)
        with self.assertRaises(TransientProviderError) as ctx:
            _call(provider)
        self.assertNotIsInstance(ctx.exception, QuotaExhaustedError)
        self.assertEqual(len(rec.requests), 3)
        self.assertEqual(sleeps, [1.0, 2.0])
        msg = str(ctx.exception)
        self.assertIn("gemini HTTP 503 UNAVAILABLE", msg)
        self.assertIn("high demand", msg)
        self.assertIn("attempts=3", msg)
        self.assertEqual(ctx.exception.status_code, 503)

    def test_max_attempts_is_capped_at_three(self) -> None:
        rec = _Recorder([_google_error(500, "INTERNAL", "boom") for _ in range(3)])
        provider = _gemini(rec, [], max_attempts=10)
        with self.assertRaises(TransientProviderError):
            _call(provider)
        self.assertEqual(len(rec.requests), 3)

    def test_each_retryable_5xx_status_is_retried(self) -> None:
        for status in (500, 502, 503, 504):
            with self.subTest(status=status):
                rec = _Recorder([_google_error(status, "X", "m"), _gemini_ok(VALID_V2)])
                sleeps: list[float] = []
                self.assertEqual(_call(_gemini(rec, sleeps)), VALID_V2)
                self.assertEqual(len(sleeps), 1)

    def test_jitter_stays_within_bounds(self) -> None:
        rec = _Recorder([_google_error(503, "UNAVAILABLE", "m") for _ in range(3)])
        sleeps: list[float] = []
        provider = GeminiProvider(
            API_KEY,
            model="gemini-3.6-flash",
            transport=httpx.MockTransport(rec),
            sleep=sleeps.append,
            rng=lambda: 0.999,
        )
        with self.assertRaises(TransientProviderError):
            _call(provider)
        self.assertTrue(1.0 <= sleeps[0] < 2.0)
        self.assertTrue(2.0 <= sleeps[1] < 4.0)

    def test_retry_after_seconds_is_honored_and_capped(self) -> None:
        rec = _Recorder(
            [
                _google_error(503, "UNAVAILABLE", "m", headers={"Retry-After": "5"}),
                _google_error(503, "UNAVAILABLE", "m", headers={"Retry-After": "999"}),
                _gemini_ok(VALID_V2),
            ]
        )
        sleeps: list[float] = []
        self.assertEqual(_call(_gemini(rec, sleeps)), VALID_V2)
        self.assertEqual(sleeps, [5.0, 30.0])

    def test_parse_retry_after_http_date_and_garbage(self) -> None:
        self.assertEqual(
            parse_retry_after("Wed, 21 Oct 2015 07:28:10 GMT", now=1445412480.0), 10.0
        )
        self.assertEqual(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now=1445412490.0), 0.0)
        self.assertIsNone(parse_retry_after("soon"))
        self.assertIsNone(parse_retry_after(None))

    def test_validation_and_auth_errors_are_not_retried(self) -> None:
        for status, google_status in (
            (400, "INVALID_ARGUMENT"),
            (401, "UNAUTHENTICATED"),
            (403, "PERMISSION_DENIED"),
        ):
            with self.subTest(status=status):
                rec = _Recorder([_google_error(status, google_status, "bad request")])
                sleeps: list[float] = []
                with self.assertRaises(AdapterError) as ctx:
                    _call(_gemini(rec, sleeps))
                self.assertEqual(len(rec.requests), 1)
                self.assertEqual(sleeps, [])
                self.assertIn(google_status, str(ctx.exception))

    def test_quota_errors_are_not_retried(self) -> None:
        cases = (
            _google_error(429, "RESOURCE_EXHAUSTED", "rate limited"),
            _google_error(503, "UNAVAILABLE", "quota exceeded for project"),
        )
        for response in cases:
            with self.subTest(status=response.status_code):
                rec = _Recorder([response])
                sleeps: list[float] = []
                with self.assertRaises(QuotaExhaustedError):
                    _call(_gemini(rec, sleeps))
                self.assertEqual(len(rec.requests), 1)
                self.assertEqual(sleeps, [])

    def test_404_is_transient_without_retry(self) -> None:
        rec = _Recorder([_google_error(404, "NOT_FOUND", "model missing")])
        sleeps: list[float] = []
        with self.assertRaises(TransientProviderError):
            _call(_gemini(rec, sleeps))
        self.assertEqual(len(rec.requests), 1)
        self.assertEqual(sleeps, [])

    def test_transport_error_is_not_retried(self) -> None:
        calls: list[int] = []

        def boom(request: httpx.Request) -> httpx.Response:
            calls.append(1)
            raise httpx.ReadTimeout("slow", request=request)

        provider = GeminiProvider(
            API_KEY, model="gemini-3.6-flash", transport=httpx.MockTransport(boom), sleep=lambda s: None
        )
        with self.assertRaises(TransientProviderError) as ctx:
            _call(provider)
        self.assertEqual(calls, [1])
        self.assertIn("ReadTimeout", str(ctx.exception))

    def test_structured_output_request_shape_is_unchanged(self) -> None:
        rec = _Recorder([_gemini_ok(VALID_V2)])
        _call(_gemini(rec, []))
        req = rec.requests[0]
        body = json.loads(req.content)
        self.assertEqual(req.headers["x-goog-api-key"], API_KEY)
        self.assertNotIn(API_KEY, str(req.url))
        self.assertEqual(body["systemInstruction"]["parts"][0]["text"], SYSTEM_PROMPT)
        self.assertEqual(body["generationConfig"]["responseMimeType"], "application/json")
        self.assertEqual(body["generationConfig"]["temperature"], 0)
        text = body["contents"][0]["parts"][0]["text"]
        self.assertTrue(text.endswith("\n\nJSON schema:\n" + json.dumps(GPT_FIT_V2_JSON_SCHEMA)))

    def test_request_size_diagnostics(self) -> None:
        small = _Recorder([_gemini_ok(VALID_V2)])
        large = _Recorder([_gemini_ok(VALID_V2)])
        p_small = _gemini(small, [])
        p_large = _gemini(large, [])
        _call(p_small, "x" * 1000)
        _call(p_large, "x" * 80000)
        self.assertEqual(p_small.last_attempts[0]["request_bytes"], len(small.requests[0].content))
        self.assertEqual(p_large.last_attempts[0]["request_bytes"], len(large.requests[0].content))
        self.assertGreater(
            p_large.last_attempts[0]["request_bytes"],
            p_small.last_attempts[0]["request_bytes"] + 78000,
        )


class ProviderFallbackCompatibilityTests(unittest.TestCase):
    def test_repeated_503_falls_back_to_next_provider(self) -> None:
        rec = _Recorder([_google_error(503, "UNAVAILABLE", UNAVAILABLE_MSG) for _ in range(3)])
        sleeps: list[float] = []
        openai = _StaticProvider("openai", VALID_V2)
        chain = FallbackEvaluationProvider([_gemini(rec, sleeps), openai])
        self.assertEqual(_call(chain), VALID_V2)
        self.assertEqual(len(rec.requests), 3)
        self.assertEqual(openai.calls, 1)
        self.assertEqual(chain.name, "openai")

    def test_all_down_error_carries_sanitized_google_status(self) -> None:
        rec = _Recorder([_google_error(503, "UNAVAILABLE", UNAVAILABLE_MSG) for _ in range(3)])
        openai = _StaticProvider("openai", QuotaExhaustedError("openai HTTP 429"))
        chain = FallbackEvaluationProvider([_gemini(rec, []), openai])
        with self.assertLogs("job_agent.auto_discovery.evaluate.providers", "WARNING") as logs:
            with self.assertRaises(AllProvidersUnavailableError) as ctx:
                _call(chain)
        msg = str(ctx.exception)
        self.assertIn("gemini:gemini HTTP 503 UNAVAILABLE", msg)
        self.assertIn("attempts=3", msg)
        self.assertIn("openai:openai HTTP 429", msg)
        joined = "\n".join(logs.output)
        self.assertIn("error_status=UNAVAILABLE", joined)
        self.assertNotIn(API_KEY, joined + msg)
        self.assertNotIn(SYSTEM_PROMPT[:40], joined + msg)


class SanitizationTests(unittest.TestCase):
    def test_google_error_secrets_are_redacted(self) -> None:
        body = json.dumps(
            {
                "error": {
                    "status": "INVALID_ARGUMENT",
                    "message": (
                        f"bad key {API_KEY} Authorization: Bearer abc.def "
                        "api_key=zzz sk-proj-1234567890abcdef org-AbCdEf123456"
                    ),
                }
            }
        )
        status, message = parse_provider_error(body)
        self.assertEqual(status, "INVALID_ARGUMENT")
        for secret in (API_KEY, "abc.def", "zzz", "sk-proj-1234567890abcdef", "org-AbCdEf123456"):
            self.assertNotIn(secret, message)
        self.assertIn("[redacted]", message)

    def test_non_json_body_is_never_echoed(self) -> None:
        body = "<html>proxy error echoing UNTRUSTED_JOB_DESCRIPTION_BEGIN secret prompt</html>"
        self.assertEqual(parse_provider_error(body), ("unknown", "unparseable_error"))
        rec = _Recorder([httpx.Response(503, text=body) for _ in range(3)])
        with self.assertRaises(TransientProviderError) as ctx:
            _call(_gemini(rec, []))
        self.assertEqual(str(ctx.exception), "gemini HTTP 503 (attempts=3)")

    def test_error_message_is_bounded(self) -> None:
        body = json.dumps({"error": {"status": "UNAVAILABLE", "message": "x" * 5000}})
        _status, message = parse_provider_error(body)
        self.assertLessEqual(len(message), 160)
        self.assertLessEqual(len(sanitize_error_text("y" * 999)), 160)


def _list_body() -> str:
    return json.dumps(
        {
            "models": [
                {"name": "models/gemini-3.6-flash", "supportedGenerationMethods": ["generateContent"]}
            ]
        }
    )


def _text_body(text: str) -> str:
    return json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}}]})


class ParityProbeTests(unittest.TestCase):
    def _run(self, *, structured_ok: bool = True, gemini_handler=None, sizes=(6000,)):
        raw_posts: list[dict] = []

        def request_fn(method, url, payload=None):
            if method == "GET":
                return 200, _list_body()
            raw_posts.append(payload or {})
            if "generationConfig" in (payload or {}):
                return 200, _text_body('{"status": "ok"}' if structured_ok else "not json")
            return 200, _text_body("ok")

        realistic_requests: list[httpx.Request] = []

        def factory(key: str, model: str) -> GeminiProvider:
            def handler(request: httpx.Request) -> httpx.Response:
                realistic_requests.append(request)
                return gemini_handler(request)

            return GeminiProvider(
                key,
                model=model,
                transport=httpx.MockTransport(handler),
                sleep=lambda s: None,
                rng=lambda: 0.0,
            )

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = probe.run_parity_probe(
                api_key=API_KEY,
                request_fn=request_fn,
                provider_factory=factory,
                description_sizes=sizes,
            )
        return code, buf.getvalue(), raw_posts, realistic_requests

    def _assert_safe(self, output: str) -> None:
        self.assertNotIn(API_KEY, output)
        self.assertNotIn("x-goog-api-key", output)
        self.assertNotIn(SYSTEM_PROMPT[:40], output)
        self.assertNotIn("Probe Fixture Co is hiring", output)
        self.assertNotIn("UNTRUSTED_JOB_DESCRIPTION", output)
        self.assertNotIn("gpt_relevance_score", output)
        self.assertNotIn("Traceback", output)

    def test_minimal_ok_but_realistic_structured_request_fails(self) -> None:
        code, output, raw_posts, realistic = self._run(
            gemini_handler=lambda r: _google_error(503, "UNAVAILABLE", UNAVAILABLE_MSG)
        )
        self.assertEqual(code, 1)
        self.assertIn("stage=minimal model=gemini-3.6-flash attempt=1", output)
        self.assertIn("usable_text=yes", output)
        self.assertRegex(output, r"stage=structured_small .* http_status=200 ")
        for attempt in (1, 2, 3):
            self.assertRegex(
                output,
                rf"stage=realistic_gpt_fit_v2:6000 model=gemini-3\.6-flash attempt={attempt} "
                r"request_bytes=\d+ description_chars=6000 http_status=503 "
                r"google_status=UNAVAILABLE google_message=This model is currently",
            )
        self.assertIn("outcome=TransientProviderError attempts=3", output)
        self.assertIn(
            "parity_verdict=realistic_failed description_chars=6000 largest_ok_description_chars=0",
            output,
        )
        self.assertEqual(len(raw_posts), 2)
        self.assertEqual(len(realistic), 3)
        self._assert_safe(output)

    def test_realistic_stage_uses_production_prompt_schema_and_json_mode(self) -> None:
        code, output, _raw, realistic = self._run(gemini_handler=lambda r: _gemini_ok(VALID_V2))
        self.assertEqual(code, 0)
        body = json.loads(realistic[0].content)
        self.assertEqual(body["systemInstruction"]["parts"][0]["text"], SYSTEM_PROMPT)
        self.assertEqual(body["generationConfig"]["responseMimeType"], "application/json")
        text = body["contents"][0]["parts"][0]["text"]
        self.assertIn(json.dumps(GPT_FIT_V2_JSON_SCHEMA), text)
        self.assertIn(probe.fixture_description(6000), text)
        self.assertIn("parity_verdict=all_stages_ok largest_ok_description_chars=6000", output)
        self._assert_safe(output)

    def test_size_sweep_identifies_failure_threshold(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if len(request.content) > 50000:
                return _google_error(503, "UNAVAILABLE", UNAVAILABLE_MSG)
            return _gemini_ok(VALID_V2)

        code, output, _raw, _req = self._run(gemini_handler=handler, sizes=(2000, 20000, 80000))
        self.assertEqual(code, 1)
        sizes = [
            int(line.split("request_bytes=")[1].split()[0])
            for line in output.splitlines()
            if line.startswith("stage=realistic")
        ]
        self.assertEqual(len(sizes), 5)  # 1 + 1 + 3 attempts
        self.assertLess(sizes[0], sizes[1])
        self.assertLess(sizes[1], sizes[2])
        self.assertIn(
            "parity_verdict=realistic_failed description_chars=80000 "
            "largest_ok_description_chars=20000",
            output,
        )
        self._assert_safe(output)

    def test_invalid_gpt_fit_v2_output_fails_realistic_stage(self) -> None:
        bad = dict(VALID_V2, gpt_decision="QUALIFIED")  # score 50 → fails validation
        code, output, _raw, _req = self._run(gemini_handler=lambda r: _gemini_ok(bad))
        self.assertEqual(code, 1)
        self.assertIn("outcome=InvalidModelOutputError attempts=1", output)

    def test_structured_small_failure_stops_before_realistic(self) -> None:
        code, output, _raw, realistic = self._run(
            structured_ok=False, gemini_handler=lambda r: _gemini_ok(VALID_V2)
        )
        self.assertEqual(code, 1)
        self.assertIn("google_status=invalid_structured_output", output)
        self.assertIn("parity_verdict=structured_small_failed", output)
        self.assertEqual(realistic, [])

    def test_missing_key_reports_minimal_failure(self) -> None:
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = probe.run_parity_probe(api_key="  ")
        self.assertEqual(code, 1)
        self.assertIn("google_error_code=missing_secret", buf.getvalue())
        self.assertIn("parity_verdict=minimal_failed", buf.getvalue())

    def test_fixture_is_deterministic_and_exact_length(self) -> None:
        for size in (1, 6000, 80000, 120000):
            text = probe.fixture_description(size)
            self.assertEqual(len(text), min(size, 80000))
            self.assertEqual(text, probe.fixture_description(size))

    def test_parse_description_sizes(self) -> None:
        self.assertEqual(probe.parse_description_sizes("80000, 2000,abc,-5,200000"), (2000, 80000))
        self.assertEqual(probe.parse_description_sizes(""), (6000,))
        self.assertEqual(probe.parse_description_sizes(None), (6000,))

    def test_probe_source_never_touches_mcp_or_database(self) -> None:
        from pathlib import Path

        source = Path(probe.__file__).read_text(encoding="utf-8")
        for token in (
            "remote_mcp_client",
            "lifecycle_store",
            "DATABASE_URL",
            "record_discovery_evaluations",
            "submit_discovery_batch",
            "AUTH0",
        ):
            self.assertNotIn(token, source)


if __name__ == "__main__":
    unittest.main()
