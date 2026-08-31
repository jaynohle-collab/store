"""ATS adapter protocol."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from job_agent.auto_discovery.http_client import SafeHttpClient
from job_agent.auto_discovery.types import CompanyRecord, LightweightCandidate


@runtime_checkable
class AtsAdapter(Protocol):
    """Official ATS / careers adapter. Implementations must not scrape aggregators."""

    provider: str

    def list_jobs(self, company: CompanyRecord) -> list[LightweightCandidate]:
        """Return lightweight candidates (no full JD required)."""

    def get_job(
        self, company: CompanyRecord, candidate: LightweightCandidate
    ) -> LightweightCandidate:
        """Fetch full posting detail including description when available."""


class BaseAtsAdapter:
    """Shared constructor for injectable HTTP transport."""

    provider: str = "base"

    def __init__(self, http: SafeHttpClient | None = None):
        self.http = http or SafeHttpClient()
        self._owns_http = http is None

    def close(self) -> None:
        if self._owns_http:
            self.http.close()
