from __future__ import annotations

from typing import Any

from ..models.types import DuplicateResult, JobFingerprint, JobInput
from ..memory.client import MemoryStore
from ..memory.fingerprint import (
    normalize_company_key,
    normalize_description_text,
    normalize_title_key,
)
from ..lifecycle.url import normalize_url
from ..utils.normalization import (
    extract_keyword_set,
    extract_role_family,
    extract_skill_set,
    normalize_location,
)

AUTOMATIC_DUPLICATE_THRESHOLD = 90.0
POSSIBLE_DUPLICATE_THRESHOLD = 70.0


class DuplicateDetector:
    """Posting-level duplicate detection.

    Automatic duplicates are posting-identity matches only:
    - same normalized URL
    - same source + external_job_id

    description_hash is a similarity/canonical signal only — never auto-discard.
    Same company + normalized title is a canonical-role signal, not discard.
    """

    def __init__(self, memory_store: MemoryStore):
        self.memory_store = memory_store

    async def check_duplicate(self, job_input: JobInput) -> DuplicateResult:
        current_fingerprint = JobFingerprint.from_job_input(job_input)
        history = await self.memory_store.get_history()

        if not history:
            return DuplicateResult(
                is_duplicate=False,
                confidence_score=0.0,
                matched_job_id=None,
                reason="no history available",
            )

        exact_result = self._check_exact_matches(current_fingerprint, job_input, history)
        if exact_result.is_duplicate or exact_result.possible_canonical_match:
            return exact_result

        return self._check_similarity(current_fingerprint, history)

    def _check_exact_matches(
        self,
        fingerprint: JobFingerprint,
        job_input: JobInput,
        history: list[dict[str, Any]],
    ) -> DuplicateResult:
        candidate_url = normalize_url(fingerprint.url)
        candidate_external = job_input.external_job_id or _external_from_metadata(job_input)

        for item in history:
            item_url = normalize_url(item.get("url") or item.get("normalized_url"))
            item_description_hash = item.get("description_hash")
            item_source = item.get("source")
            item_external = item.get("external_job_id")

            if candidate_url and item_url and candidate_url == item_url:
                return DuplicateResult(
                    is_duplicate=True,
                    confidence_score=100.0,
                    matched_job_id=item.get("id"),
                    reason="same URL",
                )

            if (
                candidate_external
                and item_external
                and job_input.source
                and item_source == job_input.source
                and candidate_external == item_external
            ):
                return DuplicateResult(
                    is_duplicate=True,
                    confidence_score=100.0,
                    matched_job_id=item.get("id"),
                    reason="same source and external_job_id",
                )

            if (
                fingerprint.description_hash
                and item_description_hash
                and fingerprint.description_hash == item_description_hash
            ):
                # Similarity signal only — lifecycle decides REPOST vs NEW_JOB.
                return DuplicateResult(
                    is_duplicate=False,
                    confidence_score=90.0,
                    matched_job_id=item.get("id"),
                    reason="same description hash (similarity signal; not auto-discard)",
                    possible_canonical_match=True,
                )

            item_company = item.get("company") or item.get("company_name") or ""
            item_title = item.get("title") or item.get("canonical_title") or ""
            if (
                fingerprint.company_key == normalize_company_key(item_company)
                and fingerprint.normalized_title == normalize_title_key(item_title)
            ):
                return DuplicateResult(
                    is_duplicate=False,
                    confidence_score=85.0,
                    matched_job_id=item.get("id"),
                    reason="same company and normalized title (canonical match; not auto-discard)",
                    possible_canonical_match=True,
                )

        return DuplicateResult(
            is_duplicate=False,
            confidence_score=0.0,
            matched_job_id=None,
            reason="no exact match",
        )

    def _check_similarity(
        self,
        fingerprint: JobFingerprint,
        history: list[dict[str, Any]],
    ) -> DuplicateResult:
        best_result = DuplicateResult(
            is_duplicate=False,
            confidence_score=0.0,
            matched_job_id=None,
            reason="no similar job found",
        )

        for item in history:
            existing_fingerprint = JobFingerprint(
                company_name=item.get("company", ""),
                company_key=normalize_company_key(item.get("company", "")),
                title=item.get("title", ""),
                normalized_title=normalize_title_key(item.get("title", "")),
                role_family=extract_role_family(item.get("title", "")),
                keyword_set=frozenset(
                    extract_keyword_set(item.get("title", ""), item.get("description"))
                ),
                skill_set=frozenset(
                    extract_skill_set(item.get("title", ""), item.get("description"))
                ),
                location_key=normalize_location(item.get("location")),
                description_hash=item.get("description_hash"),
                normalized_description=normalize_description_text(item.get("description")),
                url=item.get("url"),
            )

            score = self._calculate_similarity(fingerprint, existing_fingerprint)
            if score <= best_result.confidence_score:
                continue

            same_company = fingerprint.company_key == existing_fingerprint.company_key
            matched_job_id = item.get("id") if same_company else None
            reason = self._describe_similarity(fingerprint, existing_fingerprint, score)

            best_result = DuplicateResult(
                is_duplicate=False,
                confidence_score=round(score, 2),
                matched_job_id=matched_job_id,
                reason=reason,
                possible_canonical_match=same_company and score >= POSSIBLE_DUPLICATE_THRESHOLD,
            )

        return best_result

    def _describe_similarity(
        self,
        candidate: JobFingerprint,
        existing: JobFingerprint,
        score: float,
    ) -> str:
        same_company = candidate.company_key == existing.company_key
        if score >= AUTOMATIC_DUPLICATE_THRESHOLD:
            return "high similarity within company (canonical signal; not auto-discard)"
        if score >= POSSIBLE_DUPLICATE_THRESHOLD:
            if same_company:
                return "possible duplicate within same company"
            return "possible duplicate across companies"
        return "no duplicate signal"

    def _calculate_similarity(
        self,
        candidate: JobFingerprint,
        existing: JobFingerprint,
    ) -> float:
        score = 0.0

        if candidate.company_key == existing.company_key:
            score += 35.0

        if (
            candidate.role_family
            and existing.role_family
            and candidate.role_family == existing.role_family
        ):
            score += 20.0

        score += 25.0 * self._text_similarity(
            candidate.normalized_title,
            existing.normalized_title,
        )
        score += 20.0 * self._text_similarity(
            candidate.normalized_description,
            existing.normalized_description,
        )

        return min(score, 100.0)

    def _text_similarity(self, left: str | None, right: str | None) -> float:
        if not left or not right:
            return 0.0

        left_tokens = set(left.split())
        right_tokens = set(right.split())
        if not left_tokens or not right_tokens:
            return 0.0

        return len(left_tokens & right_tokens) / max(len(left_tokens), len(right_tokens))


def _external_from_metadata(job_input: JobInput) -> str | None:
    if not job_input.metadata:
        return None
    for key in (
        "external_job_id",
        "external_id",
        "job_id",
        "greenhouse_id",
        "lever_id",
        "ashby_id",
        "linkedin_job_id",
    ):
        value = job_input.metadata.get(key)
        if value:
            return str(value).strip()
    return None
