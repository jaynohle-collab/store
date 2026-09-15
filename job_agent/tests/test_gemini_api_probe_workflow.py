"""Static + unit checks for the Gemini API probe."""

from __future__ import annotations

import io
import json
import re
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock

from job_agent.examples import gemini_api_probe as probe


WORKFLOW_PATH = (
    Path(__file__).resolve().parents[2]
    / ".github"
    / "workflows"
    / "gemini-api-probe.yml"
)


def _flash_list_body(*names: str) -> str:
    return json.dumps(
        {
            "models": [
                {
                    "name": f"models/{name}",
                    "supportedGenerationMethods": ["generateContent"],
                }
                for name in names
            ]
        }
    )


def _not_found_body(model: str) -> str:
    return json.dumps(
        {
            "error": {
                "code": 404,
                "status": "NOT_FOUND",
                "message": (
                    f"This model models/{model} is no longer available to new users. "
                    "Please update your code to use models/gemini-3.6-flash."
                ),
            }
        }
    )


class GeminiApiProbeWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW_PATH.read_text(encoding="utf-8")

    def test_workflow_dispatch_only(self) -> None:
        self.assertIn("workflow_dispatch:", self.text)
        self.assertNotRegex(self.text, r"(?m)^\s*schedule:")
        self.assertNotRegex(self.text, r"(?m)^\s*push:")
        self.assertNotRegex(self.text, r"(?m)^\s*pull_request:")
        on_match = re.search(
            r"(?ms)^on:\s*\n(.*?)(?=^permissions:|^jobs:)",
            self.text,
        )
        self.assertIsNotNone(on_match)
        on_block = on_match.group(1)
        self.assertIn("workflow_dispatch:", on_block)
        self.assertNotIn("schedule:", on_block)
        self.assertNotIn("push:", on_block)
        self.assertNotIn("pull_request:", on_block)

    def test_permissions_are_contents_read(self) -> None:
        self.assertRegex(
            self.text,
            r"(?ms)^permissions:\s*\n\s*contents:\s*read\s*(?:\n|$)",
        )

    def test_secret_masking_and_no_provider_dump(self) -> None:
        self.assertIn("GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}", self.text)
        self.assertNotIn("echo ${{ secrets", self.text)
        self.assertNotIn("echo \"$GEMINI_API_KEY\"", self.text)
        self.assertNotIn("echo $GEMINI_API_KEY", self.text)
        self.assertNotIn("curl -v", self.text)
        self.assertNotIn("--verbose", self.text)
        self.assertNotIn("pprint(", self.text)
        self.assertIn("python -m job_agent.examples.gemini_api_probe", self.text)
        source = Path(probe.__file__).read_text(encoding="utf-8")
        self.assertNotIn("print(KEY)", source)
        self.assertNotIn("print(list_body)", source)
        self.assertNotIn("print(gen_body)", source)
        self.assertIn("sanitize_message", source)

    def test_does_not_touch_discovery_or_production_controls(self) -> None:
        forbidden = (
            "process_discovery_inbox",
            "AUTO_DISCOVERY_SCHEDULE_ENABLED",
            "enable-company",
            "disable-company",
            "vercel deploy",
            "vercel.com",
            "DATABASE_URL",
            "submit_discovery_batch",
            "record_discovery_evaluations",
            "jay-job-mcp.vercel.app",
            "claim_due_companies",
        )
        for token in forbidden:
            self.assertNotIn(token, self.text)
            self.assertNotIn(token.lower(), self.text.lower())

    def test_workflow_uses_bounded_model_list_page_size(self) -> None:
        source = Path(probe.__file__).read_text(encoding="utf-8")
        self.assertIn("pageSize=1000", probe.models_list_url())
        self.assertEqual(probe.LIST_PAGE_SIZE, 1000)
        self.assertIn("LIST_PAGE_SIZE = 1000", source)


class GeminiApiProbeUnitTests(unittest.TestCase):
    def _capture(self, fn) -> tuple[int, str]:
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = fn()
        return code, buf.getvalue()

    def test_models_list_url_includes_page_size_1000(self) -> None:
        url = probe.models_list_url()
        self.assertIn("/v1beta/models?", url)
        self.assertIn("pageSize=1000", url)

    def test_preferred_model_is_gemini_3_6_flash_not_2_5(self) -> None:
        self.assertEqual(probe.PREFERRED, "gemini-3.6-flash")
        self.assertEqual(probe.DEPRECATED_PRIMARY, "gemini-2.5-flash")
        self.assertNotEqual(probe.PREFERRED, "gemini-2.5-flash")

    def test_select_flash_candidates_prefers_3_6_and_defers_2_5(self) -> None:
        ordered = probe.select_flash_candidates(
            [
                "gemini-2.5-flash",
                "gemini-3.5-flash",
                "gemini-3.6-flash",
                "gemini-2.5-pro",
                "gemini-flash-latest",
            ]
        )
        self.assertEqual(ordered[0], "gemini-3.6-flash")
        self.assertNotEqual(ordered[0], "gemini-2.5-flash")
        self.assertEqual(ordered[-1], "gemini-2.5-flash")
        self.assertEqual(
            ordered,
            [
                "gemini-3.6-flash",
                "gemini-3.5-flash",
                "gemini-flash-latest",
                "gemini-2.5-flash",
            ],
        )

    def test_select_flash_candidates_never_primary_2_5_when_preferred_absent(self) -> None:
        ordered = probe.select_flash_candidates(
            ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-flash-lite-latest"]
        )
        self.assertEqual(ordered[0], "gemini-3.5-flash")
        self.assertNotEqual(ordered[0], "gemini-2.5-flash")
        self.assertEqual(ordered[-1], "gemini-2.5-flash")

    def test_network_failures_report_compact_fields_without_traceback(self) -> None:
        failures = (
            urllib.error.URLError("simulated dns failure"),
            TimeoutError("simulated timeout"),
            OSError("simulated os failure"),
        )
        for exc in failures:
            with self.subTest(error=type(exc).__name__):
                raised = exc

                def make_opener(error: BaseException):
                    def boom(_req, timeout=30):  # noqa: ARG001
                        raise error

                    return boom

                opener = make_opener(raised)

                def request_fn(method, url, payload=None):  # noqa: ARG001
                    return probe.request(
                        method,
                        url,
                        "test-key-not-a-secret",
                        payload,
                        opener=opener,
                    )

                code, output = self._capture(
                    lambda: probe.run_probe(
                        api_key="test-key-not-a-secret",
                        request_fn=request_fn,
                    )
                )
                self.assertEqual(code, 1)
                self.assertIn("http_status=0", output)
                self.assertIn("selected_model=none", output)
                self.assertIn("usable_text=no", output)
                self.assertIn("google_error_code=network_error", output)
                self.assertIn("google_error_message=", output)
                self.assertNotIn("Traceback", output)
                self.assertNotIn("test-key-not-a-secret", output)
                self.assertNotIn("x-goog-api-key", output)

    def test_http_error_reports_sanitized_google_fields_without_traceback(self) -> None:
        err_body = json.dumps(
            {
                "error": {
                    "code": 404,
                    "status": "NOT_FOUND",
                    "message": "model missing; api_key=AIzaSyLeakShouldRedact1234567890",
                }
            }
        )

        def request_fn(method, url, payload=None):  # noqa: ARG001
            return 404, err_body

        code, output = self._capture(
            lambda: probe.run_probe(api_key="secret-key-value", request_fn=request_fn)
        )
        self.assertEqual(code, 1)
        self.assertIn("http_status=404", output)
        self.assertIn("google_error_code=NOT_FOUND", output)
        self.assertIn("[redacted]", output)
        self.assertNotIn("AIzaSyLeakShouldRedact1234567890", output)
        self.assertNotIn("secret-key-value", output)
        self.assertNotIn("Traceback", output)
        self.assertNotIn(err_body, output)

    def test_successful_generate_content_path_uses_preferred_3_6(self) -> None:
        list_body = _flash_list_body("gemini-2.5-flash", "gemini-3.6-flash")
        gen_body = json.dumps(
            {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
        )
        calls: list[str] = []

        def request_fn(method, url, payload=None):  # noqa: ARG001
            if method == "GET":
                self.assertIn("pageSize=1000", url)
                return 200, list_body
            calls.append(url)
            self.assertIn("gemini-3.6-flash:generateContent", url)
            return 200, gen_body

        code, output = self._capture(
            lambda: probe.run_probe(api_key="k", request_fn=request_fn)
        )
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertIn("- gemini-3.6-flash", output)
        self.assertIn("http_status=200", output)
        self.assertIn("selected_model=gemini-3.6-flash", output)
        self.assertIn("usable_text=yes", output)
        self.assertNotIn("Traceback", output)

    def test_unavailable_preferred_falls_back_to_next_flash_model(self) -> None:
        list_body = _flash_list_body(
            "gemini-2.5-flash",
            "gemini-3.5-flash",
            "gemini-3.6-flash",
            "gemini-flash-latest",
        )
        gen_ok = json.dumps(
            {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
        )
        attempted: list[str] = []

        def request_fn(method, url, payload=None):  # noqa: ARG001
            if method == "GET":
                return 200, list_body
            if "gemini-3.6-flash" in url:
                attempted.append("gemini-3.6-flash")
                return 404, _not_found_body("gemini-3.6-flash")
            if "gemini-3.5-flash" in url:
                attempted.append("gemini-3.5-flash")
                return 200, gen_ok
            self.fail(f"unexpected generateContent URL: {url}")
            return 500, "{}"

        code, output = self._capture(
            lambda: probe.run_probe(api_key="k", request_fn=request_fn)
        )
        self.assertEqual(code, 0)
        self.assertEqual(attempted, ["gemini-3.6-flash", "gemini-3.5-flash"])
        self.assertIn("selected_model=gemini-3.5-flash", output)
        self.assertIn("usable_text=yes", output)
        self.assertNotIn("Traceback", output)
        self.assertNotIn("api_key=", output)

    def test_model_not_found_status_also_triggers_flash_fallback(self) -> None:
        list_body = _flash_list_body("gemini-3.6-flash", "gemini-flash-latest")
        unavailable = json.dumps(
            {
                "error": {
                    "code": 404,
                    "status": "MODEL_NOT_FOUND",
                    "message": "models/gemini-3.6-flash is unavailable",
                }
            }
        )
        gen_ok = json.dumps(
            {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
        )

        def request_fn(method, url, payload=None):  # noqa: ARG001
            if method == "GET":
                return 200, list_body
            if "gemini-3.6-flash" in url:
                return 400, unavailable
            if "gemini-flash-latest" in url:
                return 200, gen_ok
            self.fail(url)
            return 500, "{}"

        code, output = self._capture(
            lambda: probe.run_probe(api_key="k", request_fn=request_fn)
        )
        self.assertEqual(code, 0)
        self.assertIn("selected_model=gemini-flash-latest", output)

    def test_does_not_select_2_5_as_primary_when_preferred_missing(self) -> None:
        list_body = _flash_list_body("gemini-2.5-flash", "gemini-3.5-flash")
        gen_ok = json.dumps(
            {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
        )
        attempted: list[str] = []

        def request_fn(method, url, payload=None):  # noqa: ARG001
            if method == "GET":
                return 200, list_body
            if "gemini-3.5-flash" in url:
                attempted.append("gemini-3.5-flash")
                return 200, gen_ok
            if "gemini-2.5-flash" in url:
                attempted.append("gemini-2.5-flash")
                self.fail("gemini-2.5-flash must not be primary when alternatives exist")
            self.fail(url)
            return 500, "{}"

        code, output = self._capture(
            lambda: probe.run_probe(api_key="k", request_fn=request_fn)
        )
        self.assertEqual(code, 0)
        self.assertEqual(attempted, ["gemini-3.5-flash"])
        self.assertIn("selected_model=gemini-3.5-flash", output)

    def test_request_maps_urlerror_to_network_probe_error(self) -> None:
        with self.assertRaises(probe.NetworkProbeError) as ctx:
            probe.request(
                "GET",
                probe.models_list_url(),
                "k",
                opener=MagicMock(side_effect=urllib.error.URLError("down")),
            )
        self.assertNotIn("Traceback", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
