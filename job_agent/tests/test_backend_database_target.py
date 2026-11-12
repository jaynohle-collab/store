import asyncio
import contextlib
import io
import logging
import os
import sys
import unittest
from unittest.mock import patch

from job_agent.examples.check_backend_database_target import run, target_digest


URL = "postgresql://fixture:synthetic@ep-test-a1.us-east-2.aws.neon.tech/neondb?sslmode=require"
NONCE = "01" * 32
VECTOR = "8e15980c94b52368292b006313cb464e6afa695a493089c847988a8a627bddb7"


class DatabaseTargetDigestTests(unittest.TestCase):
    def test_shared_vector_and_safe_aliases(self):
        self.assertEqual(target_digest(URL, NONCE), VECTOR)
        for url in [URL.replace("postgresql:", "postgres:"),
                    URL.replace("ep-test-a1.", "EP-TEST-A1-pooler."),
                    URL.replace("/neondb", ":05432/neondb"),
                    URL.replace("/neondb", "/%6Eeondb"),
                    URL.replace("fixture:synthetic", "another:different%40secret"),
                    URL.replace("sslmode=require", "channel_binding=require&sslmode=verify-full")]:
            self.assertEqual(target_digest(url, NONCE), VECTOR)

    def test_different_target_and_challenge_never_match(self):
        for url in [URL.replace("ep-test-a1", "ep-other-a1"),
                    URL.replace("us-east-2", "us-west-2"),
                    URL.replace("aws.neon", "azure.neon"),
                    URL.replace("/neondb", "/Other"),
                    URL.replace("/neondb", ":5433/neondb")]:
            self.assertNotEqual(target_digest(url, NONCE), VECTOR)
        self.assertNotEqual(target_digest(URL, "02" * 32), VECTOR)

    def test_unsupported_and_ambiguous_values_fail_closed_without_leak(self):
        urls = [None, "", "postgres://synthetic-secret@localhost/db", URL + "#fragment",
                URL + "\n", " " + URL, URL.replace("postgresql", "https"),
                URL.replace("ep-test-a1", "%65p-test-a1"), URL.replace(".neon.tech", ".neon.tech."),
                URL.replace(".neon.tech", ".neon.tech.evil.invalid"),
                URL.replace("fixture:synthetic@", ""), URL.replace("fixture:synthetic", "@synthetic"),
                URL.replace("/neondb", ":0/neondb"), URL.replace("/neondb", ":65536/neondb"),
                URL.replace("/neondb", ":/neondb"), URL.replace("/neondb", "/"),
                URL.replace("/neondb", "/.."), URL.replace("/neondb", "/%2e%2e"),
                URL.replace("/neondb", "/a%2fb"), URL.replace("/neondb", "/a%00b"),
                URL.replace("/neondb", "/a\\b"), URL.replace("/neondb", "/" + "x" * 64),
                URL + "&host=other", URL + "&options=endpoint%3Dep-other",
                URL + "&sslmode=require", URL.replace("sslmode=require", "sslmode=disable"),
                URL + "&channel_binding=disable", URL + "&channel_binding", URL + "&"]
        for url in urls:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "^database_target_unavailable$"):
                target_digest(url, NONCE)
        for nonce in [None, "", "00" * 31, "00" * 33, "FF" * 32, "g" * 64]:
            with self.assertRaisesRegex(ValueError, "^database_target_unavailable$"):
                target_digest(URL, nonce)


class DatabaseTargetCommandTests(unittest.TestCase):
    def invoke(self, factory, env=None, argv=None):
        output, errors = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {"DATABASE_URL": URL} if env is None else env, clear=True), \
                patch.object(sys, "argv", argv or ["probe"]), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = asyncio.run(run(factory))
        self.assertEqual(errors.getvalue(), "")
        return code, output.getvalue()

    def test_only_boolean_printed_and_only_challenge_digest_transmitted(self):
        requests = []
        class Client:
            async def call_tool(self, name, args):
                print("synthetic stdout secret")
                print("synthetic stderr secret", file=sys.stderr)
                logging.critical("synthetic log secret")
                requests.append((name, args))
                self_digest = target_digest(URL, args["challenge"])
                return {"matches": self_digest == args["expected_digest"]}
        before = logging.root.manager.disable
        self.assertEqual(self.invoke(Client), (0, "true\n"))
        self.assertEqual(logging.root.manager.disable, before)
        self.assertEqual(len(requests), 1)
        name, args = requests[0]
        self.assertEqual(name, "compare_backend_database_target")
        self.assertEqual(set(args), {"challenge", "expected_digest"})
        self.assertNotIn("synthetic", str(args))
        self.assertEqual(self.invoke(Client), (0, "true\n"))
        self.assertNotEqual(requests[0][1]["challenge"], requests[1][1]["challenge"])

    def test_error_and_malformed_results_fail_closed_and_redacted(self):
        class ErrorClient:
            async def call_tool(self, *args):
                print("synthetic secret", file=sys.stderr)
                raise RuntimeError("synthetic credential-bearing URL")
        self.assertEqual(self.invoke(ErrorClient), (1, "false\n"))
        for response in [{"matches": False}, {"matches": 1}, {"matches": "true"},
                         {"matches": True, "url": "synthetic secret"}, {}, None, []]:
            class Client:
                async def call_tool(self, *args):
                    return response
            self.assertEqual(self.invoke(Client), (1, "false\n"))

    def test_invalid_configuration_debugging_and_arguments_stop_before_client(self):
        calls = []
        def forbidden():
            calls.append(True)
            raise RuntimeError("client constructed before validation")
        for env in [{}, {"DATABASE_URL": "invalid"},
                    {"DATABASE_URL": URL, "RUNNER_DEBUG": "1"},
                    {"DATABASE_URL": URL, "ACTIONS_STEP_DEBUG": "true"}]:
            self.assertEqual(self.invoke(forbidden, env=env), (1, "false\n"))
        self.assertEqual(self.invoke(forbidden, argv=["probe", "unexpected"]), (1, "false\n"))
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
