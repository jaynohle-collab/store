from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import unittest
from unittest.mock import patch

from job_agent.auto_discovery.limits import DiscoveryLimits
from job_agent.auto_discovery.types import AdapterError, LightweightCandidate
from job_agent.examples.automatic_discovery_run import load_keyword_policy, run_async
from job_agent.integrations.lifecycle_store import RemoteLifecycleStore
from job_agent.review.pipeline import KeywordDiscoveryPipeline
from job_agent.tests.test_keyword_review import policy

RUN_ID = "7c8f64a1-f7f7-4398-bd3e-3bba4e699603"
COMPANY_RUN_ID = "5a8a22d9-35e9-40e1-af62-b080ef831ff1"


def candidates(count=1):
    return [LightweightCandidate(client_candidate_id=f"fixture-{i}", title="Senior DevOps Engineer",
            company="Example", source="greenhouse", external_job_id=str(i),
            url=f"https://boards.example.com/jobs/{i}", location="US Remote",
            description="Distributed systems") for i in range(count)]


class Store:
    def __init__(self):
        self.calls = []
        self.applied = set()
        self.preflight_fail = False
        self.write_fail = False
        self.omit_preflight = False
        self.missing_claims = False
        self.offset = 0
        self.run_id = RUN_ID
        self.incomplete_write = False

    async def start_automatic_discovery_run(self, payload):
        self.calls.append(("start", payload))
        return {"id": self.run_id}

    async def finish_automatic_discovery_run(self, payload):
        self.calls.append(("finish", payload))
        return {}

    async def claim_due_discovery_companies(self, payload):
        self.calls.append(("claim", payload))
        return {"claims": [] if self.missing_claims else [{"company": {
            "id": "company", "company_key": "example", "company_name": "Example",
            "ats_provider": "greenhouse", "ats_org_id": "example",
            "stats": {"keyword_listing_scan": {"next_offset": self.offset}}},
            "run": {"id": COMPANY_RUN_ID}}]}

    async def complete_discovery_company_run(self, payload):
        self.calls.append(("complete", payload))
        return {}

    async def fail_discovery_company_run(self, payload):
        self.calls.append(("fail", payload))
        return {}

    async def check_discovery_candidates(self, payload):
        self.calls.append(("preflight", payload))
        if self.preflight_fail:
            raise PermissionError("forbidden private data")
        return {"results": [] if self.omit_preflight else [{
            "client_candidate_id": c["client_candidate_id"], "url": c["url"],
            "previously_applied": c["url"] in self.applied,
            "identity_status": "KNOWN_UNCHANGED", "gpt_skip_allowed": True,
            "gpt_decision": "REJECTED"} for c in payload["candidates"]]}

    async def upsert_keyword_review_candidates(self, payload):
        self.calls.append(("upsert", payload))
        if self.write_fail:
            raise RuntimeError("write failed with sensitive body")
        return {"saved_count": 0 if self.incomplete_write else len(payload["candidates"]),
                "new_count": len(payload["candidates"]), "updated_count": 0}


class Adapter:
    def __init__(self, rows):
        self.rows = rows
        self.max_listings = None

    def list_jobs(self, company):
        return list(self.rows)

    def get_job(self, *args):
        raise AssertionError("No mandatory detail fetch in listing-review mode")


class KeywordPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def run_pipeline(self, store=None, rows=None, limits=None):
        store = store or Store()
        adapter = Adapter(candidates() if rows is None else rows)
        pipeline = KeywordDiscoveryPipeline(store, policy=policy(), profile_id="fixture",
                                            limits=limits or DiscoveryLimits())
        with patch("job_agent.review.pipeline.get_adapter", return_value=adapter), \
             patch("job_agent.auto_discovery.pipeline.resolve_provider", side_effect=AssertionError("LLM forbidden")), \
             patch("job_agent.auto_discovery.evaluate.providers.resolve_provider", side_effect=AssertionError("LLM forbidden")), \
             patch("job_agent.auto_discovery.pipeline.evaluate_candidate", side_effect=AssertionError("LLM forbidden")):
            metrics = await pipeline.run()
        return store, metrics

    async def test_independent_of_llm_gates_and_old_rejections(self):
        store, metrics = await self.run_pipeline(rows=candidates(40), limits=DiscoveryLimits(max_evals_per_run=1, top_candidates_per_company=1))
        self.assertEqual(metrics.review_saved, 40)
        self.assertEqual(metrics.review_new, 40)
        self.assertEqual(metrics.llm_calls, 0)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.jobs_submitted, 0)
        self.assertEqual(metrics.full_descriptions_requested, 0)
        writes = [p for name, p in store.calls if name == "upsert"]
        self.assertEqual(len(writes[0]["candidates"]), 40)
        self.assertEqual(writes[0]["run_id"], RUN_ID)
        self.assertTrue(all(row["eligibility_status"] == "unverified" for row in writes[0]["candidates"]))
        self.assertTrue(all(row["application_action"] == "none" for row in writes[0]["candidates"]))
        self.assertEqual(next(p for name, p in store.calls if name == "finish")["metrics"]["discovery_mode"], "keyword")

    async def test_chunks_and_source_limits(self):
        store, metrics = await self.run_pipeline(rows=candidates(253), limits=DiscoveryLimits(max_listings_per_company=500))
        self.assertEqual(metrics.review_saved, 253)
        self.assertEqual([len(p["candidates"]) for name, p in store.calls if name == "upsert"], [100, 100, 53])
        self.assertEqual([len(p["candidates"]) for name, p in store.calls if name == "preflight"], [100, 100, 53])

    async def test_window_rotation_and_no_top_three(self):
        store = Store()
        store.offset = 20
        store, metrics = await self.run_pipeline(store=store, rows=candidates(200), limits=DiscoveryLimits(max_listings_per_company=100))
        self.assertEqual(metrics.review_saved, 100)
        completed = next(p for name, p in store.calls if name == "complete")
        self.assertEqual(completed["metrics"]["keyword_listing_scan"]["next_offset"], 120)

    async def test_applied_history_filtered_but_no_application_write(self):
        store = Store()
        store.applied = {candidates()[0].url}
        store, metrics = await self.run_pipeline(store=store)
        item = next(p for name, p in store.calls if name == "upsert")["candidates"][0]
        self.assertEqual(item["bucket"], "filtered")
        self.assertEqual(item["application_history"], "matched")
        self.assertEqual(metrics.review_filtered, 1)

    async def test_all_deduplicated_aliases_are_checked_for_applied_history(self):
        first = candidates()[0]
        second = candidates()[0]
        second.url = "https://boards.example.com/jobs/alternate"
        second.client_candidate_id = "alternate"
        store = Store()
        store.applied = {second.url}
        store, metrics = await self.run_pipeline(store=store, rows=[first, second])
        self.assertEqual(metrics.candidates_preflighted, 2)
        item = next(p for name, p in store.calls if name == "upsert")["candidates"][0]
        self.assertEqual(item["application_history"], "matched")
        self.assertEqual(item["bucket"], "filtered")
        self.assertEqual(len(item["identity_aliases"]), 2)

    async def test_positive_history_survives_conflicting_alias_responses(self):
        class ConflictingStore(Store):
            async def check_discovery_candidates(self, payload):
                response = await super().check_discovery_candidates(payload)
                response["results"][0]["previously_applied"] = True
                response["results"][1]["previously_applied"] = False
                return response
        first = candidates()[0]
        second = candidates()[0]
        second.external_job_id = "alternate-id"
        store, _ = await self.run_pipeline(store=ConflictingStore(), rows=[first, second])
        item = next(p for name, p in store.calls if name == "upsert")["candidates"][0]
        self.assertEqual(item["application_history"], "matched")
        self.assertEqual(item["bucket"], "filtered")

    async def test_preflight_boundaries_do_not_poison_valid_company(self):
        rows = candidates(4)
        rows[0].source = "s" * 129
        rows[1].external_job_id = "e" * 257
        rows[2].client_candidate_id = "c" * 200
        rows[2].posted_date = "Yesterday morning"
        rows[2].description_hash = "Not a valid hash"
        rows[2].location = "Long location " * 70
        store, metrics = await self.run_pipeline(rows=rows)
        self.assertEqual(metrics.review_saved, 4)
        self.assertEqual(metrics.candidates_preflighted, 2)
        preflight = next(p for name, p in store.calls if name == "preflight")["candidates"]
        for row in preflight:
            self.assertLessEqual(len(row["client_candidate_id"]), 128)
            self.assertLessEqual(len(row["location"]), 512)
            self.assertEqual(row["posted_date"], "")
            self.assertEqual(row["description_hash"], "")
        items = next(p for name, p in store.calls if name == "upsert")["candidates"]
        self.assertEqual(sum(i["application_history"] == "not_checked" for i in items), 2)

    async def test_missing_history_is_unknown(self):
        store = Store()
        store.omit_preflight = True
        store, _ = await self.run_pipeline(store=store)
        item = next(p for name, p in store.calls if name == "upsert")["candidates"][0]
        self.assertEqual(item["application_history"], "not_checked")

    async def test_preflight_failure_does_not_bypass_auth_or_fallback(self):
        store = Store()
        store.preflight_fail = True
        store, metrics = await self.run_pipeline(store=store)
        self.assertEqual(metrics.review_saved, 0)
        self.assertEqual(metrics.companies_failed, 1)
        self.assertFalse(any(name == "upsert" for name, _ in store.calls))
        self.assertNotIn("private data", json.dumps(metrics.as_dict()))

    async def test_failed_write_never_completes_or_advances_window(self):
        for incomplete in (False, True):
            store = Store()
            store.write_fail = not incomplete
            store.incomplete_write = incomplete
            store, metrics = await self.run_pipeline(store=store)
            self.assertEqual(metrics.companies_failed, 1)
            self.assertFalse(any(name == "complete" for name, _ in store.calls))
            self.assertNotIn("sensitive body", json.dumps(metrics.as_dict()))

    async def test_no_companies_is_successful_noop(self):
        store = Store()
        store.missing_claims = True
        store, metrics = await self.run_pipeline(store=store)
        self.assertEqual(metrics.review_saved, 0)
        self.assertFalse(metrics.errors)
        self.assertEqual(next(p for name, p in store.calls if name == "finish")["status"], "completed")

    async def test_invalid_run_id_stops_before_claim(self):
        store = Store()
        store.run_id = "missing"
        store, metrics = await self.run_pipeline(store=store)
        self.assertTrue(metrics.errors)
        self.assertFalse(any(name == "claim" for name, _ in store.calls))

    async def test_invalid_listing_links_never_reach_preflight_or_storage(self):
        rows = candidates()
        rows[0].url = "http://127.0.0.1/jobs/1"
        store, metrics = await self.run_pipeline(rows=rows)
        self.assertEqual(metrics.candidates_deterministic_rejected, 1)
        self.assertFalse(any(name in {"preflight", "upsert"} for name, _ in store.calls))

    async def test_cli_keyword_path_cannot_process_inbox(self):
        args = argparse.Namespace(mode="keyword", keyword_policy=None, max_companies=1,
                                  process_inbox=True, skip_inbox_handoff=False)
        fake_metrics = type("Metrics", (), dict(candidates_listed=0, review_saved=0,
                            review_new=0, review_updated=0, companies_failed=0, errors=[]))()
        class FakePipeline:
            def __init__(self, *args, **kwargs):
                pass
            async def run(self):
                return fake_metrics
        with patch.dict("os.environ", {"KEYWORD_REVIEW_POLICY_JSON": json.dumps({"policy_version": "test", "role_terms": ["engineer"]}),
                                      "KEYWORD_REVIEW_ACTIVATION_APPROVED": "true",
                                      "AUTO_DISCOVERY_PROCESS_INBOX": "true", "KEYWORD_REVIEW_PROFILE_ID": "fixture"}), \
             patch("job_agent.examples.automatic_discovery_run.RemoteLifecycleStore", return_value=Store()), \
             patch("job_agent.review.pipeline.KeywordDiscoveryPipeline", FakePipeline), \
             patch("job_agent.examples.automatic_discovery_run.AutomaticDiscoveryPipeline", side_effect=AssertionError("legacy pipeline forbidden")), \
             patch("job_agent.examples.process_discovery_inbox.main", side_effect=AssertionError("inbox forbidden")):
            self.assertEqual(await run_async(args), 0)

    async def test_missing_policy_stops_before_network_client(self):
        args = argparse.Namespace(mode="keyword", keyword_policy=None, max_companies=1)
        with patch.dict("os.environ", {"KEYWORD_REVIEW_POLICY_JSON": "", "KEYWORD_REVIEW_ACTIVATION_APPROVED": "true"}), \
             patch("job_agent.examples.automatic_discovery_run.RemoteLifecycleStore", side_effect=AssertionError("network client forbidden")):
            self.assertEqual(await run_async(args), 2)

    async def test_keyword_mode_requires_separate_exact_opt_in_before_any_work(self):
        args = argparse.Namespace(mode=None, keyword_policy=None, max_companies=1,
                                  process_inbox=True, skip_inbox_handoff=False)
        for approval in (None, "", "false", "1", "yes", "TRUE", " true", "true "):
            with self.subTest(approval=approval), patch.dict("os.environ", {"AUTO_DISCOVERY_MODE": "keyword"}):
                if approval is None:
                    os.environ.pop("KEYWORD_REVIEW_ACTIVATION_APPROVED", None)
                else:
                    os.environ["KEYWORD_REVIEW_ACTIVATION_APPROVED"] = approval
                with patch("job_agent.examples.automatic_discovery_run.load_keyword_policy", side_effect=AssertionError("policy read forbidden")), \
                     patch("job_agent.examples.automatic_discovery_run.RemoteLifecycleStore", side_effect=AssertionError("client forbidden")), \
                     patch("job_agent.examples.automatic_discovery_run.AutomaticDiscoveryPipeline", side_effect=AssertionError("GPT fallback forbidden")), \
                     patch("job_agent.examples.process_discovery_inbox.main", side_effect=AssertionError("inbox forbidden")):
                    self.assertEqual(await run_async(args), 2)

    async def test_store_routes_only_to_new_tool(self):
        class Client:
            def __init__(self):
                self.called = []
            async def call_tool(self, name, payload):
                self.called.append((name, payload))
                return {"saved_count": 2}
        client = Client()
        result = await RemoteLifecycleStore(client).upsert_keyword_review_candidates({"candidates": []})
        self.assertEqual(result["saved_count"], 2)
        self.assertEqual(client.called[0][0], "upsert_keyword_review_candidates")


class KeywordPolicyLoadingTests(unittest.TestCase):
    def test_invalid_policy_errors_do_not_echo_private_terms(self):
        with patch.dict("os.environ", {"KEYWORD_REVIEW_POLICY_JSON": json.dumps({
            "policy_version": "secret", "keyword_groups": {"privategroup": "not a list"}})}):
            with self.assertRaises(ValueError) as caught:
                load_keyword_policy()
            self.assertNotIn("privategroup", str(caught.exception))


class KeywordWorkflowActivationTests(unittest.TestCase):
    def test_manual_only_gate_precedes_source_expansion_and_does_not_fallback(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/automatic-job-discovery.yml").read_text()
        binding = "KEYWORD_REVIEW_ACTIVATION_APPROVED: ${{ github.event_name == 'workflow_dispatch' && inputs.activate_keyword_review == true && 'true' || 'false' }}"
        self.assertIn(binding, workflow)
        self.assertRegex(workflow, r"activate_keyword_review:\n(?:[^\n]*\n){1,4}\s+default: false")
        self.assertNotIn("vars.KEYWORD_REVIEW_ACTIVATION_APPROVED", workflow)
        self.assertIn("env.AUTO_DISCOVERY_MODE == 'gpt'", workflow)
        verify = workflow.split("      - name: Verify required secrets are present\n", 1)[1]
        script = verify.split("        run: |\n", 1)[1].split("\n      - name:", 1)[0]
        script = re.sub(r"^          ", "", script, flags=re.MULTILINE)
        self.assertLess(workflow.index("explicitly approved manual canary"), workflow.index("- name: Expand and verify discovery companies"))
        for approval in ("", "false", "1", "yes", "TRUE", " true", "true ", "true"):
            with self.subTest(approval=approval):
                result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env={
                    "PATH": os.environ.get("PATH", ""), "AUTO_DISCOVERY_MODE": "keyword",
                    "KEYWORD_REVIEW_ACTIVATION_APPROVED": approval,
                    "AUTH0_CLIENT_ID": "fixture", "AUTH0_CLIENT_SECRET": "fixture",
                    "KEYWORD_REVIEW_POLICY_JSON": "fixture",
                }, timeout=5)
                self.assertEqual(result.returncode, 0 if approval == "true" else 1)
                if approval != "true":
                    self.assertIn("Keyword review is disabled", result.stdout)


if __name__ == "__main__":
    unittest.main()
