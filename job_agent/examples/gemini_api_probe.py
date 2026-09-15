"""Manual Gemini API diagnostic used by the gemini-api-probe workflow.

Read-only against Google Generative Language. Never prints the API key,
request headers, or complete provider payloads.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Callable
from urllib.parse import urlencode

BASE = "https://generativelanguage.googleapis.com/v1beta"
PREFERRED = "gemini-2.5-flash"
LIST_PAGE_SIZE = 1000
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


def run_probe(
    *,
    api_key: str,
    request_fn: RequestFn | None = None,
    preferred: str = PREFERRED,
) -> int:
    key = (api_key or "").strip()
    if not key:
        report(
            http_status=0,
            selected_model="none",
            usable_text=False,
            error_code="missing_secret",
            error_message="GEMINI_API_KEY is empty",
        )
        return 1

    def _request(method: str, url: str, payload: dict | None = None) -> tuple[int, str]:
        if request_fn is not None:
            return request_fn(method, url, payload)
        return request(method, url, key, payload)

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
        return 1

    if list_status != 200:
        code, message = parse_google_error(list_body)
        report(
            http_status=list_status,
            selected_model="none",
            usable_text=False,
            error_code=code,
            error_message=message,
        )
        return 1

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
        return 1

    models = listed.get("models") if isinstance(listed, dict) else None
    if not isinstance(models, list):
        report(
            http_status=list_status,
            selected_model="none",
            usable_text=False,
            error_code="unexpected_shape",
            error_message="listModels missing models array",
        )
        return 1

    generate_content_names = extract_generate_content_names(models)
    print("generateContent_models:")
    for name in generate_content_names:
        print(f"- {name}")

    if preferred not in generate_content_names:
        report(
            http_status=list_status,
            selected_model="none",
            usable_text=False,
            error_code="preferred_model_missing",
            error_message=f"{preferred} not listed for generateContent",
        )
        return 1

    try:
        gen_status, gen_body = _request(
            "POST",
            f"{BASE}/models/{preferred}:generateContent",
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": "Reply with exactly: ok"}],
                    }
                ]
            },
        )
    except NetworkProbeError as exc:
        report(
            http_status=0,
            selected_model=preferred,
            usable_text=False,
            error_code="network_error",
            error_message=exc.message,
        )
        return 1

    if gen_status != 200:
        code, message = parse_google_error(gen_body)
        report(
            http_status=gen_status,
            selected_model=preferred,
            usable_text=False,
            error_code=code,
            error_message=message,
        )
        return 1

    usable = response_has_usable_text(gen_body)
    report(
        http_status=gen_status,
        selected_model=preferred,
        usable_text=usable,
        error_code="" if usable else "empty_candidates",
        error_message="" if usable else "generateContent returned no usable text",
    )
    return 0 if usable else 1


def main(argv: list[str] | None = None) -> int:
    del argv  # unused; kept for CLI symmetry
    return run_probe(api_key=os.environ.get("GEMINI_API_KEY") or "")


if __name__ == "__main__":
    raise SystemExit(main())
