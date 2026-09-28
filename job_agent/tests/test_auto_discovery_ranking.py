"""Profile-aware ranking, top-K selection, limits and profile generations.

Network-isolated: fake stores/adapters only; never Auth0, Vercel MCP or Neon.
"""

from __future__ import annotations

import itertools
import os
import unittest
import uuid
from datetime import date
from typing import Any
from unittest import mock

import httpx

from job_agent.auto_discovery.http_client import SafeHttpClient
from job_agent.auto_discovery.limits import DiscoveryLimits
from job_agent.auto_discovery.pipeline import AutomaticDiscoveryPipeline
from job_agent.auto_discovery.ranking import (
    NOVELTY_CHANGED,
    NOVELTY_COOLDOWN,
    NOVELTY_NEW,
    NOVELTY_QUALIFIED_UNSUBMITTED,
    NOVELTY_UNCHANGED,
    OUTCOME_NO_EVIDENCE,
    OUTCOME_REUSED,
    SELECTION_MEMORY_KEY,
    SELECTION_MEMORY_MAX_ENTRIES,
    StoredEvaluationState,
    candidate_key,
    classify_location,
    classify_novelty,
    persona_reject_reason,
    rank_listings,
    trim_selection_memory,
)
from job_agent.auto_discovery.types import AdapterError, LightweightCandidate
from job_agent.profile.identity import (
    LEGACY_PROFILE_VERSION,
    ProfileIdentity,
    load_active_profile,
)
from job_agent.tests.test_auto_discovery_pipeline import FakeAdapter, FakeProvider, FakeStore

TODAY = date(2026, 9, 28)
PROFILE = load_active_profile()


def cand(
    n: int,
    title: str = "Senior AI Engineer",
    location: str = "Remote - US",
    posted: str = "2026-09-20",
    description: str | None = None,
    description_hash: str = "",
) -> LightweightCandidate:
    return LightweightCandidate(
        client_candidate_id=f"greenhouse:acme:{n}",
        company="Acme",
        title=title,
        url=f"https://boards.greenhouse.io/acme/jobs/{n}",
        source="greenhouse",
        external_job_id=str(n),
        location=location,
        posted_date=posted,
        description=description,
        description_hash=description_hash,
    )


def state(decision: str = "REJECTED_LOW_SCORE", **overrides: Any) -> StoredEvaluationState:
    values = {
        "evaluation_id": "eval-1",
        "gpt_decision": decision,
        "description_hash": "aaaaaaaaaaaaaaaa",
        "evaluated_at": "2026-09-25T00:00:00Z",
        "submitted_to_inbox": False,
    }
    values.update(overrides)
    return StoredEvaluationState(**values)


class PersonaRejectTests(unittest.TestCase):
    def test_deterministic_persona_rejects(self):
        cases = {
            "Software Engineering Intern": "internship",
            "Junior Backend Engineer": "junior",
            "Entry Level Software Engineer": "entry_level",
            "Frontend Engineer": "frontend_only",
            "Site Reliability Engineer": "pure_devops_sre",
            "DevOps Engineer": "pure_devops_sre",
        }
        for title, reason in cases.items():
            with self.subTest(title=title):
                self.assertEqual(persona_reject_reason(cand(1, title=title), PROFILE), reason)

    def test_nyc_onsite_and_incompatible_location(self):
        self.assertEqual(
            persona_reject_reason(cand(1, location="New York, NY"), PROFILE),
            "nyc_onsite_only",
        )
        self.assertIsNone(persona_reject_reason(cand(1, location="New York, NY (Remote)"), PROFILE))
        for loc in ("London, UK", "Toronto, Canada", "Remote - EMEA", "Bengaluru"):
            with self.subTest(loc=loc):
                self.assertEqual(
                    persona_reject_reason(cand(1, location=loc), PROFILE),
                    "incompatible_location",
                )

    def test_location_classification_keeps_us_and_unknown(self):
        self.assertEqual(classify_location("San Francisco, CA"), "us")
        self.assertEqual(classify_location("Remote - US or Canada"), "us")
        self.assertEqual(classify_location("Remote"), "unknown")
        self.assertEqual(classify_location(""), "unknown")
        self.assertEqual(classify_location("Dublin, Ireland"), "non_us")

    def test_ai_platform_roles_pass(self):
        for title in ("Staff AI Engineer", "Agent Platform Engineer", "Senior Backend Engineer"):
            self.assertIsNone(persona_reject_reason(cand(1, title=title), PROFILE))


class RankingTests(unittest.TestCase):
    def _listings(self) -> list[LightweightCandidate]:
        return [
            cand(1, "Account Executive, Enterprise"),
            cand(2, "Senior AI Engineer"),
            cand(3, "Staff Software Engineer, AI Platform"),
            cand(4, "Senior Backend Engineer", location="Remote"),
            cand(5, "Forward Deployed Engineer", location="San Francisco, CA"),
            cand(6, "Product Designer"),
            cand(7, "Principal LLM Platform Engineer"),
            cand(8, "Machine Learning Engineer", location="Seattle, WA"),
        ]

    def test_selection_is_independent_of_ats_order(self):
        listings = self._listings()
        expected = None
        for perm in itertools.islice(itertools.permutations(listings), 0, 400, 7):
            result = rank_listings(
                list(perm), profile=PROFILE, states={}, memory={}, top_k=5,
                min_rank_score=20, today=TODAY,
            )
            keys = [r.key for r in result.selected]
            if expected is None:
                expected = keys
            self.assertEqual(keys, expected)
        self.assertEqual(len(expected or []), 5)

    def test_top_k_respected_and_irrelevant_roles_excluded(self):
        for k in (3, 4, 5):
            result = rank_listings(
                self._listings(), profile=PROFILE, states={}, memory={}, top_k=k,
                min_rank_score=20, today=TODAY,
            )
            self.assertEqual(len(result.selected), k)
        result = rank_listings(
            self._listings(), profile=PROFILE, states={}, memory={}, top_k=5,
            min_rank_score=20, today=TODAY,
        )
        titles = [r.candidate.title for r in result.selected]
        self.assertNotIn("Account Executive, Enterprise", titles)
        self.assertNotIn("Product Designer", titles)
        self.assertIn("Principal LLM Platform Engineer", titles)
        below = {r.candidate.title for r in result.below_threshold}
        self.assertIn("Product Designer", below)

    def test_new_and_changed_outrank_unchanged_and_unchanged_is_skipped(self):
        listings = self._listings()
        top = cand(7, "Principal LLM Platform Engineer", posted="2026-09-01")
        listings[6] = top
        states = {candidate_key(top): state()}
        result = rank_listings(
            listings, profile=PROFILE, states=states, memory={}, top_k=5,
            min_rank_score=20, today=TODAY,
        )
        self.assertNotIn(candidate_key(top), [r.key for r in result.selected])
        self.assertIn(candidate_key(top), [r.key for r in result.unchanged])

    def test_qualified_unsubmitted_is_selected_first(self):
        listings = self._listings()
        low = cand(9, "Engineering Manager, Platform")
        listings.append(low)
        states = {candidate_key(low): state("QUALIFIED", submitted_to_inbox=False)}
        result = rank_listings(
            listings, profile=PROFILE, states=states, memory={}, top_k=3,
            min_rank_score=20, today=TODAY,
        )
        self.assertEqual(result.selected[0].key, candidate_key(low))
        self.assertEqual(result.selected[0].novelty, NOVELTY_QUALIFIED_UNSUBMITTED)

    def test_submitted_qualified_is_unchanged(self):
        c = cand(9)
        self.assertEqual(
            classify_novelty(c, state("QUALIFIED", submitted_to_inbox=True), None, TODAY),
            NOVELTY_UNCHANGED,
        )

    def test_novelty_by_hash_and_by_update_date(self):
        self.assertEqual(classify_novelty(cand(1), None, None, TODAY), NOVELTY_NEW)
        hashed = cand(1, description="x", description_hash="bbbbbbbbbbbbbbbb")
        self.assertEqual(classify_novelty(hashed, state(), None, TODAY), NOVELTY_CHANGED)
        same = cand(1, description="x", description_hash="aaaaaaaaaaaaaaaa")
        self.assertEqual(classify_novelty(same, state(), None, TODAY), NOVELTY_UNCHANGED)
        updated = cand(1, posted="2026-09-27")
        self.assertEqual(classify_novelty(updated, state(), None, TODAY), NOVELTY_CHANGED)
        # Re-fetched that listing version already and reused evidence: not changed again.
        memory = {"outcome": OUTCOME_REUSED, "posted": "2026-09-27", "at": "2026-09-27"}
        self.assertEqual(classify_novelty(updated, state(), memory, TODAY), NOVELTY_UNCHANGED)

    def test_no_evidence_candidates_cool_down_instead_of_starving_others(self):
        listings = [cand(i, "Senior AI Engineer") for i in range(1, 8)]
        memory = {
            candidate_key(listings[i]): {
                "outcome": OUTCOME_NO_EVIDENCE, "posted": "", "at": "2026-09-27"
            }
            for i in range(5)
        }
        result = rank_listings(
            listings, profile=PROFILE, states={}, memory=memory, top_k=5,
            min_rank_score=20, today=TODAY,
        )
        novelties = [r.novelty for r in result.selected]
        self.assertEqual(novelties[:2], [NOVELTY_NEW, NOVELTY_NEW])
        self.assertTrue(all(n == NOVELTY_COOLDOWN for n in novelties[2:]))
        # Cooldown expires after a week.
        expired = {k: {**v, "at": "2026-09-01"} for k, v in memory.items()}
        self.assertEqual(
            classify_novelty(listings[0], None, expired[candidate_key(listings[0])], TODAY),
            NOVELTY_NEW,
        )

    def test_memory_is_bounded(self):
        memory = {
            f"k{i}": {"outcome": OUTCOME_REUSED, "posted": "", "at": "2026-09-20"}
            for i in range(SELECTION_MEMORY_MAX_ENTRIES + 50)
        }
        memory["old"] = {"outcome": OUTCOME_REUSED, "posted": "", "at": "2025-01-01"}
        trimmed = trim_selection_memory(memory, TODAY)
        self.assertEqual(len(trimmed), SELECTION_MEMORY_MAX_ENTRIES)
        self.assertNotIn("old", trimmed)

    def test_duplicate_listings_deduped_deterministically(self):
        a = cand(1)
        b = cand(1, title="Senior AI Engineer (Dup)")
        r1 = rank_listings([a, b], profile=PROFILE, states={}, memory={}, top_k=5,
                           min_rank_score=0, today=TODAY)
        r2 = rank_listings([b, a], profile=PROFILE, states={}, memory={}, top_k=5,
                           min_rank_score=0, today=TODAY)
        self.assertEqual(len(r1.selected), 1)
        self.assertEqual(r1.selected[0].candidate.title, r2.selected[0].candidate.title)


class LimitsTests(unittest.TestCase):
    def test_new_variables_and_defaults(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            limits = DiscoveryLimits.from_env()
        self.assertEqual(
            (limits.max_companies, limits.max_listings_per_company,
             limits.top_candidates_per_company, limits.max_evals_per_run,
             limits.max_jobs_per_batch, limits.max_batches_per_run),
            (5, 100, 5, 15, 5, 3),
        )

    def test_legacy_variables_still_apply(self):
        env = {
            "AUTO_DISCOVERY_MAX_COMPANIES": "2",
            "AUTO_DISCOVERY_MAX_CANDIDATES_PER_COMPANY": "40",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            limits = DiscoveryLimits.from_env()
        self.assertEqual(limits.max_companies, 2)
        self.assertEqual(limits.max_listings_per_company, 40)
        self.assertEqual(limits.max_candidates_per_company, 40)

    def test_new_variables_win_and_top_k_is_clamped(self):
        env = {
            "AUTO_DISCOVERY_MAX_COMPANIES": "2",
            "AUTO_DISCOVERY_MAX_COMPANIES_PER_RUN": "4",
            "AUTO_DISCOVERY_MAX_CANDIDATES_PER_COMPANY": "10",
            "AUTO_DISCOVERY_MAX_LISTINGS_PER_COMPANY": "80",
            "AUTO_DISCOVERY_TOP_CANDIDATES_PER_COMPANY": "50",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            limits = DiscoveryLimits.from_env()
        self.assertEqual(limits.max_companies, 4)
        self.assertEqual(limits.max_listings_per_company, 80)
        self.assertEqual(limits.top_candidates_per_company, 5)
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(DiscoveryLimits.from_env(max_companies_override=3).max_companies, 3)


class ProfileIdentityTests(unittest.TestCase):
    def test_active_profile_is_legacy_generation(self):
        identity = ProfileIdentity(PROFILE.profile_id or "", PROFILE.profile_version or "")
        self.assertEqual(identity.profile_id, "jay")
        self.assertEqual(identity.profile_version, LEGACY_PROFILE_VERSION)
        self.assertTrue(identity.is_legacy_generation)
        self.assertEqual(identity.evaluation_seed_suffix(), "")

    def test_legacy_ids_are_unchanged_and_new_versions_get_new_ids(self):
        c = cand(1, description="d", description_hash="0123456789abcdef")
        legacy_seed = f"gpt-fit-v2|{c.source}|{c.external_job_id}|{c.url}|{c.description_hash}"
        legacy_id = str(uuid.uuid5(uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8"), legacy_seed))
        pipeline = AutomaticDiscoveryPipeline(FakeStore(), provider=FakeProvider())  # type: ignore[arg-type]
        self.assertEqual(pipeline._idempotent_client_id(c), legacy_id)

        v2 = PROFILE.__class__(**{**PROFILE.__dict__, "profile_version": "jay-ai-v2"})
        pipeline_v2 = AutomaticDiscoveryPipeline(
            FakeStore(), provider=FakeProvider(), profile=v2  # type: ignore[arg-type]
        )
        self.assertNotEqual(pipeline_v2._idempotent_client_id(c), legacy_id)
        self.assertIn("|profile:jay:jay-ai-v2", pipeline_v2._fingerprint(c))

    def test_matches_stored(self):
        legacy = ProfileIdentity("jay", "jay-ai-v1")
        v2 = ProfileIdentity("jay", "jay-ai-v2")
        self.assertTrue(legacy.matches_stored({"profile_id": None, "profile_version": None}))
        self.assertFalse(v2.matches_stored({"profile_id": None, "profile_version": None}))
        self.assertTrue(v2.matches_stored({"profile_id": "jay", "profile_version": "jay-ai-v2"}))
        self.assertFalse(legacy.matches_stored({"profile_id": "jay", "profile_version": "jay-ai-v2"}))
        self.assertEqual(
            legacy.as_filter(),
            {"profile_id": "jay", "profile_version": "jay-ai-v1", "include_legacy_unversioned": True},
        )
        self.assertFalse(v2.as_filter()["include_legacy_unversioned"])


class CountingAdapter(FakeAdapter):
    def __init__(self, candidates):
        super().__init__(candidates)
        self.fetched: list[str] = []

    def get_job(self, company, candidate):
        self.fetched.append(candidate.client_candidate_id)
        return super().get_job(company, candidate)


class StateStore(FakeStore):
    """FakeStore with the evaluation-state lookup and configurable preflight."""

    def __init__(self, states: dict[str, dict[str, Any]] | None = None,
                 preflight: dict[str, dict[str, Any]] | None = None):
        super().__init__()
        self.states = states or {}
        self.preflight = preflight or {}
        self.submitted_ids: set[str] = set()

    async def check_discovery_candidates(self, payload):
        self.calls.append(("check_discovery_candidates", dict(payload)))
        return {
            "results": [
                {
                    "client_candidate_id": c["client_candidate_id"],
                    "identity_status": "UNSEEN",
                    "previously_applied": False,
                    **self.preflight.get(c["client_candidate_id"], {}),
                }
                for c in payload["candidates"]
            ]
        }

    async def lookup_discovery_evaluation_states(self, payload):
        self.calls.append(("lookup_discovery_evaluation_states", dict(payload)))
        return {
            "states": [
                {
                    "client_candidate_id": c["client_candidate_id"],
                    "evaluation": self.states.get(c["client_candidate_id"]),
                    "submitted_to_inbox": c["client_candidate_id"] in self.submitted_ids,
                }
                for c in payload["candidates"]
            ]
        }


def listings(n: int) -> list[LightweightCandidate]:
    titles = [
        "Senior AI Engineer", "Staff AI Engineer", "Principal AI Engineer",
        "AI Infrastructure Engineer", "Agent Platform Engineer",
        "Senior LLM Platform Engineer", "Generative AI Engineer",
        "Senior Backend Engineer", "Account Executive", "Recruiter",
    ]
    return [cand(i + 1, titles[i % len(titles)]) for i in range(n)]


class TopKPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, store, adapter, **limit_overrides):
        limits = DiscoveryLimits(
            max_companies=1, max_listings_per_company=100, top_candidates_per_company=3,
            max_evals_per_run=10, max_batches_per_run=3, max_jobs_per_batch=5,
        )
        limits = DiscoveryLimits(**{**{f: getattr(limits, f) for f in limits.__dataclass_fields__}, **limit_overrides})
        provider = FakeProvider("ok")
        with mock.patch("job_agent.auto_discovery.pipeline.get_adapter", return_value=adapter):
            metrics = await AutomaticDiscoveryPipeline(
                store, provider=provider, limits=limits  # type: ignore[arg-type]
            ).run()
        return metrics, provider

    async def test_only_top_k_fetched_and_evaluated(self):
        store = StateStore()
        adapter = CountingAdapter(listings(10))
        metrics, provider = await self._run(store, adapter)
        self.assertEqual(len(adapter.fetched), 3)
        self.assertEqual(provider.calls, 3)
        self.assertEqual(metrics.full_descriptions_requested, 3)
        self.assertEqual(metrics.candidates_selected, 3)
        self.assertEqual(metrics.candidates_listed, 10)
        preflight = [p for n, p in store.calls if n == "check_discovery_candidates"][0]
        self.assertEqual(preflight["profile"]["profile_id"], "jay")
        records = [p for n, p in store.calls if n == "record_discovery_evaluations"]
        self.assertTrue(all(r["evaluations"][0]["profile_version"] == "jay-ai-v1" for r in records))

    async def test_listing_breadth_bound_uses_rank_not_ats_order(self):
        store = StateStore()
        items = listings(10)
        adapter = CountingAdapter(list(reversed(items)))
        await self._run(store, adapter, max_listings_per_company=4)
        preflight = [p for n, p in store.calls if n == "check_discovery_candidates"][0]
        self.assertEqual(len(preflight["candidates"]), 4)
        titles = {c["title"] for c in preflight["candidates"]}
        self.assertNotIn("Recruiter", titles)
        self.assertNotIn("Account Executive", titles)

    async def test_unchanged_evidence_skips_fetch_and_llm(self):
        items = listings(4)
        states = {
            c.client_candidate_id: {
                "evaluation_id": f"e{i}", "gpt_decision": "REJECTED_LOW_SCORE",
                "description_hash": "aaaaaaaaaaaaaaaa", "evaluated_at": "2026-09-27T00:00:00Z",
            }
            for i, c in enumerate(items[:3])
        }
        store = StateStore(states=states)
        adapter = CountingAdapter(items)
        metrics, provider = await self._run(store, adapter)
        self.assertEqual(adapter.fetched, [items[3].client_candidate_id])
        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.candidates_unchanged_skipped, 3)

    async def test_preflight_skips_applied_known_and_duplicates(self):
        items = listings(4)
        store = StateStore(preflight={
            items[0].client_candidate_id: {"previously_applied": True, "identity_status": "UPDATED_POSTING"},
            items[1].client_candidate_id: {"identity_status": "KNOWN_UNCHANGED"},
            items[2].client_candidate_id: {"identity_status": "POSSIBLE_CROSS_SOURCE"},
        })
        adapter = CountingAdapter(items)
        metrics, provider = await self._run(store, adapter)
        self.assertEqual(adapter.fetched, [items[3].client_candidate_id])
        self.assertEqual(metrics.candidates_skipped, 3)

    async def test_one_failing_detail_fetch_does_not_fail_company(self):
        items = listings(4)

        class FlakyAdapter(CountingAdapter):
            def get_job(self, company, candidate):
                if candidate.external_job_id == "1":
                    raise AdapterError("gone", category="not_found")
                return super().get_job(company, candidate)

        store = StateStore()
        adapter = FlakyAdapter(items)
        metrics, provider = await self._run(store, adapter, top_candidates_per_company=4)
        self.assertEqual(metrics.companies_failed, 0)
        self.assertEqual(metrics.candidates_selected, 4)
        self.assertEqual(provider.calls, 3)
        self.assertFalse(any(n == "fail_discovery_company_run" for n, _ in store.calls))
        complete = [p for n, p in store.calls if n == "complete_discovery_company_run"][0]
        memory = complete["metrics"][SELECTION_MEMORY_KEY]
        self.assertEqual(memory["greenhouse:1"]["outcome"], OUTCOME_NO_EVIDENCE)

    async def test_max_evals_defers_selected_candidates_without_failure(self):
        store = StateStore()
        adapter = CountingAdapter(listings(10))
        metrics, provider = await self._run(store, adapter, max_evals_per_run=2)
        self.assertEqual(provider.calls, 2)
        self.assertEqual(metrics.companies_failed, 0)
        self.assertEqual(metrics.companies_deferred, 1)
        preserved = [p for n, p in store.calls if n == "preserve_pending_discovery_evaluations"]
        self.assertEqual(len(preserved[0]["items"]), 1)
        complete = [p for n, p in store.calls if n == "complete_discovery_company_run"][0]
        self.assertTrue(complete["deferred"])
        finish = [p for n, p in store.calls if n == "finish_automatic_discovery_run"][0]
        self.assertEqual(finish["status"], "partial")

    async def test_invalid_output_is_remembered_for_rotation(self):
        store = StateStore()
        adapter = CountingAdapter(listings(5))
        limits = DiscoveryLimits(max_companies=1, top_candidates_per_company=3, max_evals_per_run=10)
        with mock.patch("job_agent.auto_discovery.pipeline.get_adapter", return_value=adapter):
            await AutomaticDiscoveryPipeline(
                store, provider=FakeProvider("invalid"), limits=limits  # type: ignore[arg-type]
            ).run()
        complete = [p for n, p in store.calls if n == "complete_discovery_company_run"][0]
        memory = complete["metrics"][SELECTION_MEMORY_KEY]
        self.assertEqual(len(memory), 3)
        self.assertTrue(all(v["outcome"] == OUTCOME_NO_EVIDENCE for v in memory.values()))
        # Next run: those three cool down; the remaining two new candidates lead.
        claimed_stats = {SELECTION_MEMORY_KEY: memory}
        store2 = StateStore()
        original_claim = store2.claim_due_discovery_companies

        async def claim_with_stats(payload=None):
            result = await original_claim(payload)
            result["claims"][0]["company"]["stats"] = claimed_stats
            return result

        store2.claim_due_discovery_companies = claim_with_stats  # type: ignore[method-assign]
        adapter2 = CountingAdapter(listings(5))
        with mock.patch("job_agent.auto_discovery.pipeline.get_adapter", return_value=adapter2):
            await AutomaticDiscoveryPipeline(
                store2, provider=FakeProvider("ok"), limits=limits  # type: ignore[arg-type]
            ).run()
        first_two = set(adapter2.fetched[:2])
        self.assertEqual(len(first_two), 2)
        self.assertFalse(first_two & {f"greenhouse:acme:{k.split(':')[1]}" for k in memory})

    def _qualified_store(self, items, desc, *, submitted: bool, evaluated_at: str):
        from job_agent.memory.fingerprint import compute_description_hash

        store = StateStore(states={items[0].client_candidate_id: {
            "evaluation_id": "eval-q", "gpt_decision": "QUALIFIED",
            "description_hash": compute_description_hash(desc), "evaluated_at": evaluated_at,
        }})
        if submitted:
            store.submitted_ids.add(items[0].client_candidate_id)
        return store

    def _seed_stored_evaluation(self, store, cand, desc):
        from job_agent.memory.fingerprint import compute_description_hash

        full = LightweightCandidate(**{**{f: getattr(cand, f) for f in cand.__slots__},
                                       "description": desc,
                                       "description_hash": compute_description_hash(desc) or ""})
        client_id = AutomaticDiscoveryPipeline(
            store, provider=FakeProvider()  # type: ignore[arg-type]
        )._idempotent_client_id(full)
        store._evaluations_by_client_id[client_id] = {
            "evaluation_id": "eval-q", "client_evaluation_id": client_id,
            "source": full.source, "external_job_id": full.external_job_id,
            "url": full.url, "normalized_url": "", "description_hash": full.description_hash,
            "gpt_relevance_score": 88, "gpt_decision": "QUALIFIED", "evaluation_version": "gpt-fit-v2",
            "remote_scope": "US_NATIONWIDE", "direct_posting_url_verified": True,
            "posting_status": "OPEN", "normalization_version": "fingerprint-v1",
            "posting_status_verified_at": "2026-09-27T00:00:00Z",
        }

    async def test_submitted_qualified_with_moved_update_date_is_not_resubmitted(self):
        items = [cand(1, "Senior AI Engineer", posted=date.today().isoformat())]
        desc = "Build production LLM agents, MCP, and backend platforms."
        store = self._qualified_store(
            items, desc, submitted=True, evaluated_at="2026-01-01T00:00:00Z"
        )
        self._seed_stored_evaluation(store, items[0], desc)
        adapter = CountingAdapter(items)
        metrics, provider = await self._run(store, adapter)
        # Update date moved, so the listing is re-fetched once, but content is identical.
        self.assertEqual(adapter.fetched, [items[0].client_candidate_id])
        self.assertEqual(provider.calls, 0)
        self.assertEqual(metrics.stored_reused, 1)
        self.assertEqual(metrics.batches_submitted, 0)
        complete = [p for n, p in store.calls if n == "complete_discovery_company_run"][0]
        memory = complete["metrics"][SELECTION_MEMORY_KEY]
        self.assertEqual(list(memory.values())[0]["outcome"], OUTCOME_REUSED)

    async def test_qualified_unsubmitted_resubmits_without_llm(self):
        items = listings(1)
        from job_agent.memory.fingerprint import compute_description_hash

        desc = "Build production LLM agents, MCP, and backend platforms."
        store = self._qualified_store(
            items, desc, submitted=False, evaluated_at="2026-09-27T00:00:00Z"
        )
        full = LightweightCandidate(**{**{f: getattr(items[0], f) for f in items[0].__slots__},
                                       "description": desc,
                                       "description_hash": compute_description_hash(desc) or ""})
        pipeline = AutomaticDiscoveryPipeline(store, provider=FakeProvider())  # type: ignore[arg-type]
        client_id = pipeline._idempotent_client_id(full)
        store._evaluations_by_client_id[client_id] = {
            "evaluation_id": "eval-q", "client_evaluation_id": client_id,
            "source": full.source, "external_job_id": full.external_job_id,
            "url": full.url, "normalized_url": "", "description_hash": full.description_hash,
            "gpt_relevance_score": 88, "gpt_decision": "QUALIFIED", "evaluation_version": "gpt-fit-v2",
            "remote_scope": "US_NATIONWIDE", "direct_posting_url_verified": True,
            "posting_status": "OPEN", "normalization_version": "fingerprint-v1",
            "posting_status_verified_at": "2026-09-27T00:00:00Z",
        }
        adapter = CountingAdapter(items)
        metrics, provider = await self._run(store, adapter)
        self.assertEqual(provider.calls, 0)
        self.assertEqual(metrics.batches_submitted, 1)
        self.assertEqual(metrics.stored_reused, 1)


class SafeHttpClientBoundsTests(unittest.TestCase):
    def test_response_size_bound(self):
        transport = httpx.MockTransport(lambda req: httpx.Response(200, content=b"x" * 5000))
        client = SafeHttpClient(transport=transport, max_response_bytes=2048, max_retries=0)
        with self.assertRaises(AdapterError) as ctx:
            client.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs")
        self.assertEqual(ctx.exception.category, "validation")
        self.assertLessEqual(client.stats["bytes_downloaded"], 2048)

    def test_streamed_body_without_length_is_bounded(self):
        def stream():
            for _ in range(10):
                yield b"x" * 1024

        transport = httpx.MockTransport(lambda req: httpx.Response(200, content=stream()))
        client = SafeHttpClient(transport=transport, max_response_bytes=2048, max_retries=0)
        with self.assertRaises(AdapterError):
            client.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs")
        self.assertLessEqual(client.stats["bytes_downloaded"], 4096)

    def test_redirects_are_revalidated_and_bounded(self):
        def handler(req: httpx.Request) -> httpx.Response:
            if req.url.host == "boards-api.greenhouse.io":
                return httpx.Response(302, headers={"Location": "https://169.254.169.254/latest"})
            return httpx.Response(200, json={})

        client = SafeHttpClient(transport=httpx.MockTransport(handler), max_retries=0)
        with self.assertRaises(Exception):
            client.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs")

        loop = httpx.MockTransport(
            lambda req: httpx.Response(302, headers={"Location": "/v1/boards/acme/jobs"})
        )
        looping = SafeHttpClient(transport=loop, max_retries=0, max_redirects=2)
        with self.assertRaises(AdapterError):
            looping.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs")
        self.assertEqual(looping.stats["redirects"], 2)

    def test_counts_requests_rate_limits_and_retries(self):
        responses = iter([httpx.Response(429, headers={"Retry-After": "0"}), httpx.Response(200, json={"jobs": []})])
        client = SafeHttpClient(transport=httpx.MockTransport(lambda req: next(responses)), max_retries=1)
        client.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs")
        self.assertEqual(client.stats["requests"], 2)
        self.assertEqual(client.stats["rate_limited"], 1)
        self.assertEqual(client.stats["retries"], 1)


if __name__ == "__main__":
    unittest.main()
