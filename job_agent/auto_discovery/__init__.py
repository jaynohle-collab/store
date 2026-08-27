"""Automatic ATS discovery producer (Milestone 5).

Owns official-API adapters + gpt-fit-v2 evaluation. MCP owns identity,
evidence storage, and inbox submission contracts.
"""

from .pipeline import AutomaticDiscoveryPipeline
from .types import AdapterError, CompanyRecord, LightweightCandidate, RunMetrics

__all__ = [
    "AdapterError",
    "AutomaticDiscoveryPipeline",
    "CompanyRecord",
    "LightweightCandidate",
    "RunMetrics",
]
