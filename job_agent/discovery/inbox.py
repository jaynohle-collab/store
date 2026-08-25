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
    async def claim_discovery_batch(
        self,
        batch_id: str | None = None,
        *,
        worker_identity: str = "worker",
    ) -> dict[str, Any] | None: ...
    async def complete_discovery_batch(
        self, batch_id: str, attempt_id: str
    ) -> dict[str, Any] | None: ...
    async def fail_discovery_batch(
        self, batch_id: str, error: str, attempt_id: str
    ) -> dict[str, Any] | None: ...
    async def apply_discovery_batch_job_persistence(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]: ...
    async def recover_stale_discovery_batch_claims(
        self, limit: int = 20
    ) -> dict[str, Any]: ...


class InMemoryDiscoveryInboxStore:
    """Deterministic inbox used by unit tests. Never contacts MCP/Neon."""

    def __init__(self, *, max_jobs: int = 100, stale_minutes: int = 60) -> None:
        self.batches: dict[str, dict[str, Any]] = {}
        self.effects: dict[str, list[dict[str, Any]]] = {}
        self.attempts: dict[str, dict[str, Any]] = {}
        self.revert_events: list[dict[str, Any]] = []
        self.max_jobs = max_jobs
        self.stale_minutes = stale_minutes
        self._effect_seq = 0
        # Optional InMemoryLifecycleStore used by unit tests to mirror Neon apply.
        self.lifecycle_backend: Any | None = None

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
            "active_attempt_id": None,
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

    async def claim_discovery_batch(
        self,
        batch_id: str | None = None,
        *,
        worker_identity: str = "worker",
    ) -> dict[str, Any] | None:
        if batch_id:
            row = self.batches.get(batch_id)
            if not row or row.get("status") != "pending":
                return None
            return self._mark_processing(row, worker_identity)

        pending = await self.list_pending_discovery_batches(limit=1)
        if not pending:
            return None
        row = self.batches[pending[0]["id"]]
        if row.get("status") != "pending":
            return None
        return self._mark_processing(row, worker_identity)

    async def complete_discovery_batch(
        self, batch_id: str, attempt_id: str
    ) -> dict[str, Any] | None:
        row = self.batches.get(batch_id)
        attempt = self.attempts.get(attempt_id)
        if (
            not row
            or not attempt
            or row.get("status") != "processing"
            or row.get("active_attempt_id") != attempt_id
            or attempt.get("status") != "claimed"
        ):
            return None
        row["status"] = "completed"
        row["processed_at"] = _now()
        row["updated_at"] = _now()
        row["active_attempt_id"] = None
        attempt["status"] = "completed"
        attempt["completed_at"] = _now()
        return dict(row)

    async def fail_discovery_batch(
        self, batch_id: str, error: str, attempt_id: str
    ) -> dict[str, Any] | None:
        row = self.batches.get(batch_id)
        attempt = self.attempts.get(attempt_id)
        if (
            not row
            or not attempt
            or row.get("status") != "processing"
            or row.get("active_attempt_id") != attempt_id
            or attempt.get("status") != "claimed"
        ):
            return None
        row["status"] = "failed"
        row["processed_at"] = _now()
        row["error"] = error
        row["updated_at"] = _now()
        row["active_attempt_id"] = None
        attempt["status"] = "failed"
        attempt["sanitized_error"] = error
        attempt["completed_at"] = _now()
        return dict(row)

    async def apply_discovery_batch_job_persistence(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]:
        batch_id = str(payload["batch_id"])
        attempt_id = str(payload["attempt_id"])
        batch = self.batches.get(batch_id)
        attempt = self.attempts.get(attempt_id)
        if not batch or not attempt:
            raise ValueError("attempt_ownership_lost_or_invalid")
        if (
            batch.get("status") != "processing"
            or batch.get("active_attempt_id") != attempt_id
            or attempt.get("status") != "claimed"
        ):
            raise ValueError("attempt_ownership_lost_or_invalid")

        key = str(payload["idempotency_key"])
        existing = self.effects.setdefault(batch_id, [])
        for prior in existing:
            if prior.get("idempotency_key") == key:
                if prior.get("processing_action") != payload.get("processing_action"):
                    raise ValueError("conflicting_provenance_action")
                return {
                    "ok": True,
                    "idempotent_replay": True,
                    "effect": dict(prior),
                    "canonical_job": {"id": prior.get("canonical_job_id")}
                    if prior.get("canonical_job_id")
                    else None,
                    "job_posting": {"id": prior.get("posting_id")}
                    if prior.get("posting_id")
                    else None,
                    "evaluation": None,
                }

        will_mutate = any(
            payload.get(k)
            for k in (
                "create_canonical",
                "touch_canonical_id",
                "create_posting",
                "update_posting",
                "evaluation",
            )
        )
        if will_mutate:
            attempt["mutation_started"] = True

        self._effect_seq += 1
        posting_id = None
        canonical_id = payload.get("touch_canonical_id")
        backend = self.lifecycle_backend
        if backend is not None and will_mutate:
            if payload.get("create_canonical"):
                canonical = await backend.save_canonical_job(dict(payload["create_canonical"]))
                canonical_id = canonical.get("id")
            elif payload.get("touch_canonical_id"):
                touched = await backend.touch_canonical_job(
                    str(payload["touch_canonical_id"])
                )
                canonical_id = (touched or {}).get("id") or payload.get("touch_canonical_id")
            if payload.get("create_posting"):
                create_posting = dict(payload["create_posting"])
                if create_posting.pop("use_new_canonical", False) and canonical_id:
                    create_posting["canonical_job_id"] = canonical_id
                posting = await backend.save_job_posting(create_posting)
                posting_id = posting.get("id")
            elif payload.get("update_posting"):
                posting = await backend.update_job_posting(dict(payload["update_posting"]))
                posting_id = (posting or {}).get("id")
            if payload.get("evaluation") and posting_id:
                evaluation = dict(payload["evaluation"])
                evaluation.pop("use_resolved_posting", None)
                evaluation["posting_id"] = posting_id
                await backend.save_job_evaluation(evaluation)
        else:
            if payload.get("create_canonical"):
                canonical_id = _id()
            if payload.get("create_posting") or payload.get("update_posting"):
                posting_id = (
                    (payload.get("update_posting") or {}).get("id")
                    if payload.get("update_posting")
                    else _id()
                )
        effect = {
            "id": f"effect-{self._effect_seq}",
            "batch_id": batch_id,
            "attempt_id": attempt_id,
            "input_index": int(payload["input_index"]),
            "idempotency_key": key,
            "processing_action": payload.get("processing_action"),
            "created_canonical": bool(payload.get("create_canonical")),
            "created_posting": bool(payload.get("create_posting")),
            "canonical_job_id": canonical_id,
            "posting_id": posting_id,
            "before_state": payload.get("before_state"),
            "after_state": {"id": posting_id} if posting_id else None,
            "created_at": _now(),
        }
        existing.append(effect)
        return {
            "ok": True,
            "idempotent_replay": False,
            "effect": dict(effect),
            "canonical_job": {"id": canonical_id} if canonical_id else None,
            "job_posting": {"id": posting_id} if posting_id else None,
            "evaluation": None,
        }

    async def recover_stale_discovery_batch_claims(
        self, limit: int = 20
    ) -> dict[str, Any]:
        requeued: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        abandoned: list[str] = []
        for row in list(self.batches.values()):
            if row.get("status") != "processing":
                continue
            if not row.get("_force_stale"):
                continue
            if len(requeued) + len(failed) >= limit:
                break
            batch_id = str(row["id"])
            attempt_id = row.get("active_attempt_id")
            attempt = self.attempts.get(str(attempt_id)) if attempt_id else None
            if attempt and attempt.get("mutation_started") is False:
                attempt["status"] = "abandoned"
                row["status"] = "pending"
                row["processing_started_at"] = None
                row["active_attempt_id"] = None
                row["error"] = None
                abandoned.append(str(attempt_id))
                requeued.append(dict(row))
            else:
                message = (
                    f"stale_processing_claim_timeout after {self.stale_minutes} minutes "
                    "(fail-closed: mutation state uncertain or mutations started; "
                    "operator review required)"
                )
                if attempt:
                    attempt["status"] = "abandoned"
                    attempt["sanitized_error"] = message
                    abandoned.append(str(attempt_id))
                row["status"] = "failed"
                row["processed_at"] = _now()
                row["error"] = message
                row["active_attempt_id"] = None
                failed.append(dict(row))
        return {
            "requeued": requeued,
            "failed": failed,
            "abandoned_attempts": abandoned,
            "stale_after_minutes": self.stale_minutes,
            "policy": "fail_closed_unless_mutation_started_false",
        }

    def _mark_processing(
        self, row: dict[str, Any], worker_identity: str
    ) -> dict[str, Any]:
        attempt_id = _id()
        attempt = {
            "id": attempt_id,
            "batch_id": row["id"],
            "status": "claimed",
            "worker_identity": worker_identity,
            "claimed_at": _now(),
            "heartbeat_at": _now(),
            "mutation_started": False,
            "sanitized_error": None,
            "completed_at": None,
        }
        self.attempts[attempt_id] = attempt
        row["status"] = "processing"
        row["processing_started_at"] = _now()
        row["updated_at"] = _now()
        row["active_attempt_id"] = attempt_id
        out = dict(row)
        out["attempt_id"] = attempt_id
        out["worker_identity"] = worker_identity
        out["mutation_started"] = False
        return out
