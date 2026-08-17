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
from .prompt import build_discovery_prompt

__all__ = [
    "DiscoveryConfigError",
    "DiscoveryError",
    "DiscoveryValidationError",
    "JobDiscoveryClient",
    "OpenAIDiscoveryClient",
    "OpenAIDiscoveryConfig",
    "build_discovery_prompt",
    "validate_discovery_payload",
]
