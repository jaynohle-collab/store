import { describe, expect, it } from "vitest";

import {
  CHATGPT_FORBIDDEN_SCOPES,
  TOOL_PERMISSIONS,
  WORKER_RECOMMENDED_SCOPES,
} from "@/lib/config";

describe("Milestone 5 automatic discovery TOOL_PERMISSIONS", () => {
  it("registers company registry and status tools with correct scopes", () => {
    expect(TOOL_PERMISSIONS.list_discovery_companies).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.upsert_discovery_company).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.claim_due_discovery_companies).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.complete_discovery_company_run).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.fail_discovery_company_run).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.start_automatic_discovery_run).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.finish_automatic_discovery_run).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.preserve_pending_discovery_evaluations).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.claim_pending_discovery_evaluations).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.complete_pending_discovery_evaluation).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.get_automatic_discovery_status).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.get_storage_observability).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.preview_description_retention).toBe("jobs:read");
  });

  it("keeps claim/complete/fail/pending off ChatGPT jobs:write scope", () => {
    const workerOnly = [
      "claim_due_discovery_companies",
      "complete_discovery_company_run",
      "fail_discovery_company_run",
      "start_automatic_discovery_run",
      "finish_automatic_discovery_run",
      "preserve_pending_discovery_evaluations",
      "claim_pending_discovery_evaluations",
      "complete_pending_discovery_evaluation",
    ];
    for (const name of workerOnly) {
      expect(TOOL_PERMISSIONS[name]).toBe("jobs:worker");
      expect(TOOL_PERMISSIONS[name]).not.toBe("jobs:write");
      expect(TOOL_PERMISSIONS[name]).not.toBe("jobs:delete");
      expect(TOOL_PERMISSIONS[name]).not.toBe("jobs:revert");
    }
  });

  it("keeps ChatGPT forbidden scopes and worker recommendations unchanged", () => {
    expect(CHATGPT_FORBIDDEN_SCOPES).toEqual(
      expect.arrayContaining(["jobs:worker", "jobs:delete"]),
    );
    expect(WORKER_RECOMMENDED_SCOPES).toEqual(
      expect.arrayContaining(["jobs:read", "jobs:write", "jobs:worker"]),
    );
  });
});
