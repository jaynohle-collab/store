# Cross-language description-hash parity fixtures.
# Shared with remote_mcp/src/lib/__tests__/fixtures/description_hash_parity.json
#
# Input contract: pass extracted/plain job-description text, not raw HTML.
# The hasher does not strip HTML; tags become punctuation and remaining
# tag names may survive as tokens. Empty normalized input returns null.
from __future__ import annotations

import json
import unittest
from pathlib import Path

from job_agent.memory.fingerprint import compute_description_hash, normalize_description_text

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "remote_mcp"
    / "src"
    / "lib"
    / "__tests__"
    / "fixtures"
    / "description_hash_parity.json"
)

LIVE_CASES = [
    ("empty", "", "", None),
    ("uppercase", "Build Production LLM Agents.", "build production llm agents", "3406d8a6ef8edfbe"),
    ("ampersand", "AI & ML Platform Engineer", "ai and ml platform engineer", "250478873ae311da"),
    ("tabs", "Line one.\t\nLine two.", "line one line two", "e490ed577595f616"),
    ("punct_only", "!!! ---", "", None),
    ("html_like", "<p>Build production LLM agents.</p>", "p build production llm agents p", "a2141bf352ed9ceb"),
]


class DescriptionHashParityTests(unittest.TestCase):
    def test_python_matches_committed_fixtures(self) -> None:
        fixtures = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(fixtures), 4)
        for row in fixtures:
            with self.subTest(name=row["name"]):
                self.assertEqual(normalize_description_text(row["description"]), row["normalized"])
                self.assertEqual(compute_description_hash(row["description"]), row["description_hash"])

    def test_live_python_producer_cases(self) -> None:
        for name, description, normalized, digest in LIVE_CASES:
            with self.subTest(name=name):
                self.assertEqual(normalize_description_text(description), normalized)
                self.assertEqual(compute_description_hash(description), digest)

    def test_empty_normalization_returns_none(self) -> None:
        self.assertIsNone(compute_description_hash("   "))
        self.assertIsNone(compute_description_hash("***"))


if __name__ == "__main__":
    unittest.main()
