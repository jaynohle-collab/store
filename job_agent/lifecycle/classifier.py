from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from ..memory.fingerprint import description_similarity, title_similarity
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

CLOSED_POSTING_STATUSES = frozenset(
    {"closed", "expired", "removed", "inactive", "filled"},
)


class PostingLifecycleClassifier:
    """Deterministic SAME_POSTING / REPOST / NEW_JOB classifier.

    Company+title similarity identifies a *canonical role*, never auto-discards.
    Posting-level identity is URL or (source + external_job_id).
    """

    def __init__(self, min_gap_days: int = REPOST_MIN_GAP_DAYS):
        self.min_gap_days = min_gap_days

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

        canonical_match = self._find_canonical_match(
            candidate,
            existing_postings,
            existing_canonicals or [],
        )
        if canonical_match is None:
            return LifecycleClassification(
                disposition=PostingDisposition.NEW_JOB,
                reason="no confident canonical match",
                signals=["no_company_title_match"],
            )

        previous = canonical_match["previous_posting"]
        signals = list(canonical_match["signals"])
        identity_signals = self._different_posting_identity(candidate, previous)
        signals.extend(identity_signals)

        if not identity_signals:
            # Same company/title but somehow same identity fields — treat as same.
            return LifecycleClassification(
                disposition=PostingDisposition.SAME_POSTING,
                reason="canonical match with identical posting identity fields",
                signals=signals + ["identity_indistinguishable"],
                canonical_job_id=_as_str(canonical_match["canonical_job_id"]),
                previous_posting_id=_as_str(previous.get("id")) if previous else None,
                matched_posting=previous,
                matched_canonical=canonical_match.get("canonical"),
            )

        supporting = self._repost_supporting_signals(candidate, previous)
        signals.extend(supporting)

        if self._clearly_different_role(candidate, previous):
            return LifecycleClassification(
                disposition=PostingDisposition.NEW_JOB,
                reason=(
                    "same company and title tokens but clearly different role/description"
                ),
                signals=signals + ["clearly_different_role"],
                canonical_job_id=None,
                previous_posting_id=_as_str(previous.get("id")) if previous else None,
                matched_posting=previous,
            )

        if supporting:
            return LifecycleClassification(
                disposition=PostingDisposition.REPOST,
                reason=(
                    "same company and normalized role, different posting identity, "
                    "with supporting repost signals"
                ),
                signals=signals,
                canonical_job_id=_as_str(canonical_match["canonical_job_id"]),
                previous_posting_id=_as_str(previous.get("id")) if previous else None,
                matched_posting=previous,
                matched_canonical=canonical_match.get("canonical"),
            )

        # Company+title match + different identity but no supporting signals:
        # do not auto-repost solely on title match.
        return LifecycleClassification(
            disposition=PostingDisposition.NEW_JOB,
            reason=(
                "same company/title candidates exist but insufficient repost signals; "
                "treating as new job"
            ),
            signals=signals + ["insufficient_repost_signals"],
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

    def _find_canonical_match(
        self,
        candidate: NormalizedLifecyclePosting,
        existing_postings: list[dict[str, Any]],
        existing_canonicals: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        for canonical in existing_canonicals:
            if (
                canonical.get("company_key") == candidate.company_key
                and canonical.get("normalized_title") == candidate.normalized_title
            ):
                previous = self._latest_posting_for_canonical(
                    existing_postings,
                    _as_str(canonical.get("id")),
                )
                return {
                    "canonical_job_id": canonical.get("id"),
                    "canonical": canonical,
                    "previous_posting": previous,
                    "signals": ["same_company_key", "same_normalized_title"],
                }

        # Fall back: infer from postings that carry company/title fields.
        best: dict[str, Any] | None = None
        best_score = 0.0
        for posting in existing_postings:
            company_key = posting.get("company_key") or _company_key_from_posting(posting)
            title_key = posting.get("normalized_title") or _title_key_from_posting(posting)
            if not company_key or company_key != candidate.company_key:
                continue
            if title_key == candidate.normalized_title:
                score = 1.0
            else:
                score = title_similarity(candidate.normalized_title, title_key)
                role_family = posting.get("role_family")
                if (
                    candidate.role_family
                    and role_family
                    and candidate.role_family == role_family
                    and score >= 0.85
                ):
                    pass
                elif score < 0.95:
                    continue
            if score > best_score:
                best_score = score
                best = {
                    "canonical_job_id": posting.get("canonical_job_id") or posting.get("id"),
                    "canonical": None,
                    "previous_posting": posting,
                    "signals": ["same_company_key", "title_match_via_posting"],
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
            and candidate.description_hash != prev_hash
        ):
            signals.append("description_changed")

        if candidate.external_job_id and previous.get("external_job_id"):
            if candidate.external_job_id != previous.get("external_job_id"):
                signals.append("source_reports_new_posting_id")

        return signals

    def _clearly_different_role(
        self,
        candidate: NormalizedLifecyclePosting,
        previous: dict[str, Any] | None,
    ) -> bool:
        if previous is None:
            return False

        from ..memory.fingerprint import normalize_description_text

        desc_sim = description_similarity(
            normalize_description_text(candidate.description),
            normalize_description_text(previous.get("description")),
        )

        prev_family = previous.get("role_family")
        if (
            candidate.role_family
            and prev_family
            and candidate.role_family != prev_family
            and desc_sim < 0.35
        ):
            return True

        # Radically different JD without strong repost identity/time signals → NEW_JOB.
        if desc_sim < 0.2:
            strong_repost_identity = False
            prev_ext = previous.get("external_job_id")
            if (
                candidate.external_job_id
                and prev_ext
                and candidate.external_job_id != prev_ext
            ):
                strong_repost_identity = True
            status = str(previous.get("posting_status") or previous.get("status") or "").lower()
            if status in CLOSED_POSTING_STATUSES:
                strong_repost_identity = True
            prev_posted = parse_iso_date(previous.get("posted_date"))
            if candidate.posted_date and prev_posted:
                if (candidate.posted_date - prev_posted).days >= self.min_gap_days:
                    strong_repost_identity = True
            if not strong_repost_identity:
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


def _title_key_from_posting(posting: dict[str, Any]) -> str | None:
    from ..memory.fingerprint import normalize_title_key

    title = posting.get("title") or posting.get("canonical_title")
    return normalize_title_key(title) if title else None
