from __future__ import annotations
from dataclasses import dataclass
from typing import Protocol

from ..models.types import JobSearchProfile, NormalizedJobPosting


class ScoreCalculator(Protocol):
    def score(self, posting: NormalizedJobPosting, profile: JobSearchProfile) -> float:
        """Score a normalized posting against the search profile."""


@dataclass
class SimpleScoreCalculator:
    """Baseline scoring implementation for job match quality."""

    def score(self, posting: NormalizedJobPosting, profile: JobSearchProfile) -> float:
        score = 0.0
        if profile.location and posting.location:
            score += 10.0 if profile.location.lower() == posting.location.lower() else 0.0
        if profile.keywords:
            keyword_matches = sum(
                1 for keyword in profile.keywords if keyword.lower() in posting.title.lower() or keyword.lower() in (posting.description or "").lower()
            )
            score += float(keyword_matches) * 2.0
        if posting.remote:
            score += 5.0
        return score
