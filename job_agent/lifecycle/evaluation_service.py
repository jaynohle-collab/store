"""Persist Python-owned candidate match evaluations (not canonical similarity)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol

SCORING_VERSION = "simple-v1"
PROFILE_VERSION = "default-v1"


class EvaluationStore(Protocol):
    async def save_job_evaluation(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    async def get_latest_job_evaluation(self, posting_id: str) -> dict[str, Any] | None: ...
    async def list_job_evaluations(self, posting_id: str, limit: int = 50) -> list[dict[str, Any]]: ...


class EvaluationService:
    """Write candidate match evaluations produced by the Python ranking layer."""

    def __init__(
        self,
        store: EvaluationStore,
        *,
        scoring_version: str = SCORING_VERSION,
        profile_version: str = PROFILE_VERSION,
    ):
        self.store = store
        self.scoring_version = scoring_version
        self.profile_version = profile_version

    async def persist_evaluation(
        self,
        *,
        posting_id: str,
        match_score: float | None,
        recommendation: str,
        reason: str,
        metadata: dict[str, Any] | None = None,
        evaluated_at: str | None = None,
    ) -> dict[str, Any]:
        return await self.store.save_job_evaluation(
            {
                "posting_id": posting_id,
                "match_score": match_score,
                "recommendation": recommendation,
                "reason": reason,
                "scoring_version": self.scoring_version,
                "profile_version": self.profile_version,
                "metadata": metadata or {},
                "evaluated_at": evaluated_at or datetime.now(timezone.utc).isoformat(),
            }
        )
