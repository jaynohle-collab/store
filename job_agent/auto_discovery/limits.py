"""Discovery run limit helpers (env-bounded).

Listing breadth, per-company selection, LLM budget and company fan-out are
separate limits:

* ``max_listings_per_company`` — lightweight listings fetched/ranked per company.
* ``top_candidates_per_company`` — best-ranked listings selected for full
  description fetch + evaluation (3–5 in normal use).
* ``max_evals_per_run`` — new LLM evaluations across the whole run.
* ``max_companies`` — companies claimed per run.

Legacy variables stay supported: ``AUTO_DISCOVERY_MAX_COMPANIES`` and
``AUTO_DISCOVERY_MAX_CANDIDATES_PER_COMPANY`` (listing breadth) are used when
the newer names are unset.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int_env(
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int,
    fallback_names: tuple[str, ...] = (),
) -> int:
    value = default
    for candidate in (name, *fallback_names):
        raw = (os.environ.get(candidate) or "").strip()
        if not raw:
            continue
        try:
            value = int(raw)
        except ValueError:
            continue
        break
    return max(minimum, min(maximum, value))


@dataclass(frozen=True, slots=True)
class DiscoveryLimits:
    max_companies: int = 5
    max_listings_per_company: int = 100
    top_candidates_per_company: int = 5
    max_evals_per_run: int = 15
    max_batches_per_run: int = 3
    max_jobs_per_batch: int = 5
    # Listings scoring below this lightweight profile rank are never selected.
    min_rank_score: int = 20
    preflight_chunk_size: int = 100
    eval_record_chunk_size: int = 50
    max_response_bytes: int = 16 * 1024 * 1024
    max_verifications_per_run: int = 5

    @property
    def max_candidates_per_company(self) -> int:
        """Legacy name for listing breadth."""
        return self.max_listings_per_company

    @classmethod
    def from_env(cls, *, max_companies_override: int | None = None) -> "DiscoveryLimits":
        max_companies = (
            max_companies_override
            if max_companies_override is not None
            else _int_env(
                "AUTO_DISCOVERY_MAX_COMPANIES_PER_RUN",
                5,
                minimum=1,
                maximum=50,
                fallback_names=("AUTO_DISCOVERY_MAX_COMPANIES",),
            )
        )
        return cls(
            max_companies=max(1, min(50, max_companies)),
            max_listings_per_company=_int_env(
                "AUTO_DISCOVERY_MAX_LISTINGS_PER_COMPANY",
                100,
                minimum=1,
                maximum=500,
                fallback_names=("AUTO_DISCOVERY_MAX_CANDIDATES_PER_COMPANY",),
            ),
            top_candidates_per_company=_int_env(
                "AUTO_DISCOVERY_TOP_CANDIDATES_PER_COMPANY", 5, minimum=1, maximum=5
            ),
            max_evals_per_run=_int_env(
                "AUTO_DISCOVERY_MAX_EVALS_PER_RUN", 15, minimum=1, maximum=200
            ),
            max_batches_per_run=_int_env(
                "AUTO_DISCOVERY_MAX_BATCHES_PER_RUN", 3, minimum=1, maximum=50
            ),
            max_jobs_per_batch=_int_env(
                "AUTO_DISCOVERY_MAX_JOBS_PER_BATCH", 5, minimum=1, maximum=100
            ),
            min_rank_score=_int_env(
                "AUTO_DISCOVERY_MIN_RANK_SCORE", 20, minimum=0, maximum=100
            ),
            preflight_chunk_size=_int_env(
                "AUTO_DISCOVERY_PREFLIGHT_CHUNK", 100, minimum=1, maximum=100
            ),
            eval_record_chunk_size=_int_env(
                "AUTO_DISCOVERY_EVAL_CHUNK", 50, minimum=1, maximum=100
            ),
            max_response_bytes=_int_env(
                "AUTO_DISCOVERY_MAX_RESPONSE_BYTES",
                16 * 1024 * 1024,
                minimum=64 * 1024,
                maximum=64 * 1024 * 1024,
            ),
            max_verifications_per_run=_int_env(
                "AUTO_DISCOVERY_MAX_VERIFICATIONS_PER_RUN", 5, minimum=0, maximum=20
            ),
        )
