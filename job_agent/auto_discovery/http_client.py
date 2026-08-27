"""Bounded HTTP client with retries and error classification."""

from __future__ import annotations

import logging
import random
import time
from typing import Any

import httpx

from .ssrf import assert_safe_ats_url
from .types import AdapterError

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = httpx.Timeout(10.0, read=30.0)
DEFAULT_MAX_RETRIES = 3
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


def classify_http_error(status_code: int | None, exc: BaseException | None = None) -> str:
    if isinstance(exc, AdapterError) and exc.category:
        return exc.category
    if status_code == 429:
        return "rate_limit"
    if status_code == 404:
        return "not_found"
    if status_code is not None and status_code >= 500:
        return "server_error"
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        return "timeout"
    if isinstance(exc, (httpx.NetworkError, httpx.TransportError, OSError)):
        return "network"
    if isinstance(exc, (ValueError, TypeError)):
        return "validation"
    return "unknown"


class SafeHttpClient:
    """httpx wrapper: SSRF check, timeout, retries with jitter, no secret logging."""

    def __init__(
        self,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: httpx.Timeout | float | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        user_agent: str = "jay-job-auto-discovery/1.0",
    ):
        self._timeout = timeout if timeout is not None else DEFAULT_TIMEOUT
        self._max_retries = max(0, max_retries)
        self._client = httpx.Client(
            transport=transport,
            timeout=self._timeout,
            follow_redirects=False,
            headers={"User-Agent": user_agent, "Accept": "application/json"},
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "SafeHttpClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def request(
        self,
        method: str,
        url: str,
        *,
        careers_host: str | None = None,
        json: Any | None = None,
        headers: dict[str, str] | None = None,
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:
        safe_url = assert_safe_ats_url(url, careers_host=careers_host)
        last_exc: BaseException | None = None
        last_status: int | None = None

        for attempt in range(self._max_retries + 1):
            try:
                response = self._client.request(
                    method,
                    safe_url,
                    json=json,
                    headers=headers,
                    params=params,
                )
                last_status = response.status_code
                if response.status_code in RETRYABLE_STATUS and attempt < self._max_retries:
                    self._sleep_backoff(attempt, response)
                    continue
                if response.status_code >= 400:
                    category = classify_http_error(response.status_code)
                    raise AdapterError(
                        f"HTTP {response.status_code} for {method} {self._safe_log_url(safe_url)}",
                        category=category,
                        status_code=response.status_code,
                    )
                return response
            except AdapterError:
                raise
            except Exception as exc:
                last_exc = exc
                category = classify_http_error(None, exc)
                if attempt < self._max_retries and category in {
                    "timeout",
                    "network",
                    "rate_limit",
                    "server_error",
                }:
                    self._sleep_backoff(attempt, None)
                    continue
                raise AdapterError(
                    f"{method} failed for {self._safe_log_url(safe_url)}: {type(exc).__name__}",
                    category=category,
                ) from None

        raise AdapterError(
            f"exhausted retries for {method} {self._safe_log_url(safe_url)}",
            category=classify_http_error(last_status, last_exc),
            status_code=last_status,
        )

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", url, **kwargs)

    @staticmethod
    def _safe_log_url(url: str) -> str:
        # Strip query values that might contain tokens.
        if "?" not in url:
            return url
        base, _, _ = url.partition("?")
        return f"{base}?[redacted]"

    @staticmethod
    def _sleep_backoff(attempt: int, response: httpx.Response | None) -> None:
        retry_after = None
        if response is not None:
            raw = response.headers.get("Retry-After")
            if raw:
                try:
                    retry_after = float(raw)
                except ValueError:
                    retry_after = None
        base = retry_after if retry_after is not None else (0.5 * (2**attempt))
        delay = min(30.0, base + random.uniform(0, 0.5))
        time.sleep(delay)
