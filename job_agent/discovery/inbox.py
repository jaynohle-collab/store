"""In-memory raw discovery inbox for unit tests (no network)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Protocol

from .openai_discovery import validate_discovery_payload


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _id() -> str:
    return str(uuid.uuid4())


class DiscoveryInboxStore(Protocol):
    async def submit_discovery_batch(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    async def get_discovery_batch(self, batch_id: str) -> dict[str, Any] | None: ...
    async def list_pending_discovery_batches(self, limit: int = 20) -> list[dict[str, Any]]: ...
    async def claim_discovery_batch(self, batch_id: str | None = None) -> dict[str, Any] | None: ...
    async def complete_discovery_batch(self, batch_id: str) -> dict[str, Any] | None: ...
    async def fail_discovery_batch(self, batch_id: str, error: str) -> dict[str, Any] | None: ...


class InMemoryDiscoveryInboxStore:
    """Deterministic inbox used by unit tests. Never contacts MCP/Neon."""

    def __init__(self, *, max_jobs: int = 100) -> None:
        self.batches: dict[str, dict[str, Any]] = {}
        self.max_jobs = max_jobs

    async def submit_discovery_batch(self, payload: dict[str, Any]) -> dict[str, Any]:
        jobs_payload = validate_discovery_payload(
            {"jobs": payload.get("jobs")},
            max_jobs=self.max_jobs,
        )
        source = str(payload.get("source") or "chatgpt")
        metadata = payload.get("metadata") or {}
        if not isinstance(metadata, dict):
            raise ValueError("metadata must be an object")
        row = {
            "id": _id(),
            "source": source,
            "status": "pending",
            "payload": jobs_payload,
            "job_count": len(jobs_payload["jobs"]),
            "submitted_at": _now(),
            "processing_started_at": None,
            "processed_at": None,
            "error": None,
            "metadata": dict(metadata),
            "created_at": _now(),
            "updated_at": _now(),
        }
        self.batches[row["id"]] = row
        return dict(row)

    async def get_discovery_batch(self, batch_id: str) -> dict[str, Any] | None:
        row = self.batches.get(batch_id)
        return dict(row) if row else None

    async def list_pending_discovery_batches(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self.batches.values()
            if row.get("status") == "pending"
        ]
        rows.sort(key=lambda r: str(r.get("submitted_at") or ""))
        return rows[:limit]

    async def claim_discovery_batch(self, batch_id: str | None = None) -> dict[str, Any] | None:
        if batch_id:
            row = self.batches.get(batch_id)
            if not row or row.get("status") != "pending":
                return None
            return self._mark_processing(row)

        pending = await self.list_pending_discovery_batches(limit=1)
        if not pending:
            return None
        row = self.batches[pending[0]["id"]]
        if row.get("status") != "pending":
            return None
        return self._mark_processing(row)

    async def complete_discovery_batch(self, batch_id: str) -> dict[str, Any] | None:
        row = self.batches.get(batch_id)
        if not row or row.get("status") != "processing":
            return None
        row["status"] = "completed"
        row["processed_at"] = _now()
        row["updated_at"] = _now()
        return dict(row)

    async def fail_discovery_batch(self, batch_id: str, error: str) -> dict[str, Any] | None:
        row = self.batches.get(batch_id)
        if not row or row.get("status") != "processing":
            return None
        row["status"] = "failed"
        row["processed_at"] = _now()
        row["error"] = error
        row["updated_at"] = _now()
        return dict(row)

    def _mark_processing(self, row: dict[str, Any]) -> dict[str, Any]:
        row["status"] = "processing"
        row["processing_started_at"] = _now()
        row["updated_at"] = _now()
        return dict(row)
