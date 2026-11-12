"""Compare configured Neon targets without printing connection metadata.

This is an explicit, read-only operator command, not a startup hook. It emits
only ``true`` (exit 0) or ``false`` (exit 1). A match is not a migration approval,
proof of database connectivity, schema readiness, or a guard against later config
changes. Never use this module with shell tracing or runner debugging enabled.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import sys
from urllib.parse import unquote


_HEX = re.compile(r"[0-9a-f]{64}")
_HOST = re.compile(r"ep-[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\.(?:aws|azure)\.neon\.tech")
_URL = re.compile(r"^(?:postgres|postgresql)://([^/?#@]+)@([^/?#@:]+)(?::([0-9]+))?/([^/?#]+)(?:\?([^#]+))?$")


def _decode(value: str) -> str:
    if re.search(r"%(?![0-9A-Fa-f]{2})", value):
        raise ValueError
    return unquote(value, encoding="utf-8", errors="strict")


def target_digest(database_url: str, challenge: str) -> str:
    """Nonce-bound digest of a strictly supported target, never credentials."""
    try:
        if not isinstance(challenge, str) or not _HEX.fullmatch(challenge):
            raise ValueError
        if not isinstance(database_url, str) or not 1 <= len(database_url) <= 8192:
            raise ValueError
        if re.search(r"[^\x21-\x7e]|\\", database_url):
            raise ValueError
        match = _URL.fullmatch(database_url)
        if not match:
            raise ValueError
        userinfo, host, port, database, query = match.groups()
        decoded_credentials = _decode(userinfo)
        if not decoded_credentials.split(":", 1)[0] or re.search(r"[\x00-\x1f\x7f]", decoded_credentials):
            raise ValueError
        host = host.lower()
        if not _HOST.fullmatch(host) or any(len(label) > 63 for label in host.split(".")):
            raise ValueError
        if port is not None and (not re.fullmatch(r"[0-9]{1,5}", port) or not 1 <= int(port) <= 65535):
            raise ValueError
        port = str(int(port)) if port is not None else "5432"
        labels = host.split(".")
        if labels[0].endswith("-pooler"):
            labels[0] = labels[0][:-7]
        host = ".".join(labels)
        if not _HOST.fullmatch(host):
            raise ValueError
        database = _decode(database)
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,63}", database) or set(database) == {"."}:
            raise ValueError
        allowed = {"sslmode": {"require", "verify-ca", "verify-full"}, "channel_binding": {"prefer", "require"}}
        seen = set()
        for pair in query.split("&") if query is not None else []:
            if not re.fullmatch(r"[a-z_]+=[a-z-]+", pair):
                raise ValueError
            key, value = pair.split("=", 1)
            if key in seen or key not in allowed or value not in allowed[key]:
                raise ValueError
            seen.add(key)
        canonical = json.dumps(["neon-target-v1", host, port, database], separators=(",", ":"))
        return hmac.new(bytes.fromhex(challenge), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    except Exception:
        # URL parsers can include credential-bearing values in their errors.
        raise ValueError("database_target_unavailable") from None


async def run(client_factory=None) -> int:
    """Only the boolean escapes dependency output/error capture."""
    matched = False
    previous_logging = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if os.environ.get("RUNNER_DEBUG") == "1" or os.environ.get("ACTIONS_STEP_DEBUG") == "true":
                raise ValueError("debugging_not_supported")
            if len(sys.argv) > 1:
                raise ValueError("arguments_not_supported")
            challenge = secrets.token_hex(32)
            digest = target_digest(os.environ.get("DATABASE_URL", ""), challenge)
            if client_factory is None:
                from job_agent.integrations.remote_mcp_client import RemoteMcpClient
                client_factory = RemoteMcpClient
            response = await asyncio.wait_for(client_factory().call_tool(
                "compare_backend_database_target",
                {"challenge": challenge, "expected_digest": digest},
            ), timeout=45)
            matched = isinstance(response, dict) and set(response) == {"matches"} and response["matches"] is True
    except Exception:
        matched = False
    finally:
        logging.disable(previous_logging)
    print("true" if matched else "false")
    return 0 if matched else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
