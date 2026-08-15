"""Canonical-job similarity — independent of candidate match_score."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..memory.fingerprint import (
    description_similarity,
    normalize_company_key,
    normalize_description_text,
    normalize_title_key,
    title_similarity,
    token_overlap,
)
from ..utils.normalization import (
    extract_keyword_set,
    extract_role_family,
    extract_skill_set,
    normalize_location,
)
from .types import NormalizedLifecyclePosting

# ---------------------------------------------------------------------------
# Named thresholds / weights (do not scatter magic numbers)
# ---------------------------------------------------------------------------

# Minimum score to treat a same-company role as the same canonical job.
CANONICAL_MATCH_THRESHOLD = 0.80

# Stronger confidence band (debugging / future dashboard).
CANONICAL_HIGH_CONFIDENCE_THRESHOLD = 0.90

# Soft signal: identical description_hash boosts description similarity to 1.0
# but never establishes posting identity by itself.

# Weighted contributions when company_match is True. Sum == 1.0.
WEIGHT_TITLE = 0.30
WEIGHT_ROLE_FAMILY = 0.15
WEIGHT_SKILL = 0.15
WEIGHT_KEYWORD = 0.15
WEIGHT_DESCRIPTION = 0.20
WEIGHT_LOCATION = 0.05

assert abs(
    WEIGHT_TITLE
    + WEIGHT_ROLE_FAMILY
    + WEIGHT_SKILL
    + WEIGHT_KEYWORD
    + WEIGHT_DESCRIPTION
    + WEIGHT_LOCATION
    - 1.0
) < 1e-9


@dataclass
class CanonicalSimilarityResult:
    canonical_similarity_score: float
    signals: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "canonical_similarity_score": self.canonical_similarity_score,
            "signals": dict(self.signals),
        }

    @property
    def is_confident_match(self) -> bool:
        return (
            bool(self.signals.get("company_match"))
            and self.canonical_similarity_score >= CANONICAL_MATCH_THRESHOLD
        )


class CanonicalJobSimilarityScorer:
    """Score whether two postings/roles are the same underlying company role.

    Company identity is a hard gate: different company_key => score 0.
    Never uses candidate/resume profile data. Never uses match_score.
    """

    def score(
        self,
        candidate: NormalizedLifecyclePosting,
        other: dict[str, Any] | NormalizedLifecyclePosting,
    ) -> CanonicalSimilarityResult:
        other_view = _as_role_view(other)

        company_match = bool(
            candidate.company_key
            and other_view["company_key"]
            and candidate.company_key == other_view["company_key"]
        )
        if not company_match:
            return CanonicalSimilarityResult(
                canonical_similarity_score=0.0,
                signals={
                    "company_match": False,
                    "title_similarity": 0.0,
                    "role_family_match": False,
                    "skill_similarity": 0.0,
                    "keyword_similarity": 0.0,
                    "description_similarity": 0.0,
                    "location_similarity": 0.0,
                },
            )

        title_sim = title_similarity(
            candidate.normalized_title,
            other_view["normalized_title"],
        )

        cand_family = candidate.role_family or extract_role_family(candidate.title)
        other_family = other_view["role_family"] or extract_role_family(
            other_view["title"] or ""
        )
        role_family_match = bool(
            cand_family and other_family and cand_family == other_family
        )

        cand_skills = extract_skill_set(candidate.title, candidate.description)
        other_skills = other_view["skill_set"] or extract_skill_set(
            other_view["title"] or "",
            other_view["description"],
        )
        skill_sim = _jaccard(cand_skills, other_skills)

        cand_keywords = extract_keyword_set(candidate.title, candidate.description)
        other_keywords = other_view["keyword_set"] or extract_keyword_set(
            other_view["title"] or "",
            other_view["description"],
        )
        keyword_sim = _jaccard(cand_keywords, other_keywords)

        if (
            candidate.description_hash
            and other_view["description_hash"]
            and candidate.description_hash == other_view["description_hash"]
        ):
            desc_sim = 1.0
        else:
            desc_sim = description_similarity(
                normalize_description_text(candidate.description),
                normalize_description_text(other_view["description"]),
            )

        loc_sim = 0.0
        if candidate.normalized_location and other_view["normalized_location"]:
            if candidate.normalized_location == other_view["normalized_location"]:
                loc_sim = 1.0
            else:
                loc_sim = token_overlap(
                    candidate.normalized_location,
                    other_view["normalized_location"],
                )

        score = (
            WEIGHT_TITLE * title_sim
            + WEIGHT_ROLE_FAMILY * (1.0 if role_family_match else 0.0)
            + WEIGHT_SKILL * skill_sim
            + WEIGHT_KEYWORD * keyword_sim
            + WEIGHT_DESCRIPTION * desc_sim
            + WEIGHT_LOCATION * loc_sim
        )

        return CanonicalSimilarityResult(
            canonical_similarity_score=round(min(score, 1.0), 4),
            signals={
                "company_match": True,
                "title_similarity": round(title_sim, 4),
                "role_family_match": role_family_match,
                "skill_similarity": round(skill_sim, 4),
                "keyword_similarity": round(keyword_sim, 4),
                "description_similarity": round(desc_sim, 4),
                "location_similarity": round(loc_sim, 4),
            },
        )


def _jaccard(left: set[str] | frozenset[str], right: set[str] | frozenset[str]) -> float:
    if not left and not right:
        return 0.0
    if not left or not right:
        return 0.0
    union = left | right
    if not union:
        return 0.0
    return len(left & right) / len(union)


def _as_role_view(other: dict[str, Any] | NormalizedLifecyclePosting) -> dict[str, Any]:
    if isinstance(other, NormalizedLifecyclePosting):
        return {
            "company_key": other.company_key,
            "title": other.title,
            "normalized_title": other.normalized_title,
            "role_family": other.role_family,
            "description": other.description,
            "description_hash": other.description_hash,
            "normalized_location": other.normalized_location,
            "skill_set": None,
            "keyword_set": None,
        }

    company = other.get("company") or other.get("company_name") or ""
    title = other.get("title") or other.get("canonical_title") or ""
    company_key = other.get("company_key") or (
        normalize_company_key(company) if company else ""
    )
    normalized_title = other.get("normalized_title") or (
        normalize_title_key(title) if title else ""
    )
    location = other.get("location") or other.get("normalized_location")
    return {
        "company_key": company_key,
        "title": title,
        "normalized_title": normalized_title,
        "role_family": other.get("role_family"),
        "description": other.get("description"),
        "description_hash": other.get("description_hash"),
        "normalized_location": other.get("normalized_location")
        or normalize_location(location if isinstance(location, str) else None),
        "skill_set": other.get("skill_set"),
        "keyword_set": other.get("keyword_set"),
    }
