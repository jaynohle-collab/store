from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol


class ApplicationStore(Protocol):
    async def record_application(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    async def get_application(self, application_id: str) -> dict[str, Any] | None: ...
    async def list_applications(self, **filters: Any) -> list[dict[str, Any]]: ...
    async def update_application_status(self, payload: dict[str, Any]) -> dict[str, Any] | None: ...
    async def add_application_event(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    async def list_application_events(self, application_id: str) -> list[dict[str, Any]]: ...


class ApplicationService:
    """Application tracking attached to a specific posting_id."""

    def __init__(self, store: ApplicationStore):
        self.store = store

    async def record_application(
        self,
        *,
        canonical_job_id: str,
        posting_id: str,
        status: str = "applied",
        applied_at: str | None = None,
        application_url: str | None = None,
        resume_version: str | None = None,
        cover_letter_version: str | None = None,
        notes: str | None = None,
        create_applied_event: bool = True,
    ) -> dict[str, Any]:
        application = await self.store.record_application(
            {
                "canonical_job_id": canonical_job_id,
                "posting_id": posting_id,
                "status": status,
                "applied_at": applied_at or datetime.now(timezone.utc).isoformat(),
                "application_url": application_url,
                "resume_version": resume_version,
                "cover_letter_version": cover_letter_version,
                "notes": notes,
            }
        )
        if create_applied_event and status == "applied":
            await self.add_event(
                application_id=str(application["id"]),
                event_type="applied",
                event_at=application.get("applied_at"),
                notes=notes,
            )
        return application

    async def update_status(
        self,
        application_id: str,
        status: str,
        notes: str | None = None,
        add_event: bool = True,
    ) -> dict[str, Any] | None:
        application = await self.store.update_application_status(
            {
                "id": application_id,
                "status": status,
                "notes": notes,
            }
        )
        if application and add_event:
            await self.add_event(
                application_id=application_id,
                event_type=status,
                notes=notes,
            )
        return application

    async def add_event(
        self,
        *,
        application_id: str,
        event_type: str,
        event_at: str | None = None,
        notes: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self.store.add_application_event(
            {
                "application_id": application_id,
                "event_type": event_type,
                "event_at": event_at or datetime.now(timezone.utc).isoformat(),
                "notes": notes,
                "metadata": metadata or {},
            }
        )

    async def get_application(self, application_id: str) -> dict[str, Any] | None:
        return await self.store.get_application(application_id)

    async def list_for_posting(self, posting_id: str) -> list[dict[str, Any]]:
        return await self.store.list_applications(posting_id=posting_id)

    async def list_for_canonical(self, canonical_job_id: str) -> list[dict[str, Any]]:
        return await self.store.list_applications(canonical_job_id=canonical_job_id)

    async def has_application_for_posting(self, posting_id: str) -> bool:
        rows = await self.list_for_posting(posting_id)
        return bool(rows)

    async def prior_applications_on_canonical(
        self,
        canonical_job_id: str,
        *,
        excluding_posting_id: str | None = None,
    ) -> list[dict[str, Any]]:
        rows = await self.list_for_canonical(canonical_job_id)
        if excluding_posting_id is None:
            return rows
        return [row for row in rows if str(row.get("posting_id")) != excluding_posting_id]
