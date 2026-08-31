"""Discovery run limit helpers (env-bounded)."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int_env(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        value = default
    else:
        try:
            value = int(raw)
        except ValueError:
            value = default
    return max(minimum, min(maximum, value))


@dataclass(frozen=True, slots=True)
class DiscoveryLimits:
    max_companies: int = 10
    max_candidates_per_company: int = 100
    max_evals_per_run: int = 50
    max_batches_per_run: int = 10
    max_jobs_per_batch: int = 25
    preflight_chunk_size: int = 100
    eval_record_chunk_size: int = 50

    @classmethod
    def from_env(cls, *, max_companies_override: int | None = None) -> "DiscoveryLimits":
        max_companies = (
            max_companies_override
            if max_companies_override is not None
            else _int_env("AUTO_DISCOVERY_MAX_COMPANIES", 10, minimum=1, maximum=50)
        )
        return cls(
            max_companies=max(1, min(50, max_companies)),
            max_candidates_per_company=_int_env(
                "AUTO_DISCOVERY_MAX_CANDIDATES_PER_COMPANY", 100, minimum=1, maximum=500
            ),
            max_evals_per_run=_int_env(
                "AUTO_DISCOVERY_MAX_EVALS_PER_RUN", 50, minimum=1, maximum=200
            ),
            max_batches_per_run=_int_env(
                "AUTO_DISCOVERY_MAX_BATCHES_PER_RUN", 10, minimum=1, maximum=50
            ),
            max_jobs_per_batch=_int_env(
                "AUTO_DISCOVERY_MAX_JOBS_PER_BATCH", 25, minimum=1, maximum=100
            ),
            preflight_chunk_size=_int_env(
                "AUTO_DISCOVERY_PREFLIGHT_CHUNK", 100, minimum=1, maximum=100
            ),
            eval_record_chunk_size=_int_env(
                "AUTO_DISCOVERY_EVAL_CHUNK", 50, minimum=1, maximum=100
            ),
        )
