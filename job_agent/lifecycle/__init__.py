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
from .application_service import ApplicationService
from .process import process_discovered_job
from .queries import LifecycleQueryService

__all__ = [
    "PostingDisposition",
    "LifecycleClassification",
    "PersistencePlan",
    "DiscoveredJobResult",
    "NormalizedLifecyclePosting",
    "PostingLifecycleClassifier",
    "CanonicalJobResolver",
    "ApplicationService",
    "process_discovered_job",
    "LifecycleQueryService",
]
