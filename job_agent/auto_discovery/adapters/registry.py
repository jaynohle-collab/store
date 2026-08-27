"""Adapter registry."""

from __future__ import annotations

from typing import Callable

import httpx

from job_agent.auto_discovery.adapters.ashby import AshbyAdapter
from job_agent.auto_discovery.adapters.base import AtsAdapter, BaseAtsAdapter
from job_agent.auto_discovery.adapters.company_careers import CompanyCareersAdapter
from job_agent.auto_discovery.adapters.greenhouse import GreenhouseAdapter
from job_agent.auto_discovery.adapters.lever import LeverAdapter
from job_agent.auto_discovery.adapters.workday import WorkdayAdapter
from job_agent.auto_discovery.http_client import SafeHttpClient
from job_agent.auto_discovery.types import AdapterError

_FACTORY: dict[str, Callable[[SafeHttpClient | None], BaseAtsAdapter]] = {
    "greenhouse": GreenhouseAdapter,
    "ashby": AshbyAdapter,
    "lever": LeverAdapter,
    "workday": WorkdayAdapter,
    "company_careers": CompanyCareersAdapter,
}


def get_adapter(
    provider: str,
    *,
    http: SafeHttpClient | None = None,
    transport: httpx.BaseTransport | None = None,
) -> AtsAdapter:
    """Return an ATS adapter for ``provider``.

    ``transport`` is injectable for tests (httpx MockTransport).
    """
    key = (provider or "").strip().lower()
    factory = _FACTORY.get(key)
    if factory is None:
        raise AdapterError(
            f"unsupported ats_provider: {provider}",
            category="validation",
        )
    client = http
    if client is None and transport is not None:
        client = SafeHttpClient(transport=transport)
    return factory(client)


def supported_providers() -> frozenset[str]:
    return frozenset(_FACTORY)
