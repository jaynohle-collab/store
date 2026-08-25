import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHATGPT_FORBIDDEN_SCOPES,
  CHATGPT_RECOMMENDED_SCOPES,
  TOOL_PERMISSIONS,
  WORKER_RECOMMENDED_SCOPES,
} from "@/lib/config";
import {
  PREVIEW_HASH_DOMAIN,
  buildPreviewHash,
  type RevertEffectPlan,
} from "@/lib/db/discovery_batch_revert";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/009_discovery_batch_provenance_revert.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

const workflowPath = path.resolve(
  __dirname,
  "../../../../.github/workflows/process-discovery-inbox.yml",
);
const workflowYaml = readFileSync(workflowPath, "utf8");

describe("009_discovery_batch_provenance_revert.sql contract", () => {
  it("is additive and transactional", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).not.toMatch(/DELETE FROM/i);
    expect(migrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS discovery_batch_effects",
    );
    expect(migrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS discovery_batch_revert_events",
    );
    expect(migrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS discovery_batch_processing_attempts",
    );
    expect(migrationSql).toContain("'reverted'");
    expect(migrationSql).toContain("REFERENCES discovery_inbox_batches");
    expect(migrationSql).toContain("UNIQUE (batch_id, input_index)");
    expect(migrationSql).toContain("UNIQUE (batch_id, idempotency_key)");
    expect(migrationSql).toContain("UNIQUE (idempotency_key)");
    expect(migrationSql).toContain("uq_discovery_batch_active_attempt");
    expect(migrationSql).toContain("WHERE status = 'claimed'");
    expect(migrationSql).toContain("mutation_started");
    expect(migrationSql).toContain("active_attempt_id");
    expect(migrationSql).toContain("^[a-f0-9]{64}$");
    expect(migrationSql).toContain("idempotency_key = preview_hash");
  });

  it("documents production application order in header comments", () => {
    expect(migrationSql).toContain("Apply this 009");
    expect(migrationSql).toContain("Deploy MCP");
    expect(migrationSql).toContain("jobs:worker");
    expect(migrationSql).toContain("jobs:revert");
  });

  it("indexes attempts, effects, and revert events", () => {
    expect(migrationSql).toContain("idx_discovery_batch_attempts_batch_status");
    expect(migrationSql).toContain("idx_discovery_batch_attempts_heartbeat");
    expect(migrationSql).toContain("idx_discovery_batch_effects_batch_id");
    expect(migrationSql).toContain("idx_discovery_batch_effects_attempt_id");
    expect(migrationSql).toContain("idx_discovery_batch_revert_events_batch_id");
  });
});

describe("process-discovery-inbox workflow contract", () => {
  it("invokes the existing Python processor with concurrency and dispatch", () => {
    expect(workflowYaml).toContain(
      "python -m job_agent.examples.process_discovery_inbox",
    );
    expect(workflowYaml).toContain("workflow_dispatch:");
    expect(workflowYaml).toContain("concurrency:");
    expect(workflowYaml).toContain("cancel-in-progress: false");
    expect(workflowYaml).toContain("DISCOVERY_INBOX_SCHEDULE_ENABLED");
    expect(workflowYaml).toContain("jobs:worker");
    expect(workflowYaml).toContain("permissions:");
    expect(workflowYaml).toContain("contents: read");
    expect(workflowYaml).toContain("timeout-minutes: 30");
    expect(workflowYaml).toContain("Verify required secrets are present");
    expect(workflowYaml).toContain("Never print secret values");
    expect(workflowYaml).not.toContain("DATABASE_URL");
    expect(workflowYaml).not.toMatch(/echo\s+\$\{\{\s*secrets\./);
    expect(workflowYaml).not.toContain("jobs:delete");
    expect(workflowYaml).not.toContain("jobs:revert");
  });
});

describe("Milestone 4 MCP permissions", () => {
  it("separates ChatGPT revert from delete and worker scopes", () => {
    expect(TOOL_PERMISSIONS.preview_discovery_batch_revert).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.revert_discovery_batch).toBe("jobs:revert");
    expect(TOOL_PERMISSIONS.delete_job).toBe("jobs:delete");
    expect(TOOL_PERMISSIONS.claim_discovery_batch).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.complete_discovery_batch).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.fail_discovery_batch).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.apply_discovery_batch_job_persistence).toBe(
      "jobs:worker",
    );
    expect(TOOL_PERMISSIONS.recover_stale_discovery_batch_claims).toBe(
      "jobs:worker",
    );
    expect(TOOL_PERMISSIONS.record_discovery_batch_effects).toBeUndefined();

    const deleteTools = Object.entries(TOOL_PERMISSIONS)
      .filter(([, scope]) => scope === "jobs:delete")
      .map(([name]) => name)
      .sort();
    expect(deleteTools).toEqual(["delete_job"]);

    const revertTools = Object.entries(TOOL_PERMISSIONS)
      .filter(([, scope]) => scope === "jobs:revert")
      .map(([name]) => name)
      .sort();
    expect(revertTools).toEqual(["revert_discovery_batch"]);

    expect(CHATGPT_FORBIDDEN_SCOPES).toEqual(
      expect.arrayContaining(["jobs:worker", "jobs:delete"]),
    );
    expect(CHATGPT_RECOMMENDED_SCOPES).toEqual(
      expect.arrayContaining(["jobs:read", "jobs:write", "jobs:revert"]),
    );
    expect(WORKER_RECOMMENDED_SCOPES).toEqual(
      expect.arrayContaining(["jobs:read", "jobs:write", "jobs:worker"]),
    );
    expect(WORKER_RECOMMENDED_SCOPES).not.toContain("jobs:delete");
    expect(WORKER_RECOMMENDED_SCOPES).not.toContain("jobs:revert");
  });
});

describe("preview_hash construction", () => {
  const batchId = "11111111-1111-4111-8111-111111111111";

  function baseEffect(
    overrides: Partial<RevertEffectPlan> = {},
  ): RevertEffectPlan {
    return {
      effect_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      input_index: 0,
      processing_action: "created",
      canonical_job_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      posting_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      compensation_action: "withdraw_posting",
      is_protected: false,
      protection_reasons: [],
      before_state: null,
      after_fingerprint: "cafebabe",
      current_fingerprint: "cafebabe",
      ...overrides,
    };
  }

  it("uses domain separator and full 64-char sha256", () => {
    expect(PREVIEW_HASH_DOMAIN).toBe("discovery-batch-revert-v1");
    const hash = buildPreviewHash(batchId, "completed", [baseEffect()]);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic regardless of effect order", () => {
    const effects: RevertEffectPlan[] = [
      baseEffect({
        effect_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        input_index: 1,
        processing_action: "updated",
        compensation_action: "restore_posting",
        before_state: { posting_status: "active", description_hash: "abc" },
        after_fingerprint: "deadbeef",
        current_fingerprint: "deadbeef",
      }),
      baseEffect(),
    ];
    const first = buildPreviewHash(batchId, "completed", effects);
    const second = buildPreviewHash(batchId, "completed", [...effects].reverse());
    expect(first).toBe(second);
  });

  it("changes when each included state field changes", () => {
    const base = buildPreviewHash(batchId, "completed", [baseEffect()]);
    const mutations: Array<() => string> = [
      () => buildPreviewHash(batchId, "failed", [baseEffect()]),
      () =>
        buildPreviewHash(batchId, "completed", [
          baseEffect({ effect_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
        ]),
      () =>
        buildPreviewHash(batchId, "completed", [
          baseEffect({ processing_action: "updated" }),
        ]),
      () =>
        buildPreviewHash(batchId, "completed", [
          baseEffect({ posting_id: "99999999-9999-4999-8999-999999999999" }),
        ]),
      () =>
        buildPreviewHash(batchId, "completed", [
          baseEffect({
            canonical_job_id: "99999999-9999-4999-8999-999999999999",
          }),
        ]),
      () =>
        buildPreviewHash(batchId, "completed", [
          baseEffect({ current_fingerprint: "changed" }),
        ]),
      () =>
        buildPreviewHash(batchId, "completed", [
          baseEffect({ after_fingerprint: "changed" }),
        ]),
      () =>
        buildPreviewHash(batchId, "completed", [
          baseEffect({
            before_state: { posting_status: "active" },
            compensation_action: "restore_posting",
          }),
        ]),
      () =>
        buildPreviewHash(batchId, "completed", [
          baseEffect({
            is_protected: true,
            protection_reasons: ["application_present:applied"],
            compensation_action: "none",
          }),
        ]),
      () =>
        buildPreviewHash(batchId, "completed", [
          baseEffect({ compensation_action: "none" }),
        ]),
    ];
    for (const mutate of mutations) {
      expect(mutate()).not.toBe(base);
    }
  });
});
