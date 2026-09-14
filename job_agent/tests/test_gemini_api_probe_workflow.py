"""Static checks for the Gemini API probe workflow."""

from __future__ import annotations

import re
import unittest
from pathlib import Path


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
        # Only workflow_dispatch under on:
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
        # Secret reaches the step only through env; never echoed or printed.
        self.assertNotIn("echo ${{ secrets", self.text)
        self.assertNotIn("echo \"$GEMINI_API_KEY\"", self.text)
        self.assertNotIn("echo $GEMINI_API_KEY", self.text)
        self.assertNotIn("print(KEY)", self.text)
        self.assertNotIn("print(os.environ", self.text)
        self.assertNotRegex(self.text, r"print\(\s*KEY\s*\)")
        # Never dump request headers or complete provider payloads.
        self.assertNotIn("curl -v", self.text)
        self.assertNotIn("--verbose", self.text)
        self.assertNotIn("print(list_body)", self.text)
        self.assertNotIn("print(gen_body)", self.text)
        self.assertNotIn("print(req.headers", self.text)
        self.assertNotIn("pprint(", self.text)
        self.assertIn("sanitize_message", self.text)

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


if __name__ == "__main__":
    unittest.main()
