"""SSRF guard: HTTPS only to allowlisted ATS hosts; block private IPs."""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

from .types import AdapterError

# Official public ATS API and job-board hosts only.
ATS_API_HOSTS = frozenset(
    {
        "boards-api.greenhouse.io",
        "boards.greenhouse.io",
        "job-boards.greenhouse.io",
        "api.ashbyhq.com",
        "jobs.ashbyhq.com",
        "api.lever.co",
        "jobs.lever.co",
    }
)

ATS_HOST_SUFFIXES = (
    ".greenhouse.io",
    ".greenhouse.com",
    ".ashbyhq.com",
    ".ashby.com",
    ".lever.co",
    ".myworkdayjobs.com",
)


def _host_allowed(host: str) -> bool:
    h = host.lower().rstrip(".")
    if h in ATS_API_HOSTS:
        return True
    return any(h.endswith(suffix) for suffix in ATS_HOST_SUFFIXES)


def _is_blocked_ip_literal(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def assert_safe_ats_url(
    url: str,
    *,
    careers_host: str | None = None,
) -> str:
    """Validate ``url`` for outbound fetch. Returns the normalized URL string.

    Allows HTTPS to known ATS hosts only. ``careers_host`` is accepted only when
    that host is itself an allowlisted ATS host (never an arbitrary public host).
    Raises AdapterError(category=ssrf_blocked).
    """
    raw = (url or "").strip()
    if not raw:
        raise AdapterError("empty URL blocked by SSRF guard", category="ssrf_blocked")

    parsed = urlparse(raw)
    if parsed.scheme.lower() != "https":
        raise AdapterError(
            f"non-HTTPS scheme blocked: {parsed.scheme or '(missing)'}",
            category="ssrf_blocked",
        )
    if parsed.username or parsed.password:
        raise AdapterError("URL userinfo blocked by SSRF guard", category="ssrf_blocked")

    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        raise AdapterError("URL missing host", category="ssrf_blocked")

    if host in {"localhost", "metadata.google.internal"} or host.endswith(".local"):
        raise AdapterError(f"host blocked: {host}", category="ssrf_blocked")
    if _is_blocked_ip_literal(host):
        raise AdapterError(f"private/non-global IP blocked: {host}", category="ssrf_blocked")

    # careers_host may only reinforce an already-allowlisted ATS host.
    if careers_host:
        extra = careers_host.lower().rstrip(".")
        if not _host_allowed(extra):
            raise AdapterError(
                f"careers_host not allowlisted: {extra}",
                category="ssrf_blocked",
            )

    if not _host_allowed(host):
        raise AdapterError(f"host not allowlisted: {host}", category="ssrf_blocked")

    return raw
