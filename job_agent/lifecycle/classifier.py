from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .similarity import (
    CANONICAL_MATCH_THRESHOLD,
    CanonicalJobSimilarityScorer,
    CanonicalSimilarityResult,
)
from .types import (
    LifecycleClassification,
    NormalizedLifecyclePosting,
    PostingDisposition,
    parse_iso_date,
    parse_iso_datetime,
)

# Minimum calendar-day gap between previous posting date (or first_seen) and a
# newly discovered posted_date / discovery time to count as a time-gap signal.
REPOST_MIN_GAP_DAYS = 14

# Description similarity below this (with weak lifecycle signals) => NEW_JOB.
CLEARLY_DIFFERENT_DESCRIPTION_THRESHOLD = 0.20

# Role-family mismatch + description below this => NEW_JOB.
ROLE_FAMILY_DESC_MISMATCH_THRESHOLD = 0.35

CLOSED_POSTING_STATUSES = frozenset(
    {"closed", "expired", "removed", "inactive", "filled"},
)


class PostingLifecycleClassifier:
    """Deterministic SAME_POSTING / REPOST / NEW_JOB classifier.

    Posting identity is ONLY:
      - same normalized URL, or
      - same source + external_job_id

    description_hash is never posting identity.
    Canonical role matching uses CanonicalJobSimilarityScorer (not match_score).
    """

    def __init__(
        self,
        min_gap_days: int = REPOST_MIN_GAP_DAYS,
        similarity_scorer: CanonicalJobSimilarityScorer | None = None,
        canonical_match_threshold: float = CANONICAL_MATCH_THRESHOLD,
    ):
        self.min_gap_days = min_gap_days
        self.similarity_scorer = similarity_scorer or CanonicalJobSimilarityScorer()
        self.canonical_match_threshold = canonical_match_threshold

    def classify(
        self,
        candidate: NormalizedLifecyclePosting,
        existing_postings: list[dict[str, Any]],
        existing_canonicals: list[dict[str, Any]] | None = None,
    ) -> LifecycleClassification:
        same = self._find_same_posting(candidate, existing_postings)
        if same is not None:
            return LifecycleClassification(
                disposition=PostingDisposition.SAME_POSTING,
                reason=same["reason"],
                signals=same["signals"],
                canonical_job_id=_as_str(same["posting"].get("canonical_job_id")),
                previous_posting_id=_as_str(same["posting"].get("id")),
                matched_posting=same["posting"],
            )

        canonical_match = self._find_best_canonical_match(
            candidate,
            existing_postings,
            existing_canonicals or [],
        )
        if canonical_match is None:
            return LifecycleClassification(
                disposition=PostingDisposition.NEW_JOB,
                reason="no confident canonical match",
                signals=["no_confident_canonical_match"],
            )

        similarity: CanonicalSimilarityResult = canonical_match["similarity"]
        previous = canonical_match["previous_posting"]
        signals = list(canonical_match["signals"])
        identity_signals = self._different_posting_identity(candidate, previous)
        signals.extend(identity_signals)

        base_kwargs = {
            "canonical_job_id": _as_str(canonical_match["canonical_job_id"]),
            "previous_posting_id": _as_str(previous.get("id")) if previous else None,
            "matched_posting": previous,
            "matched_canonical": canonical_match.get("canonical"),
            "canonical_similarity_score": similarity.canonical_similarity_score,
            "canonical_similarity_signals": dict(similarity.signals),
        }

        if not identity_signals:
            return LifecycleClassification(
                disposition=PostingDisposition.SAME_POSTING,
                reason="canonical match with identical posting identity fields",
                signals=signals + ["identity_indistinguishable"],
                **base_kwargs,
            )

        supporting = self._repost_supporting_signals(candidate, previous, similarity)
        signals.extend(supporting)

        if self._clearly_different_role(candidate, previous, similarity, supporting):
            return LifecycleClassification(
                disposition=PostingDisposition.NEW_JOB,
                reason=(
                    "canonical candidates exist but responsibilities diverge; "
                    "treating as new job"
                ),
                signals=signals + ["clearly_different_role"],
                canonical_job_id=None,
                previous_posting_id=base_kwargs["previous_posting_id"],
                matched_posting=previous,
                matched_canonical=canonical_match.get("canonical"),
                canonical_similarity_score=similarity.canonical_similarity_score,
                canonical_similarity_signals=dict(similarity.signals),
            )

        if supporting:
            return LifecycleClassification(
                disposition=PostingDisposition.REPOST,
                reason=(
                    "confident canonical match with different posting identity "
                    "and supporting lifecycle signals"
                ),
                signals=signals,
                **base_kwargs,
            )

        return LifecycleClassification(
            disposition=PostingDisposition.NEW_JOB,
            reason=(
                "confident canonical match but insufficient repost signals; "
                "treating as new job"
            ),
            signals=signals + ["insufficient_repost_signals"],
            canonical_similarity_score=similarity.canonical_similarity_score,
            canonical_similarity_signals=dict(similarity.signals),
        )

    def _find_same_posting(
        self,
        candidate: NormalizedLifecyclePosting,
        existing_postings: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        if candidate.normalized_url:
            for posting in existing_postings:
                existing_url = posting.get("normalized_url") or _normalize_existing_url(
                    posting.get("url")
                )
                if existing_url and existing_url == candidate.normalized_url:
                    return {
                        "posting": posting,
                        "reason": "same normalized URL",
                        "signals": ["same_normalized_url"],
                    }

        if candidate.source and candidate.external_job_id:
            for posting in existing_postings:
                if (
                    posting.get("source") == candidate.source
                    and posting.get("external_job_id") == candidate.external_job_id
                ):
                    return {
                        "posting": posting,
                        "reason": "same source and external_job_id",
                        "signals": ["same_source_external_job_id"],
                    }
        return None

    def _find_best_canonical_match(
        self,
        candidate: NormalizedLifecyclePosting,
        existing_postings: list[dict[str, Any]],
        existing_canonicals: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Score same-company canonical candidates; pick best above threshold."""
        best: dict[str, Any] | None = None
        best_score = -1.0

        # Prefer explicit canonical rows (indexed company lookup).
        for canonical in existing_canonicals:
            if canonical.get("company_key") != candidate.company_key:
                continue
            previous = self._latest_posting_for_canonical(
                existing_postings,
                _as_str(canonical.get("id")),
            )
            role_payload = _role_payload_from_canonical(canonical, previous)
            similarity = self.similarity_scorer.score(candidate, role_payload)
            if similarity.canonical_similarity_score < self.canonical_match_threshold:
                continue
            if similarity.canonical_similarity_score > best_score:
                best_score = similarity.canonical_similarity_score
                best = {
                    "canonical_job_id": canonical.get("id"),
                    "canonical": canonical,
                    "previous_posting": previous,
                    "similarity": similarity,
                    "signals": [
                        "company_key_lookup",
                        f"canonical_similarity>={self.canonical_match_threshold}",
                    ],
                }

        # Also score enriched postings that carry company/title/description.
        for posting in existing_postings:
            company_key = posting.get("company_key") or _company_key_from_posting(posting)
            if not company_key or company_key != candidate.company_key:
                continue
            similarity = self.similarity_scorer.score(candidate, posting)
            if similarity.canonical_similarity_score < self.canonical_match_threshold:
                continue
            if similarity.canonical_similarity_score > best_score:
                best_score = similarity.canonical_similarity_score
                best = {
                    "canonical_job_id": posting.get("canonical_job_id") or posting.get("id"),
                    "canonical": None,
                    "previous_posting": posting,
                    "similarity": similarity,
                    "signals": [
                        "same_company_posting_candidate",
                        f"canonical_similarity>={self.canonical_match_threshold}",
                    ],
                }

        return best

    def _latest_posting_for_canonical(
        self,
        postings: list[dict[str, Any]],
        canonical_job_id: str | None,
    ) -> dict[str, Any] | None:
        if not canonical_job_id:
            return None
        matches = [
            p for p in postings if _as_str(p.get("canonical_job_id")) == canonical_job_id
        ]
        if not matches:
            return None

        def sort_key(p: dict[str, Any]) -> datetime:
            return (
                parse_iso_datetime(p.get("posted_date"))
                or parse_iso_datetime(p.get("last_seen_at"))
                or parse_iso_datetime(p.get("first_seen_at"))
                or datetime.min.replace(tzinfo=timezone.utc)
            )

        return max(matches, key=sort_key)

    def _different_posting_identity(
        self,
        candidate: NormalizedLifecyclePosting,
        previous: dict[str, Any] | None,
    ) -> list[str]:
        if previous is None:
            return ["no_previous_posting"]
        signals: list[str] = []
        prev_ext = previous.get("external_job_id")
        if candidate.external_job_id and prev_ext and candidate.external_job_id != prev_ext:
            signals.append("different_external_job_id")
        elif candidate.external_job_id and not prev_ext:
            signals.append("new_external_job_id")
        elif prev_ext and not candidate.external_job_id:
            signals.append("missing_external_job_id_on_candidate")

        prev_url = previous.get("normalized_url") or _normalize_existing_url(previous.get("url"))
        if (
            candidate.normalized_url
            and prev_url
            and candidate.normalized_url != prev_url
        ):
            signals.append("different_normalized_url")
        elif candidate.normalized_url and not prev_url:
            signals.append("new_normalized_url")
        return signals

    def _repost_supporting_signals(
        self,
        candidate: NormalizedLifecyclePosting,
        previous: dict[str, Any] | None,
        similarity: CanonicalSimilarityResult,
    ) -> list[str]:
        if previous is None:
            return []
        signals: list[str] = []

        prev_posted = parse_iso_date(previous.get("posted_date"))
        if candidate.posted_date and prev_posted and candidate.posted_date != prev_posted:
            signals.append("new_posted_date")
            if (candidate.posted_date - prev_posted).days >= self.min_gap_days:
                signals.append("meaningful_time_gap")

        prev_seen = parse_iso_date(previous.get("first_seen_at")) or parse_iso_date(
            previous.get("last_seen_at")
        )
        if candidate.posted_date and prev_seen:
            if (candidate.posted_date - prev_seen).days >= self.min_gap_days:
                if "meaningful_time_gap" not in signals:
                    signals.append("meaningful_time_gap")

        status = str(previous.get("posting_status") or previous.get("status") or "").lower()
        if status in CLOSED_POSTING_STATUSES:
            signals.append("previous_posting_closed")

        prev_hash = previous.get("description_hash")
        if (
            candidate.description_hash
            and prev_hash
            and candidate.description_hash == prev_hash
        ):
            # Identical JD text supports REPOST; never SAME_POSTING by itself.
            signals.append("identical_description")
        elif (
            candidate.description_hash
            and prev_hash
            and candidate.description_hash != prev_hash
        ):
            signals.append("description_changed")

        desc_sim = float(similarity.signals.get("description_similarity") or 0.0)
        if desc_sim >= 0.85 and "identical_description" not in signals:
            signals.append("high_description_similarity")

        if candidate.external_job_id and previous.get("external_job_id"):
            if candidate.external_job_id != previous.get("external_job_id"):
                signals.append("source_reports_new_posting_id")

        return signals

    def _clearly_different_role(
        self,
        candidate: NormalizedLifecyclePosting,
        previous: dict[str, Any] | None,
        similarity: CanonicalSimilarityResult,
        supporting: list[str],
    ) -> bool:
        if previous is None:
            return False

        desc_sim = float(similarity.signals.get("description_similarity") or 0.0)
        role_match = bool(similarity.signals.get("role_family_match"))

        if not role_match and desc_sim < ROLE_FAMILY_DESC_MISMATCH_THRESHOLD:
            return True

        strong = any(
            s in supporting
            for s in (
                "source_reports_new_posting_id",
                "meaningful_time_gap",
                "previous_posting_closed",
                "identical_description",
                "new_posted_date",
            )
        )
        if desc_sim < CLEARLY_DIFFERENT_DESCRIPTION_THRESHOLD and not strong:
            return True

        return False


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _normalize_existing_url(url: Any) -> str | None:
    from .url import normalize_url

    return normalize_url(str(url) if url else None)


def _company_key_from_posting(posting: dict[str, Any]) -> str | None:
    from ..memory.fingerprint import normalize_company_key

    company = posting.get("company") or posting.get("company_name")
    return normalize_company_key(company) if company else None


def _role_payload_from_canonical(
    canonical: dict[str, Any],
    previous: dict[str, Any] | None,
) -> dict[str, Any]:
    payload = {
        "company": canonical.get("company"),
        "company_key": canonical.get("company_key"),
        "title": canonical.get("title"),
        "normalized_title": canonical.get("normalized_title"),
        "role_family": canonical.get("role_family"),
        "location": canonical.get("location"),
        "normalized_location": canonical.get("normalized_location"),
        "description": None,
        "description_hash": None,
    }
    if previous:
        payload["description"] = previous.get("description")
        payload["description_hash"] = previous.get("description_hash")
        payload.setdefault("location", previous.get("location"))
        if previous.get("role_family"):
            payload["role_family"] = previous.get("role_family")
    return payload
