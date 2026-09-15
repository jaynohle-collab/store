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

    def test_successful_generate_content_path(self) -> None:
        list_body = json.dumps(
            {
                "models": [
                    {
                        "name": "models/gemini-2.5-flash",
                        "supportedGenerationMethods": ["generateContent"],
                    }
                ]
            }
        )
        gen_body = json.dumps(
            {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
        )

        def request_fn(method, url, payload=None):  # noqa: ARG001
            if method == "GET":
                self.assertIn("pageSize=1000", url)
                return 200, list_body
            return 200, gen_body

        code, output = self._capture(
            lambda: probe.run_probe(api_key="k", request_fn=request_fn)
        )
        self.assertEqual(code, 0)
        self.assertIn("- gemini-2.5-flash", output)
        self.assertIn("http_status=200", output)
        self.assertIn("selected_model=gemini-2.5-flash", output)
        self.assertIn("usable_text=yes", output)
        self.assertNotIn("Traceback", output)

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
