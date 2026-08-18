"""OpenAI-powered job discovery (raw JSON only — no scoring or persistence)."""

from .openai_discovery import (
    DiscoveryConfigError,
    DiscoveryError,
    DiscoveryValidationError,
    JobDiscoveryClient,
    OpenAIDiscoveryClient,
    OpenAIDiscoveryConfig,
    validate_discovery_payload,
)
from .inbox import DiscoveryInboxStore, InMemoryDiscoveryInboxStore
from .prompt import (
    DEFAULT_DISCOVERY_TIME_ZONE,
    build_discovery_prompt,
    resolve_discovery_calendar_date,
)

__all__ = [
    "DEFAULT_DISCOVERY_TIME_ZONE",
    "DiscoveryConfigError",
    "DiscoveryError",
    "DiscoveryInboxStore",
    "DiscoveryValidationError",
    "InMemoryDiscoveryInboxStore",
    "JobDiscoveryClient",
    "OpenAIDiscoveryClient",
    "OpenAIDiscoveryConfig",
    "build_discovery_prompt",
    "resolve_discovery_calendar_date",
    "validate_discovery_payload",
]
