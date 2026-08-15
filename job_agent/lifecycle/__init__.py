"""Job lifecycle: posting identity, canonical resolution, applications."""

from .types import (
    PostingDisposition,
    LifecycleClassification,
    PersistencePlan,
    DiscoveredJobResult,
    NormalizedLifecyclePosting,
)
from .classifier import PostingLifecycleClassifier
from .resolver import CanonicalJobResolver
from .application_service import ApplicationService, ApplicationIntegrityError
from .process import process_discovered_job
from .queries import LifecycleQueryService
from .similarity import (
    CanonicalJobSimilarityScorer,
    CanonicalSimilarityResult,
    CANONICAL_MATCH_THRESHOLD,
    CANONICAL_HIGH_CONFIDENCE_THRESHOLD,
)

__all__ = [
    "PostingDisposition",
    "LifecycleClassification",
    "PersistencePlan",
    "DiscoveredJobResult",
    "NormalizedLifecyclePosting",
    "PostingLifecycleClassifier",
    "CanonicalJobResolver",
    "ApplicationService",
    "ApplicationIntegrityError",
    "process_discovered_job",
    "LifecycleQueryService",
    "CanonicalJobSimilarityScorer",
    "CanonicalSimilarityResult",
    "CANONICAL_MATCH_THRESHOLD",
    "CANONICAL_HIGH_CONFIDENCE_THRESHOLD",
]
