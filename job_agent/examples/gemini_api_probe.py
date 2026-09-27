"""Manual Gemini API diagnostic used by the gemini-api-probe workflow.

Stages: minimal text → small structured JSON → realistic gpt-fit-v2 request
through the production ``GeminiProvider`` with a synthetic fixture, optionally
at several description sizes (``GEMINI_PROBE_DESCRIPTION_SIZES=2000,20000,80000``).

Read-only against Google Generative Language; never touches MCP or databases.
Never prints the API key, request headers, prompts, job descriptions, or
complete provider payloads.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Callable
from urllib.parse import urlencode

BASE = "https://generativelanguage.googleapis.com/v1beta"
PREFERRED = "gemini-3.6-flash"
# Listed by some keys but rejected for new users; never choose as primary.
DEPRECATED_PRIMARY = "gemini-2.5-flash"
LIST_PAGE_SIZE = 1000
MINIMAL_GENERATE_PAYLOAD = {
    "contents": [
        {
            "role": "user",
            "parts": [{"text": "Reply with exactly: ok"}],
        }
    ]
}
RequestFn = Callable[[str, str, dict | None], tuple[int, str]]


class NetworkProbeError(Exception):
    """Transport failure that must be reported compactly (no traceback)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def sanitize_message(message: str) -> str:
    text = " ".join((message or "").split())
    text = re.sub(r"AIza[0-9A-Za-z_-]{10,}", "[redacted]", text)
    text = re.sub(
        r"(?i)(api[_-]?key|authorization|bearer)\s*[:=]\s*\S+",
        r"\1=[redacted]",
        text,
    )
    return text[:240]


def parse_google_error(body: str) -> tuple[str, str]:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return "unknown", sanitize_message(body[:120])
    err = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(err, dict):
        return "unknown", "unparseable_error"
    code = err.get("status") or err.get("code") or "unknown"
    message = sanitize_message(str(err.get("message") or ""))
    return str(code), message or "empty_message"


def report(
    *,
    http_status: int,
    selected_model: str,
    usable_text: bool,
    error_code: str = "",
    error_message: str = "",
) -> None:
    print(f"http_status={http_status}")
    print(f"selected_model={selected_model}")
    print(f"usable_text={'yes' if usable_text else 'no'}")
    if error_code or error_message:
        print(f"google_error_code={error_code or 'none'}")
        print(f"google_error_message={error_message or 'none'}")


def models_list_url(*, page_token: str | None = None) -> str:
    params: dict[str, str | int] = {"pageSize": LIST_PAGE_SIZE}
    if page_token:
        params["pageToken"] = page_token
    return f"{BASE}/models?{urlencode(params)}"


def request(
    method: str,
    url: str,
    api_key: str,
    payload: dict | None = None,
    *,
    opener: Callable[..., object] = urllib.request.urlopen,
) -> tuple[int, str]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "x-goog-api-key": api_key,
            "Content-Type": "application/json",
        },
    )
    try:
        with opener(req, timeout=30) as resp:  # type: ignore[operator]
            status = int(getattr(resp, "status", 200))
            body = resp.read().decode("utf-8", errors="replace")  # type: ignore[union-attr]
            return status, body
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return int(exc.code), body
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        detail = getattr(exc, "reason", None) or str(exc) or type(exc).__name__
        raise NetworkProbeError(sanitize_message(str(detail))) from None


def extract_generate_content_names(models: list[object]) -> list[str]:
    names: list[str] = []
    for item in models:
        if not isinstance(item, dict):
            continue
        methods = item.get("supportedGenerationMethods") or []
        if "generateContent" not in methods:
            continue
        name = str(item.get("name") or "")
        short = name.split("/", 1)[-1] if name else ""
        if short:
            names.append(short)
    return names


def is_flash_model(name: str) -> bool:
    return "flash" in name.lower()


def select_flash_candidates(
    names: list[str],
    *,
    preferred: str = PREFERRED,
    deprecated_primary: str = DEPRECATED_PRIMARY,
) -> list[str]:
    """Order Flash models for generateContent attempts.

    Preferred model is first when present. ``gemini-2.5-flash`` is never primary;
    it is appended last when listed so fallback stays deterministic.
    """
    flash = [name for name in names if is_flash_model(name)]
    ordered: list[str] = []
    if preferred in flash:
        ordered.append(preferred)
    for name in flash:
        if name in ordered or name == deprecated_primary:
            continue
        ordered.append(name)
    if deprecated_primary in flash and deprecated_primary not in ordered:
        ordered.append(deprecated_primary)
    return ordered


def is_model_unavailable(status: int, body: str) -> bool:
    if status == 404:
        return True
    code, _message = parse_google_error(body)
    normalized = str(code).upper()
    return normalized in {"NOT_FOUND", "MODEL_NOT_FOUND", "404"}


def response_has_usable_text(body: str) -> bool:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return False
    for candidate in payload.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content") or {}
        if not isinstance(content, dict):
            continue
        for part in content.get("parts") or []:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                return True
    return False


def report_stage(
    *,
    stage: str,
    model: str,
    attempt: int,
    request_bytes: int,
    description_chars: int,
    http_status: int | None,
    google_status: str = "",
    google_message: str = "",
    duration_ms: int = 0,
) -> None:
    """One safe diagnostic line per HTTP attempt (no prompts, bodies, or headers)."""
    print(
        f"stage={stage} model={model} attempt={attempt} "
        f"request_bytes={request_bytes} description_chars={description_chars} "
        f"http_status={http_status if http_status is not None else 0} "
        f"google_status={sanitize_message(google_status) or 'none'} "
        f"google_message={sanitize_message(google_message) or 'none'} "
        f"duration_ms={duration_ms}"
    )


def _payload_bytes(payload: dict | None) -> int:
    return 0 if payload is None else len(json.dumps(payload).encode("utf-8"))


def _make_requester(key: str, request_fn: RequestFn | None) -> RequestFn:
    def _request(method: str, url: str, payload: dict | None = None) -> tuple[int, str]:
        if request_fn is not None:
            return request_fn(method, url, payload)
        return request(method, url, key, payload)

    return _request


def run_probe(
    *,
    api_key: str,
    request_fn: RequestFn | None = None,
    preferred: str = PREFERRED,
) -> int:
    """Minimal-text stage only (legacy entry point)."""
    code, _model = _run_minimal_stage(
        api_key=api_key, request_fn=request_fn, preferred=preferred
    )
    return code


def _run_minimal_stage(
    *,
    api_key: str,
    request_fn: RequestFn | None,
    preferred: str,
) -> tuple[int, str]:
    key = (api_key or "").strip()
    if not key:
        report(
            http_status=0,
            selected_model="none",
            usable_text=False,
            error_code="missing_secret",
            error_message="GEMINI_API_KEY is empty",
        )
        return 1, ""

    _request = _make_requester(key, request_fn)

    try:
        list_status, list_body = _request("GET", models_list_url())
    except NetworkProbeError as exc:
        report(
            http_status=0,
            selected_model="none",
            usable_text=False,
            error_code="network_error",
            error_message=exc.message,
        )
        return 1, ""

    if list_status != 200:
        code, message = parse_google_error(list_body)
        report(
            http_status=list_status,
            selected_model="none",
            usable_text=False,
            error_code=code,
            error_message=message,
        )
        return 1, ""

    try:
        listed = json.loads(list_body)
    except json.JSONDecodeError:
        report(
            http_status=list_status,
            selected_model="none",
            usable_text=False,
            error_code="invalid_json",
            error_message="listModels response was not JSON",
        )
        return 1, ""

    models = listed.get("models") if isinstance(listed, dict) else None
    if not isinstance(models, list):
        report(
            http_status=list_status,
            selected_model="none",
            usable_text=False,
            error_code="unexpected_shape",
            error_message="listModels missing models array",
        )
        return 1, ""

    generate_content_names = extract_generate_content_names(models)
    print("generateContent_models:")
    for name in generate_content_names:
        print(f"- {name}")

    candidates = select_flash_candidates(
        generate_content_names,
        preferred=preferred,
    )
    if not candidates:
        report(
            http_status=list_status,
            selected_model="none",
            usable_text=False,
            error_code="preferred_model_missing",
            error_message=f"no generateContent Flash models listed (wanted {preferred})",
        )
        return 1, ""

    last_status = 0
    last_body = ""
    last_model = candidates[0]
    for model in candidates:
        last_model = model
        started = time.monotonic()
        try:
            gen_status, gen_body = _request(
                "POST",
                f"{BASE}/models/{model}:generateContent",
                MINIMAL_GENERATE_PAYLOAD,
            )
        except NetworkProbeError as exc:
            report(
                http_status=0,
                selected_model=model,
                usable_text=False,
                error_code="network_error",
                error_message=exc.message,
            )
            return 1, ""
        duration_ms = int((time.monotonic() - started) * 1000)
        gen_code, gen_message = (
            ("", "") if gen_status == 200 else parse_google_error(gen_body)
        )
        report_stage(
            stage="minimal",
            model=model,
            attempt=1,
            request_bytes=_payload_bytes(MINIMAL_GENERATE_PAYLOAD),
            description_chars=0,
            http_status=gen_status,
            google_status=gen_code,
            google_message=gen_message,
            duration_ms=duration_ms,
        )

        last_status = gen_status
        last_body = gen_body
        if gen_status == 200:
            usable = response_has_usable_text(gen_body)
            report(
                http_status=gen_status,
                selected_model=model,
                usable_text=usable,
                error_code="" if usable else "empty_candidates",
                error_message="" if usable else "generateContent returned no usable text",
            )
            return (0, model) if usable else (1, "")

        if is_model_unavailable(gen_status, gen_body):
            continue

        report(
            http_status=gen_status,
            selected_model=model,
            usable_text=False,
            error_code=gen_code,
            error_message=gen_message,
        )
        return 1, ""

    code, message = parse_google_error(last_body)
    report(
        http_status=last_status,
        selected_model=last_model,
        usable_text=False,
        error_code=code,
        error_message=message,
    )
    return 1, ""


# --- Production-parity stages -------------------------------------------------

STRUCTURED_SYSTEM = "You are a JSON echo service. Return JSON only."
STRUCTURED_USER = 'Return exactly this JSON object: {"status": "ok"}'
STRUCTURED_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["status"],
    "properties": {"status": {"type": "string", "enum": ["ok"]}},
}
DEFAULT_DESCRIPTION_SIZES: tuple[int, ...] = (6000,)
MAX_DESCRIPTION_CHARS = 80000

_FIXTURE_PARAGRAPHS = (
    "Probe Fixture Co is hiring a Staff AI Engineer to build LLM agent "
    "infrastructure. This is a fully remote role open to candidates anywhere "
    "in the United States.",
    "Responsibilities include designing retrieval-augmented generation "
    "pipelines, evaluating model quality, and operating Python backend "
    "services on cloud infrastructure.",
    "Requirements: 8+ years of backend engineering, production experience "
    "with large language models, strong Python, and experience with "
    "distributed systems and observability.",
    "Benefits include competitive salary, equity, health coverage, and a "
    "home-office stipend. The posting is open and accepting applications.",
)


def fixture_description(chars: int) -> str:
    """Deterministic synthetic job description of exactly ``chars`` characters."""
    target = max(1, min(int(chars), MAX_DESCRIPTION_CHARS))
    parts: list[str] = []
    total = 0
    section = 0
    while total < target:
        body = _FIXTURE_PARAGRAPHS[section % len(_FIXTURE_PARAGRAPHS)]
        paragraph = f"Section {section + 1}. {body}\n\n"
        parts.append(paragraph)
        total += len(paragraph)
        section += 1
    return "".join(parts)[:target]


def fixture_candidate():
    from job_agent.auto_discovery.types import LightweightCandidate

    return LightweightCandidate(
        client_candidate_id="probe-fixture-0001",
        company="Probe Fixture Co",
        title="Staff AI Engineer",
        url="https://example.com/jobs/probe-fixture-0001",
        source="greenhouse",
        external_job_id="probe-fixture-0001",
        location="Remote - United States",
        posted_date="2026-09-01",
        description_hash="0123456789abcdef",
    )


def parse_description_sizes(raw: str | None) -> tuple[int, ...]:
    sizes: list[int] = []
    for token in (raw or "").replace(";", ",").split(","):
        token = token.strip()
        if not token:
            continue
        try:
            value = int(token)
        except ValueError:
            continue
        if value > 0:
            sizes.append(min(value, MAX_DESCRIPTION_CHARS))
    return tuple(sorted(set(sizes))) or DEFAULT_DESCRIPTION_SIZES


def _run_structured_stage(*, model: str, request_fn: RequestFn) -> bool:
    from job_agent.auto_discovery.evaluate.providers import GeminiProvider

    payload = GeminiProvider.build_payload(
        system=STRUCTURED_SYSTEM, user=STRUCTURED_USER, schema=STRUCTURED_SCHEMA
    )
    started = time.monotonic()
    try:
        status, resp_body = request_fn(
            "POST", f"{BASE}/models/{model}:generateContent", payload
        )
    except NetworkProbeError as exc:
        report_stage(
            stage="structured_small",
            model=model,
            attempt=1,
            request_bytes=_payload_bytes(payload),
            description_chars=0,
            http_status=0,
            google_status="network_error",
            google_message=exc.message,
        )
        return False
    duration_ms = int((time.monotonic() - started) * 1000)
    code, message = ("", "") if status == 200 else parse_google_error(resp_body)
    ok = status == 200 and _structured_ok(resp_body)
    if status == 200 and not ok:
        code, message = "invalid_structured_output", "response was not the expected JSON"
    report_stage(
        stage="structured_small",
        model=model,
        attempt=1,
        request_bytes=_payload_bytes(payload),
        description_chars=0,
        http_status=status,
        google_status=code,
        google_message=message,
        duration_ms=duration_ms,
    )
    return ok


def _structured_ok(resp_body: str) -> bool:
    try:
        data = json.loads(resp_body)
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        return False
    return isinstance(parsed, dict) and parsed.get("status") == "ok"


def _run_realistic_stage(
    *,
    key: str,
    model: str,
    description_chars: int,
    provider_factory: Callable[[str, str], object],
) -> bool:
    from job_agent.auto_discovery.evaluate.gpt_fit_v2 import (
        GPT_FIT_V2_JSON_SCHEMA,
        SYSTEM_PROMPT,
        build_user_prompt,
        validate_model_output,
    )

    stage = f"realistic_gpt_fit_v2:{description_chars}"
    provider = provider_factory(key, model)
    description = fixture_description(description_chars)
    outcome = "ok"
    try:
        raw = provider.complete_json(  # type: ignore[attr-defined]
            system=SYSTEM_PROMPT,
            user=build_user_prompt(fixture_candidate(), description),
            schema=GPT_FIT_V2_JSON_SCHEMA,
        )
        validate_model_output(raw)
    except Exception as exc:  # noqa: BLE001 - report class only, never payloads
        outcome = type(exc).__name__
    attempts = list(getattr(provider, "last_attempts", []) or [])
    for rec in attempts:
        report_stage(
            stage=stage,
            model=str(rec.get("model") or model),
            attempt=int(rec.get("attempt") or 0),
            request_bytes=int(rec.get("request_bytes") or 0),
            description_chars=len(description),
            http_status=rec.get("http_status"),
            google_status=str(rec.get("error_status") or ""),
            google_message=str(rec.get("error_message") or ""),
            duration_ms=int(rec.get("duration_ms") or 0),
        )
    print(f"stage_result={stage} outcome={outcome} attempts={len(attempts)}")
    return outcome == "ok"


def _default_provider_factory(key: str, model: str):
    from job_agent.auto_discovery.evaluate.providers import GeminiProvider

    return GeminiProvider(key, model=model)


def run_parity_probe(
    *,
    api_key: str,
    request_fn: RequestFn | None = None,
    provider_factory: Callable[[str, str], object] | None = None,
    description_sizes: tuple[int, ...] = DEFAULT_DESCRIPTION_SIZES,
    preferred: str = PREFERRED,
) -> int:
    """Minimal text → small structured JSON → realistic gpt-fit-v2 (per size).

    Talks only to Google Generative Language; never touches MCP or databases.
    """
    code, model = _run_minimal_stage(
        api_key=api_key, request_fn=request_fn, preferred=preferred
    )
    if code != 0 or not model:
        print("parity_verdict=minimal_failed")
        return 1
    key = api_key.strip()
    requester = _make_requester(key, request_fn)
    if not _run_structured_stage(model=model, request_fn=requester):
        print("parity_verdict=structured_small_failed")
        return 1

    factory = provider_factory or _default_provider_factory
    largest_ok = 0
    for size in description_sizes:
        if not _run_realistic_stage(
            key=key, model=model, description_chars=size, provider_factory=factory
        ):
            print(
                f"parity_verdict=realistic_failed description_chars={size} "
                f"largest_ok_description_chars={largest_ok}"
            )
            return 1
        largest_ok = size
    print(f"parity_verdict=all_stages_ok largest_ok_description_chars={largest_ok}")
    return 0


def main(argv: list[str] | None = None) -> int:
    del argv  # unused; kept for CLI symmetry
    return run_parity_probe(
        api_key=os.environ.get("GEMINI_API_KEY") or "",
        description_sizes=parse_description_sizes(
            os.environ.get("GEMINI_PROBE_DESCRIPTION_SIZES")
        ),
    )


if __name__ == "__main__":
    raise SystemExit(main())
