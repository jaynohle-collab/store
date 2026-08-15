"""Auth0 Client Credentials token provider with in-memory caching."""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib import error, parse, request

logger = logging.getLogger(__name__)


class Auth0TokenError(RuntimeError):
    """Raised when Auth0 token acquisition fails."""


@dataclass(frozen=True)
class Auth0Config:
    token_url: str
    client_id: str
    client_secret: str
    audience: str
    scopes: tuple[str, ...] = ("jobs:read", "jobs:write", "jobs:delete")

    @classmethod
    def from_env(cls) -> "Auth0Config":
        token_url = os.environ.get("AUTH0_TOKEN_URL", "").strip()
        client_id = os.environ.get("AUTH0_CLIENT_ID", "").strip()
        client_secret = os.environ.get("AUTH0_CLIENT_SECRET", "").strip()
        audience = os.environ.get("AUTH0_AUDIENCE", "").strip()
        scope_raw = os.environ.get("AUTH0_SCOPES", "jobs:read jobs:write jobs:delete").strip()
        scopes = tuple(part for part in scope_raw.split() if part)

        missing = [
            name
            for name, value in [
                ("AUTH0_TOKEN_URL", token_url),
                ("AUTH0_CLIENT_ID", client_id),
                ("AUTH0_CLIENT_SECRET", client_secret),
                ("AUTH0_AUDIENCE", audience),
            ]
            if not value
        ]
        if missing:
            raise Auth0TokenError(f"Missing required environment variables: {', '.join(missing)}")

        return cls(
            token_url=token_url,
            client_id=client_id,
            client_secret=client_secret,
            audience=audience,
            scopes=scopes,
        )


def _redact_secrets(text: str, *secrets: str) -> str:
    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


class Auth0TokenProvider:
    """Fetch and cache Auth0 M2M access tokens.

    Tokens are refreshed shortly before expiration. Full access tokens and the
    client secret are never written to logs.
    """

    def __init__(
        self,
        config: Auth0Config,
        *,
        refresh_skew_seconds: int = 60,
        http_post: Callable[[str, dict[str, str]], dict[str, Any]] | None = None,
        clock: Callable[[], float] | None = None,
    ):
        self._config = config
        self._refresh_skew_seconds = max(0, refresh_skew_seconds)
        self._http_post = http_post or self._default_http_post
        self._clock = clock or time.time
        self._lock = threading.Lock()
        self._access_token: str | None = None
        self._expires_at: float = 0.0

    @property
    def has_cached_token(self) -> bool:
        return self._access_token is not None and self._clock() < self._expires_at

    def get_access_token(self, *, force_refresh: bool = False) -> str:
        with self._lock:
            now = self._clock()
            if (
                not force_refresh
                and self._access_token
                and now < (self._expires_at - self._refresh_skew_seconds)
            ):
                return self._access_token

            token, expires_in = self._request_token()
            self._access_token = token
            self._expires_at = now + max(expires_in, 1)
            logger.info(
                "Fetched Auth0 access token for audience=%s expires_in=%ss",
                self._config.audience,
                expires_in,
            )
            return token

    def invalidate(self) -> None:
        with self._lock:
            self._access_token = None
            self._expires_at = 0.0

    def _request_token(self) -> tuple[str, int]:
        form: dict[str, str] = {
            "grant_type": "client_credentials",
            "client_id": self._config.client_id,
            "client_secret": self._config.client_secret,
            "audience": self._config.audience,
        }
        if self._config.scopes:
            form["scope"] = " ".join(self._config.scopes)

        try:
            payload = self._http_post(self._config.token_url, form)
        except Exception as exc:  # noqa: BLE001 - sanitize before re-raise
            message = _redact_secrets(
                str(exc),
                self._config.client_secret,
                self._access_token or "",
            )
            logger.error("Auth0 token request failed: %s", message)
            raise Auth0TokenError(message) from None

        token = payload.get("access_token")
        expires_in = int(payload.get("expires_in") or 0)
        if not isinstance(token, str) or not token:
            raise Auth0TokenError("Auth0 response did not include access_token")

        # Never log token or secret values.
        logger.debug("Auth0 token acquired successfully (length=%s)", len(token))
        return token, expires_in

    def _default_http_post(self, url: str, form: dict[str, str]) -> dict[str, Any]:
        import json

        body = parse.urlencode(form).encode("utf-8")
        req = request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
        )
        try:
            with request.urlopen(req, timeout=30) as response:
                raw = response.read().decode("utf-8")
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            safe = _redact_secrets(detail, self._config.client_secret)
            raise Auth0TokenError(f"Auth0 HTTP {exc.code}: {safe}") from None
        except error.URLError as exc:
            raise Auth0TokenError(f"Auth0 network error: {exc.reason}") from None

        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise Auth0TokenError("Auth0 returned non-JSON response") from exc
