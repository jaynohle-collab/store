# Private configured-target comparison

`compare_backend_database_target` is a worker-only, read-only diagnostic. It
compares a caller's configured Neon endpoint and database with the backend's
current configuration. It does not open a database connection or execute SQL.
The existing role-only diagnostic is unchanged.

The operator command is `python -m job_agent.examples.check_backend_database_target`.
It reads the caller's existing `DATABASE_URL`, creates a fresh random 32-byte
challenge, and sends only the challenge and a nonce-bound target digest through
the existing authenticated MCP client. Existing Auth0 M2M credentials and
`jobs:worker` scope are required. No new credentials or grants are created.
Do not enable shell tracing or runner debugging; the command rejects the known
Actions debug flags. Do not pass connection strings as command-line arguments.

The server returns only `{"matches":true}` or `{"matches":false}`. The command
prints only `true` (exit 0) or `false` (exit 1), including on failures. It captures
Python dependency output and suppresses logging during the check. It never
prints URLs, passwords, usernames, endpoint identities, digests, challenges,
database names, provider responses, or exceptions. An unexpected response shape,
authentication failure, timeout, unsupported URL, or mismatch fails closed.

## Canonical protocol

- Both sides use HMAC-SHA256 with the decoded challenge as the key and compact
  UTF-8 JSON `["neon-target-v1", directHost, decimalPort, database]` as the message.
- Only explicitly supported Neon AWS/Azure endpoint hostnames are accepted.
  Hostname case and the single terminal `-pooler` endpoint alias normalize;
  distinct endpoints, regions, providers, ports, and database names do not.
- Only `postgres`/`postgresql` URLs, explicit nonempty user info, a single
  database path component, and the documented secure `sslmode` and
  `channel_binding` query values are supported. Ambiguous URLs, extra query
  options, encoded hostnames, fragments, controls, unknown aliases, or unusual
  database names are rejected, not guessed.
- Credentials do not enter the digest. A fresh challenge prevents publishing a
  reusable target fingerprint. Challenge/digest values are not credentials and
  do not grant access. They must still not be logged by an invocation workflow.
- Comparison uses a constant-time digest comparison. Authorization and strict
  input validation happen before reading the backend configuration.

## Limits and rollout

A match proves only that these two supported connection configurations identify
the same endpoint and database at check time. It does not prove connectivity,
effective SQL role, schema readiness, branch naming, or migration authorization.
It cannot prevent a later configuration change. Check the actual SQL role and
transactional schema/ACL prerequisites separately before a reviewed migration.
Do not change configuration between comparison and migration. A mismatch must
stop the operation; do not automatically rewrite a host, remove protections,
change credentials, or broaden this parser to make a live check pass.

No workflow, schedule, automatic invocation, migration, configuration change,
or feature activation is included in this change. A future invocation must pin
the reviewed implementation, narrowly expose existing secrets to its execution
step, suppress raw stdout/stderr and tracing, and publish only its final boolean.
