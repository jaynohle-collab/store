"""LLM evaluation package for automatic discovery."""

from job_agent.auto_discovery.evaluate.gpt_fit_v2 import (
    EVALUATION_VERSION,
    GPT_FIT_V2_JSON_SCHEMA,
    InvalidModelOutputError,
    evaluate_candidate,
    validate_model_output,
)
from job_agent.auto_discovery.evaluate.providers import (
    AllProvidersUnavailableError,
    EvaluationProvider,
    FallbackEvaluationProvider,
    GeminiProvider,
    GroqProvider,
    OpenAIProvider,
    QuotaExhaustedError,
    configured_providers,
    resolve_provider,
)

__all__ = [
    "AllProvidersUnavailableError",
    "EVALUATION_VERSION",
    "EvaluationProvider",
    "FallbackEvaluationProvider",
    "GPT_FIT_V2_JSON_SCHEMA",
    "GeminiProvider",
    "GroqProvider",
    "InvalidModelOutputError",
    "OpenAIProvider",
    "QuotaExhaustedError",
    "configured_providers",
    "evaluate_candidate",
    "resolve_provider",
    "validate_model_output",
]
