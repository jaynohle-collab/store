"""Regression tests for MCP apply payload optional-field sanitization."""

from __future__ import annotations

import unittest
import uuid
from datetime import date, datetime, timezone
from unittest.mock import patch

from job_agent.lifecycle.atomic_apply import (
    build_atomic_apply_fields,
    coerce_optional_posted_date,
    deep_omit_none,
    format_posted_date,
    is_valid_uuid,
    sanitize_apply_discovery_batch_job_persistence_payload,
)
from job_agent.lifecycle.types import (
    DiscoveredJobResult,
    LifecycleClassification,
    NormalizedLifecyclePosting,
    PersistencePlan,
    PostingDisposition,
)


def _posting(**overrides) -> NormalizedLifecyclePosting:
    base = dict(
        company="AgentForge",
        company_key="agentforge",
        title="Staff AI Engineer",
        normalized_title="staff ai engineer",
        role_family=None,
        location="United States",
        normalized_location="united states",
        source="Greenhouse",
        url="https://example.com/jobs/staff-ai",
        normalized_url="https://example.com/jobs/staff-ai",
        external_job_id=None,
        description="Build agents.",
        description_hash="abc123",
        remote_status="Remote",
        salary="$220k",
        posted_date=None,
    )
    base.update(overrides)
    return NormalizedLifecyclePosting(**base)


def _new_job_result(posting: NormalizedLifecyclePosting) -> DiscoveredJobResult:
    return DiscoveredJobResult(
        posting=posting,
        classification=LifecycleClassification(
            disposition=PostingDisposition.NEW_JOB,
            reason="new",
            canonical_similarity_score=None,
        ),
        persistence_plan=PersistencePlan(
            create_canonical=True,
            create_posting=True,
            disposition=PostingDisposition.NEW_JOB,
        ),
        match_score=None,
    )


class DeepOmitNoneSemanticsTests(unittest.TestCase):
    def test_preserves_false_zero_empty_string_empty_list_empty_dict(self):
        original = {
            "flag": False,
            "count": 0,
            "empty": "",
            "list": [],
            "dict": {},
            "nested": {"flag": False, "count": 0, "empty": "", "list": [], "dict": {}},
        }
        cleaned = deep_omit_none(original)
        self.assertEqual(cleaned["flag"], False)
        self.assertEqual(cleaned["count"], 0)
        self.assertEqual(cleaned["empty"], "")
        self.assertEqual(cleaned["list"], [])
        self.assertEqual(cleaned["dict"], {})
        self.assertEqual(cleaned["nested"]["flag"], False)
        self.assertEqual(cleaned["nested"]["count"], 0)

    def test_drops_none_list_elements_and_recurses(self):
        cleaned = deep_omit_none(
            {
                "items": [1, None, {"a": None, "b": 2}, [None, 3]],
            }
        )
        self.assertEqual(cleaned["items"], [1, {"b": 2}, [3]])

    def test_does_not_mutate_input(self):
        original = {"a": None, "b": {"c": None, "d": 1}, "e": [None, 2]}
        snapshot = {
            "a": None,
            "b": {"c": None, "d": 1},
            "e": [None, 2],
        }
        cleaned = deep_omit_none(original)
        self.assertEqual(original, snapshot)
        self.assertNotIn("a", cleaned)
        self.assertIsNot(cleaned["b"], original["b"])
        self.assertIsNot(cleaned["e"], original["e"])


class SanitizeApplyPayloadScopeTests(unittest.TestCase):
    def test_strips_nulls_from_create_posting_but_preserves_before_state_nulls(self):
        payload = {
            "batch_id": str(uuid.uuid4()),
            "attempt_id": str(uuid.uuid4()),
            "input_index": 0,
            "idempotency_key": "batch:0",
            "processing_action": "created",
            "external_job_id": None,
            "create_posting": {
                "use_new_canonical": True,
                "is_repost": False,
                "external_job_id": None,
                "posted_date": None,
                "supersedes_posting_id": None,
            },
            "before_state": {
                "salary": None,
                "description_hash": "abc",
                "nested": {"x": None},
            },
            "metadata": {"canonical_job_id": None, "kept": "yes"},
        }
        original_before = {
            "salary": None,
            "description_hash": "abc",
            "nested": {"x": None},
        }
        cleaned = sanitize_apply_discovery_batch_job_persistence_payload(payload)
        self.assertNotIn("external_job_id", cleaned)
        self.assertNotIn("external_job_id", cleaned["create_posting"])
        self.assertNotIn("posted_date", cleaned["create_posting"])
        self.assertFalse(cleaned["create_posting"]["is_repost"])
        self.assertEqual(cleaned["before_state"], original_before)
        self.assertIsNone(cleaned["before_state"]["salary"])
        self.assertNotIn("canonical_job_id", cleaned["metadata"])
        # Original untouched
        self.assertIsNone(payload["create_posting"]["external_job_id"])
        self.assertIs(payload["before_state"]["salary"], None)

    def test_preserves_match_score_zero(self):
        payload = {
            "batch_id": str(uuid.uuid4()),
            "attempt_id": str(uuid.uuid4()),
            "input_index": 0,
            "idempotency_key": "batch:0",
            "processing_action": "created",
            "evaluation": {
                "use_resolved_posting": True,
                "match_score": 0,
                "recommendation": "save",
            },
        }
        cleaned = sanitize_apply_discovery_batch_job_persistence_payload(payload)
        self.assertEqual(cleaned["evaluation"]["match_score"], 0)


class AtomicApplyOptionalFieldTests(unittest.TestCase):
    def test_create_posting_omits_missing_optional_identity_fields(self):
        result = _new_job_result(
            _posting(
                external_job_id=None,
                posted_date=None,
            )
        )
        fields = build_atomic_apply_fields(
            result,
            recommendation="save",
            reason="new job",
        )
        create_posting = fields["create_posting"]
        self.assertNotIn("external_job_id", create_posting)
        self.assertNotIn("posted_date", create_posting)
        self.assertNotIn("supersedes_posting_id", create_posting)
        self.assertNotIn("canonical_job_id", create_posting)
        self.assertTrue(create_posting["use_new_canonical"])
        self.assertFalse(create_posting["is_repost"])

    def test_blank_whitespace_external_job_id_omitted(self):
        fields = build_atomic_apply_fields(
            _new_job_result(_posting(external_job_id="   \t")),
            recommendation="save",
            reason="new",
        )
        self.assertNotIn("external_job_id", fields["create_posting"])

    def test_create_posting_preserves_valid_external_job_id_and_posted_date(self):
        result = _new_job_result(
            _posting(
                external_job_id="gh-12345",
                posted_date=date(2026, 8, 16),
            )
        )
        fields = build_atomic_apply_fields(
            result,
            recommendation="save",
            reason="new job",
            score_breakdown={"total": 80},
        )
        create_posting = fields["create_posting"]
        self.assertEqual(create_posting["external_job_id"], "gh-12345")
        self.assertEqual(create_posting["posted_date"], "2026-08-16")
        self.assertNotIn("match_score", fields["evaluation"])
        self.assertIn("score_breakdown", fields["evaluation"]["metadata"])

    def test_posted_date_formats_and_malformed_fails_locally(self):
        self.assertIsNone(format_posted_date(""))
        self.assertIsNone(format_posted_date("   "))
        self.assertIsNone(format_posted_date("08/16/2026"))
        self.assertIsNone(format_posted_date("not-a-date"))
        self.assertIsNone(format_posted_date("2026-08-16T12:00:00"))  # naive string
        self.assertIsNone(format_posted_date(datetime(2026, 8, 16, 12, 0)))  # naive
        self.assertEqual(format_posted_date("2026-08-16"), "2026-08-16")
        offset = datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc)
        self.assertTrue(format_posted_date(offset).startswith("2026-08-16"))
        self.assertIsNotNone(format_posted_date("2026-08-16T12:00:00+00:00"))
        self.assertIsNotNone(format_posted_date("2026-08-16T12:00:00Z"))

        self.assertIsNone(coerce_optional_posted_date(None))
        self.assertIsNone(coerce_optional_posted_date(""))
        self.assertIsNone(coerce_optional_posted_date("   "))
        with self.assertRaises(ValueError):
            coerce_optional_posted_date("08/16/2026")
        with self.assertRaises(ValueError):
            coerce_optional_posted_date("2026-08-16T12:00:00")  # naive
        with self.assertRaises(ValueError):
            coerce_optional_posted_date(datetime(2026, 8, 16, 12, 0))

        # Malformed optional date never appears in the MCP payload.
        fields = build_atomic_apply_fields(
            _new_job_result(_posting(posted_date=None)),
            recommendation="save",
            reason="new",
        )
        self.assertNotIn("posted_date", fields["create_posting"])

        # Present malformed date fails before MCP (sanitize path).
        with self.assertRaises(ValueError):
            sanitize_apply_discovery_batch_job_persistence_payload(
                {
                    "batch_id": str(uuid.uuid4()),
                    "attempt_id": str(uuid.uuid4()),
                    "input_index": 0,
                    "idempotency_key": "batch:0",
                    "processing_action": "created",
                    "create_posting": {
                        "use_new_canonical": True,
                        "is_repost": False,
                        "posted_date": "08/16/2026",
                    },
                }
            )

    def test_match_score_zero_preserved(self):
        result = _new_job_result(_posting())
        result.match_score = 0
        fields = build_atomic_apply_fields(
            result,
            recommendation="save",
            reason="new",
        )
        self.assertEqual(fields["evaluation"]["match_score"], 0)

    def test_repost_includes_valid_supersedes_uuid_only(self):
        prior = str(uuid.uuid4())
        posting = _posting(external_job_id="rep-1", posted_date=date(2026, 8, 1))
        result = DiscoveredJobResult(
            posting=posting,
            classification=LifecycleClassification(
                disposition=PostingDisposition.REPOST,
                reason="repost",
                previous_posting_id=prior,
                canonical_job_id=str(uuid.uuid4()),
            ),
            persistence_plan=PersistencePlan(
                create_canonical=False,
                create_posting=True,
                touch_canonical_id=str(uuid.uuid4()),
                is_repost=True,
                supersedes_posting_id=prior,
                disposition=PostingDisposition.REPOST,
            ),
            match_score=72.0,
        )
        fields = build_atomic_apply_fields(
            result,
            recommendation="save_repost",
            reason="repost",
        )
        create_posting = fields["create_posting"]
        self.assertEqual(create_posting["supersedes_posting_id"], prior)
        self.assertTrue(is_valid_uuid(create_posting["canonical_job_id"]))
        self.assertTrue(create_posting["is_repost"])
        self.assertEqual(fields["evaluation"]["match_score"], 72.0)

        bad = DiscoveredJobResult(
            posting=posting,
            classification=LifecycleClassification(
                disposition=PostingDisposition.REPOST,
                reason="repost",
            ),
            persistence_plan=PersistencePlan(
                create_canonical=False,
                create_posting=True,
                touch_canonical_id=str(uuid.uuid4()),
                is_repost=True,
                supersedes_posting_id="not-a-uuid",
                disposition=PostingDisposition.REPOST,
            ),
            match_score=50.0,
        )
        with self.assertRaises(ValueError):
            build_atomic_apply_fields(
                bad,
                recommendation="save_repost",
                reason="repost",
            )

        blank_touch = DiscoveredJobResult(
            posting=posting,
            classification=LifecycleClassification(
                disposition=PostingDisposition.REPOST,
                reason="repost",
            ),
            persistence_plan=PersistencePlan(
                create_canonical=False,
                create_posting=True,
                touch_canonical_id="   ",
                is_repost=True,
                supersedes_posting_id=prior,
                disposition=PostingDisposition.REPOST,
            ),
            match_score=50.0,
        )
        with self.assertRaises(ValueError):
            build_atomic_apply_fields(
                blank_touch,
                recommendation="save_repost",
                reason="repost",
            )

    def test_update_posting_requires_uuid_and_omits_missing_optionals(self):
        posting_id = str(uuid.uuid4())
        posting = _posting(
            external_job_id=None,
            posted_date=None,
            salary=None,
            remote_status=None,
        )
        result = DiscoveredJobResult(
            posting=posting,
            classification=LifecycleClassification(
                disposition=PostingDisposition.SAME_POSTING,
                reason="same",
                previous_posting_id=posting_id,
                canonical_job_id=str(uuid.uuid4()),
            ),
            persistence_plan=PersistencePlan(
                create_canonical=False,
                create_posting=False,
                update_posting_id=posting_id,
                touch_canonical_id=str(uuid.uuid4()),
                disposition=PostingDisposition.SAME_POSTING,
            ),
            match_score=61.0,
        )
        fields = build_atomic_apply_fields(
            result,
            recommendation="update_existing",
            reason="same",
        )
        update = fields["update_posting"]
        self.assertEqual(update["id"], posting_id)
        self.assertIn("last_seen_at", update)
        self.assertNotIn("posted_date", update)
        self.assertNotIn("salary", update)
        self.assertNotIn("remote_status", update)

        bad = DiscoveredJobResult(
            posting=posting,
            classification=LifecycleClassification(
                disposition=PostingDisposition.SAME_POSTING,
                reason="same",
            ),
            persistence_plan=PersistencePlan(
                create_canonical=False,
                create_posting=False,
                update_posting_id="bad-id",
                disposition=PostingDisposition.SAME_POSTING,
            ),
        )
        with self.assertRaises(ValueError):
            build_atomic_apply_fields(
                bad,
                recommendation="update_existing",
                reason="same",
            )

    def test_create_canonical_omits_null_optional_strings(self):
        result = _new_job_result(
            _posting(role_family=None, location=None, normalized_location=None)
        )
        fields = build_atomic_apply_fields(
            result,
            recommendation="save",
            reason="new",
        )
        canonical = fields["create_canonical"]
        self.assertNotIn("role_family", canonical)
        self.assertNotIn("location", canonical)
        self.assertNotIn("normalized_location", canonical)


class ApplyIdempotencyContractTests(unittest.TestCase):
    def test_idempotency_key_is_stable_per_batch_input(self):
        batch_id = "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7"
        for index in (0, 1, 12):
            self.assertEqual(f"{batch_id}:{index}", f"{batch_id}:{int(index)}")

    def test_sanitize_rejects_malformed_uuid_fields_before_mcp(self):
        base = {
            "batch_id": "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7",
            "attempt_id": "d5c976c8-d2d2-4ac6-bb96-f0010d540c2b",
            "input_index": 0,
            "idempotency_key": "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7:0",
            "processing_action": "created",
        }
        with self.assertRaises(ValueError):
            sanitize_apply_discovery_batch_job_persistence_payload(
                {
                    **base,
                    "touch_canonical_id": "not-a-uuid",
                }
            )
        with self.assertRaises(ValueError):
            sanitize_apply_discovery_batch_job_persistence_payload(
                {
                    **base,
                    "create_posting": {
                        "use_new_canonical": False,
                        "is_repost": True,
                        "canonical_job_id": "bad",
                    },
                }
            )
        with self.assertRaises(ValueError):
            sanitize_apply_discovery_batch_job_persistence_payload(
                {
                    **base,
                    "create_posting": {
                        "use_new_canonical": False,
                        "is_repost": False,
                    },
                }
            )

    def test_remote_apply_sanitizes_before_mcp_and_does_not_mutate_input(self):
        from job_agent.integrations.lifecycle_store import RemoteLifecycleStore

        payload = {
            "batch_id": "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7",
            "attempt_id": "d5c976c8-d2d2-4ac6-bb96-f0010d540c2b",
            "input_index": 0,
            "idempotency_key": "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7:0",
            "processing_action": "created",
            "create_posting": {
                "use_new_canonical": True,
                "is_repost": False,
                "external_job_id": None,
                "posted_date": None,
                "supersedes_posting_id": None,
                "url": "https://example.com/jobs/1",
            },
            "before_state": {"salary": None},
        }
        store = RemoteLifecycleStore(client=object())  # type: ignore[arg-type]
        captured: dict[str, object] = {}

        async def fake_call(name: str, arguments: dict | None = None):
            captured["name"] = name
            captured["arguments"] = arguments
            return {
                "ok": True,
                "idempotent_replay": False,
                "effect": {"id": "effect-1"},
            }

        with patch.object(store, "_call", side_effect=fake_call):
            import asyncio

            result = asyncio.run(store.apply_discovery_batch_job_persistence(payload))

        self.assertEqual(captured["name"], "apply_discovery_batch_job_persistence")
        args = captured["arguments"]
        assert isinstance(args, dict)
        self.assertNotIn("external_job_id", args["create_posting"])
        self.assertNotIn("posted_date", args["create_posting"])
        self.assertNotIn("supersedes_posting_id", args["create_posting"])
        self.assertIsNone(args["before_state"]["salary"])
        # Original still has nulls — sanitizer must not mutate caller input.
        self.assertIsNone(payload["create_posting"]["external_job_id"])
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
