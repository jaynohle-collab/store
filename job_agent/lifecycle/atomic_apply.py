"""Build MCP apply_discovery_batch_job_persistence payloads from Python decisions.

Python owns classify/score decisions. MCP owns atomic persistence + provenance.

Optional Zod fields *inside* create_canonical / create_posting / update_posting /
evaluation use ``.optional()`` (not ``.nullable()``). JSON ``null`` is rejected for
those paths. Top-level apply fields and ``before_state`` may be nullable; see
``sanitize_apply_discovery_batch_job_persistence_payload``.
"""

from __future__ import annotations

import copy
import re
import uuid
from datetime import date, datetime, timezone
from typing import Any

from .evaluation_service import PROFILE_VERSION, SCORING_VERSION
from .types import DiscoveredJobResult

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Nested objects whose child fields are Zod `.optional()` (not `.nullable()`).
_APPLY_OPTIONAL_OBJECT_KEYS = frozenset(
    {
        "create_canonical",
        "create_posting",
        "update_posting",
        "evaluation",
    }
)

# Provenance snapshots: nested JSON nulls are meaningful and must be preserved.
_APPLY_PRESERVE_NESTED_NULLS_KEYS = frozenset({"before_state", "after_state"})


def is_valid_uuid(value: Any) -> bool:
    if value is None:
        return False
    text = str(value).strip()
    if not text or not _UUID_RE.match(text):
        return False
    try:
        uuid.UUID(text)
    except (TypeError, ValueError, AttributeError):
        return False
    return True


def format_posted_date(value: Any) -> str | None:
    """Return a value accepted by MCP ``z.iso.date() | z.iso.datetime({offset:true})``.

    Returns ``None`` for missing/blank values so callers omit the optional field.
    Returns ``None`` for malformed values as well — prefer
    ``coerce_optional_posted_date`` when a present value must fail closed locally.
    Naive datetimes are rejected — Zod requires an offset for datetime values.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return None
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    if not text:
        return None
    # YYYY-MM-DD (z.iso.date)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        try:
            date.fromisoformat(text)
            return text
        except ValueError:
            return None
    # Offset datetime (z.iso.datetime({ offset: true }))
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.isoformat()


def coerce_optional_posted_date(value: Any, *, field: str = "posted_date") -> str | None:
    """Omit blank/missing posted_date; raise if a non-blank value is malformed.

    Fails locally before any MCP request so Zod never sees an invalid date string.
    """
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    formatted = format_posted_date(value)
    if formatted is None:
        raise ValueError(
            f"{field} must be YYYY-MM-DD or an offset ISO datetime "
            f"(got {value!r})"
        )
    return formatted


def optional_nonempty_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def omit_none(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop keys whose values are None (shallow). Does not mutate ``payload``."""
    return {key: value for key, value in payload.items() if value is not None}


def deep_omit_none(value: Any) -> Any:
    """Recursively omit ``None`` from dicts/lists for apply nested objects.

    Semantics (apply-payload helper only — do not use for arbitrary MCP tools):
    - Does **not** mutate the input; returns a new structure.
    - Preserves ``False``, ``0``, ``""``, ``[]``, ``{}``.
    - Dict keys whose value is ``None`` are omitted.
    - List elements that are ``None`` are dropped (not encoded as JSON null).
      Apply payloads do not intentionally use null list slots; dropping is the
      documented contract so Zod never sees JSON null in nested optional fields.
    - Recurses into nested dicts and into dicts/lists inside lists.
    """
    if isinstance(value, dict):
        return {
            key: deep_omit_none(item)
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, list):
        return [deep_omit_none(item) for item in value if item is not None]
    return value


def _require_uuid_field(value: Any, *, field: str) -> str:
    if not is_valid_uuid(value):
        raise ValueError(f"{field} must be a UUID (got {value!r})")
    return str(value).strip()


def _validate_apply_nested_objects(out: dict[str, Any]) -> None:
    """Fail closed on present-but-invalid dates/UUIDs before MCP."""
    if "touch_canonical_id" in out:
        out["touch_canonical_id"] = _require_uuid_field(
            out["touch_canonical_id"], field="touch_canonical_id"
        )

    create_posting = out.get("create_posting")
    if isinstance(create_posting, dict):
        if "posted_date" in create_posting:
            create_posting["posted_date"] = coerce_optional_posted_date(
                create_posting["posted_date"],
                field="create_posting.posted_date",
            )
            if create_posting["posted_date"] is None:
                del create_posting["posted_date"]
        if "supersedes_posting_id" in create_posting:
            create_posting["supersedes_posting_id"] = _require_uuid_field(
                create_posting["supersedes_posting_id"],
                field="create_posting.supersedes_posting_id",
            )
        if "canonical_job_id" in create_posting:
            create_posting["canonical_job_id"] = _require_uuid_field(
                create_posting["canonical_job_id"],
                field="create_posting.canonical_job_id",
            )
        use_new = bool(create_posting.get("use_new_canonical"))
        if not use_new and "canonical_job_id" not in create_posting:
            raise ValueError(
                "create_posting.canonical_job_id is required when "
                "use_new_canonical is false"
            )

    update_posting = out.get("update_posting")
    if isinstance(update_posting, dict):
        if "id" in update_posting:
            update_posting["id"] = _require_uuid_field(
                update_posting["id"], field="update_posting.id"
            )
        if "posted_date" in update_posting:
            update_posting["posted_date"] = coerce_optional_posted_date(
                update_posting["posted_date"],
                field="update_posting.posted_date",
            )
            if update_posting["posted_date"] is None:
                del update_posting["posted_date"]

    evaluation = out.get("evaluation")
    if isinstance(evaluation, dict) and "posting_id" in evaluation:
        evaluation["posting_id"] = _require_uuid_field(
            evaluation["posting_id"], field="evaluation.posting_id"
        )


def sanitize_apply_discovery_batch_job_persistence_payload(
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Sanitize a payload for ``apply_discovery_batch_job_persistence`` only.

    Scoped deliberately: other MCP tools may intentionally send JSON null.
    Does not mutate ``payload``.
    """
    if not isinstance(payload, dict):
        raise TypeError(
            "apply_discovery_batch_job_persistence payload must be an object"
        )

    out: dict[str, Any] = {}
    for key, value in payload.items():
        if key in _APPLY_PRESERVE_NESTED_NULLS_KEYS:
            if value is None:
                # Top-level null is allowed by Zod (.nullable()) but omitting is
                # equivalent for optional fields and keeps the wire payload smaller.
                continue
            out[key] = copy.deepcopy(value)
            continue
        if value is None:
            continue
        if key in _APPLY_OPTIONAL_OBJECT_KEYS and isinstance(value, dict):
            out[key] = deep_omit_none(value)
            continue
        if isinstance(value, dict):
            # Top-level metadata and similar records: omit null entries only.
            out[key] = deep_omit_none(value)
            continue
        if isinstance(value, list):
            out[key] = deep_omit_none(value)
            continue
        out[key] = value
    _validate_apply_nested_objects(out)
    return out


def build_atomic_apply_fields(
    result: DiscoveredJobResult,
    *,
    recommendation: str,
    reason: str,
    score_breakdown: dict[str, Any] | None = None,
    scoring_version: str = SCORING_VERSION,
    profile_version: str = PROFILE_VERSION,
) -> dict[str, Any]:
    """Translate a non-persisted lifecycle result into worker apply fields."""
    plan = result.persistence_plan
    posting = result.posting
    fields: dict[str, Any] = {}

    if plan.create_canonical:
        create_canonical = omit_none(
            {
                "company": posting.company,
                "company_key": posting.company_key,
                "title": posting.title,
                "normalized_title": posting.normalized_title,
                "location": optional_nonempty_str(posting.location),
                "normalized_location": optional_nonempty_str(
                    posting.normalized_location
                ),
                "role_family": optional_nonempty_str(posting.role_family),
            }
        )
        fields["create_canonical"] = create_canonical

    if plan.touch_canonical_id and not plan.create_canonical:
        if is_valid_uuid(plan.touch_canonical_id):
            fields["touch_canonical_id"] = str(plan.touch_canonical_id).strip()

    if plan.create_posting:
        create_posting: dict[str, Any] = {
            "use_new_canonical": bool(plan.create_canonical),
            "posting_status": "active",
            "is_repost": bool(plan.is_repost),
        }
        source = optional_nonempty_str(posting.source)
        if source is not None:
            create_posting["source"] = source
        external_job_id = optional_nonempty_str(posting.external_job_id)
        if external_job_id is not None:
            create_posting["external_job_id"] = external_job_id
        url = optional_nonempty_str(posting.url)
        if url is not None:
            create_posting["url"] = url
        normalized_url = optional_nonempty_str(posting.normalized_url)
        if normalized_url is not None:
            create_posting["normalized_url"] = normalized_url
        if posting.description is not None:
            create_posting["description"] = posting.description
        description_hash = optional_nonempty_str(posting.description_hash)
        if description_hash is not None:
            create_posting["description_hash"] = description_hash
        location = optional_nonempty_str(posting.location)
        if location is not None:
            create_posting["location"] = location
        remote_status = optional_nonempty_str(posting.remote_status)
        if remote_status is not None:
            create_posting["remote_status"] = remote_status
        salary = optional_nonempty_str(posting.salary)
        if salary is not None:
            create_posting["salary"] = salary
        posted_date = coerce_optional_posted_date(
            posting.posted_date, field="create_posting.posted_date"
        )
        if posted_date is not None:
            create_posting["posted_date"] = posted_date
        # Optional supersedes: omit blank/invalid; do not send JSON null.
        if is_valid_uuid(plan.supersedes_posting_id):
            create_posting["supersedes_posting_id"] = str(
                plan.supersedes_posting_id
            ).strip()
        elif plan.supersedes_posting_id not in (None, ""):
            text = str(plan.supersedes_posting_id).strip()
            if text:
                raise ValueError(
                    "create_posting.supersedes_posting_id must be a UUID "
                    f"(got {plan.supersedes_posting_id!r})"
                )
        if not plan.create_canonical:
            create_posting["canonical_job_id"] = _require_uuid_field(
                plan.touch_canonical_id,
                field="create_posting.canonical_job_id",
            )
        fields["create_posting"] = create_posting

    if plan.update_posting_id:
        if not is_valid_uuid(plan.update_posting_id):
            raise ValueError("update_posting_id must be a UUID")
        update_posting: dict[str, Any] = {
            "id": str(plan.update_posting_id).strip(),
            "last_seen_at": datetime.now(timezone.utc).isoformat(),
        }
        if posting.description is not None:
            update_posting["description"] = posting.description
        description_hash = optional_nonempty_str(posting.description_hash)
        if description_hash is not None:
            update_posting["description_hash"] = description_hash
        location = optional_nonempty_str(posting.location)
        if location is not None:
            update_posting["location"] = location
        remote_status = optional_nonempty_str(posting.remote_status)
        if remote_status is not None:
            update_posting["remote_status"] = remote_status
        salary = optional_nonempty_str(posting.salary)
        if salary is not None:
            update_posting["salary"] = salary
        posted_date = coerce_optional_posted_date(
            posting.posted_date, field="update_posting.posted_date"
        )
        if posted_date is not None:
            update_posting["posted_date"] = posted_date
        url = optional_nonempty_str(posting.url)
        if url is not None:
            update_posting["url"] = url
        normalized_url = optional_nonempty_str(posting.normalized_url)
        if normalized_url is not None:
            update_posting["normalized_url"] = normalized_url
        fields["update_posting"] = update_posting

    # Persist profile-v1 evaluation atomically with the posting when mutating.
    if plan.create_posting or plan.update_posting_id:
        eval_metadata: dict[str, Any] = {
            "disposition": plan.disposition.value,
        }
        if result.classification.canonical_similarity_score is not None:
            eval_metadata["canonical_similarity_score"] = (
                result.classification.canonical_similarity_score
            )
        if score_breakdown is not None:
            eval_metadata["score_breakdown"] = score_breakdown
        evaluation: dict[str, Any] = {
            "use_resolved_posting": True,
            "recommendation": recommendation,
            "reason": reason,
            "scoring_version": scoring_version,
            "profile_version": profile_version,
            "metadata": eval_metadata,
            "evaluated_at": datetime.now(timezone.utc).isoformat(),
        }
        if result.match_score is not None:
            evaluation["match_score"] = result.match_score
        fields["evaluation"] = evaluation

    return fields
