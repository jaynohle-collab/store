from __future__ import annotations

import logging
import unittest
from unittest.mock import MagicMock

from job_agent.integrations.auth0_token import Auth0Config, Auth0TokenProvider


class Auth0TokenProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = Auth0Config(
            token_url="https://example.us.auth0.com/oauth/token",
            client_id="client-id",
            client_secret="super-secret-value",
            audience="https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp",
        )
        self.clock = MagicMock(return_value=1_000.0)
        self.http_post = MagicMock(
            return_value={"access_token": "token-one", "expires_in": 3600, "token_type": "Bearer"}
        )
        self.provider = Auth0TokenProvider(
            self.config,
            refresh_skew_seconds=60,
            http_post=self.http_post,
            clock=self.clock,
        )

    def test_caches_token_until_near_expiry(self) -> None:
        first = self.provider.get_access_token()
        self.clock.return_value = 1_000.0 + 100
        second = self.provider.get_access_token()
        self.assertEqual(first, "token-one")
        self.assertEqual(second, "token-one")
        self.assertEqual(self.http_post.call_count, 1)

    def test_refreshes_token_near_expiry(self) -> None:
        self.provider.get_access_token()
        self.http_post.return_value = {
            "access_token": "token-two",
            "expires_in": 3600,
            "token_type": "Bearer",
        }
        # expires_at = 1000 + 3600 = 4600; skew=60 → refresh when now >= 4540
        self.clock.return_value = 4_550.0
        refreshed = self.provider.get_access_token()
        self.assertEqual(refreshed, "token-two")
        self.assertEqual(self.http_post.call_count, 2)

    def test_force_refresh(self) -> None:
        self.provider.get_access_token()
        self.http_post.return_value = {
            "access_token": "token-forced",
            "expires_in": 3600,
            "token_type": "Bearer",
        }
        token = self.provider.get_access_token(force_refresh=True)
        self.assertEqual(token, "token-forced")
        self.assertEqual(self.http_post.call_count, 2)

    def test_never_logs_secret_or_token(self) -> None:
        records: list[logging.LogRecord] = []

        class Capture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        handler = Capture()
        logger = logging.getLogger("job_agent.integrations.auth0_token")
        logger.addHandler(handler)
        previous_level = logger.level
        logger.setLevel(logging.DEBUG)
        try:
            self.provider.get_access_token()
            self.http_post.side_effect = RuntimeError(
                "boom super-secret-value token-one leaked"
            )
            with self.assertRaises(Exception):
                self.provider.get_access_token(force_refresh=True)
        finally:
            logger.removeHandler(handler)
            logger.setLevel(previous_level)

        combined = "\n".join(record.getMessage() for record in records)
        self.assertNotIn("super-secret-value", combined)
        self.assertNotIn("token-one", combined)
        self.assertIn("[REDACTED]", combined)

    def test_request_uses_client_credentials_and_audience(self) -> None:
        self.provider.get_access_token()
        args, _kwargs = self.http_post.call_args
        self.assertEqual(args[0], self.config.token_url)
        form = args[1]
        self.assertEqual(form["grant_type"], "client_credentials")
        self.assertEqual(form["audience"], self.config.audience)
        self.assertEqual(form["client_id"], "client-id")
        self.assertIn("jobs:read", form["scope"])


if __name__ == "__main__":
    unittest.main()
