import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_RUN_ID = "33333333-3333-4333-8333-333333333333";

type CompanyRow = {
  id: string;
  active_run_id: string | null;
  consecutive_failures: number;
  scan_priority: string;
  lease_expires_at: string | null;
  last_error_category: string | null;
  last_error_summary: string | null;
};

type RunRow = {
  id: string;
  company_id: string;
  status: "claimed" | "completed" | "failed" | "expired";
  worker_identity: string;
  error_category?: string | null;
  error_summary?: string | null;
  metrics?: Record<string, unknown>;
  completed_at?: string | null;
};

const { companies, runs, txCalls, pendingLifecycle } = vi.hoisted(() => ({
  companies: new Map<string, CompanyRow>(),
  runs: new Map<string, RunRow>(),
  txCalls: { count: 0 },
  pendingLifecycle: {
    current: null as null | {
      runId: string;
      workerIdentity: string;
      mode: "completed" | "failed";
      errorCategory?: string;
      errorSummary?: string;
    },
  },
}));

function snapshotState() {
  return {
    companies: structuredClone([...companies.entries()]),
    runs: structuredClone([...runs.entries()]),
  };
}

/**
 * Faithful model of the eligible-locked complete/fail statement:
 * lock ownership first; mutate both only from that set; abort if partial.
 */
function applyOwnedLifecycleSql(opts: {
  runId: string;
  workerIdentity: string;
  mode: "completed" | "failed";
  errorCategory?: string;
  errorSummary?: string;
}): Record<string, unknown>[] {
  const run = runs.get(opts.runId);
  if (!run) return [];
  const company = companies.get(run.company_id);
  if (!company) return [];

  const eligible =
    run.status === "claimed" &&
    run.worker_identity === opts.workerIdentity &&
    company.active_run_id === run.id;

  if (!eligible) {
    return [];
  }

  // Both mutations driven from eligible — never update run without company match.
  const before = snapshotState();
  try {
    run.status = opts.mode;
    run.completed_at = new Date().toISOString();
    if (opts.mode === "failed") {
      run.error_category = opts.errorCategory ?? "unknown";
      run.error_summary = opts.errorSummary ?? "failed";
      company.consecutive_failures += 1;
      company.last_error_category = run.error_category;
      company.last_error_summary = run.error_summary;
    } else {
      company.consecutive_failures = 0;
      company.last_error_category = null;
      company.last_error_summary = null;
    }
    if (company.active_run_id !== run.id) {
      throw new Error("partial_transition");
    }
    company.active_run_id = null;
    company.lease_expires_at = null;
    return [{ ...run }];
  } catch {
    // Simulate statement abort: restore both rows.
    companies.clear();
    runs.clear();
    for (const [k, v] of before.companies) companies.set(k, v);
    for (const [k, v] of before.runs) runs.set(k, v);
    throw new Error("assert_atomic_failed");
  }
}

vi.mock("@/lib/db/client", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("WITH eligible AS") && text.includes("FOR UPDATE OF r, c")) {
      const mode = text.includes("status = 'completed'") ? "completed" : "failed";
      pendingLifecycle.current = {
        runId: String(values[0]),
        workerIdentity: String(values[1]),
        mode,
        errorCategory: mode === "failed" ? String(values[2]) : undefined,
        errorSummary: mode === "failed" ? String(values[3]) : undefined,
      };
      return { kind: "lifecycle", mode };
    }
    if (
      text.includes("FROM discovery_company_runs r") &&
      text.includes("JOIN discovery_companies c") &&
      text.includes("company_active_run_id")
    ) {
      const runId = String(values[0] ?? "");
      const run = runs.get(runId);
      if (!run) return [];
      const company = companies.get(run.company_id);
      if (!company) return [];
      return [
        {
          ...run,
          scan_priority: company.scan_priority,
          consecutive_failures: company.consecutive_failures,
          company_active_run_id: company.active_run_id,
        },
      ];
    }
    return [];
  };

  (sql as { transaction?: unknown }).transaction = async () => {
    txCalls.count += 1;
    const pending = pendingLifecycle.current;
    pendingLifecycle.current = null;
    if (!pending) return [[]];
    const rows = applyOwnedLifecycleSql(pending);
    return [rows];
  };

  return {
    getSql: () => sql,
    getTransactionalSql: () => sql,
  };
});

vi.mock("@/lib/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config")>(
    "@/lib/config",
  );
  return {
    ...actual,
    getDatabaseUrl: () => "postgres://test",
  };
});

import {
  completeDiscoveryCompanyRun,
  completeDiscoveryCompanyRunSchema,
  failDiscoveryCompanyRun,
  failDiscoveryCompanyRunSchema,
} from "@/lib/db/discovery_companies";

const sourcePath = path.resolve(__dirname, "../db/discovery_companies.ts");
const source = readFileSync(sourcePath, "utf8");

function sliceFunction(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + 1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const completeSrc = sliceFunction(
  "export async function completeDiscoveryCompanyRun",
  "export async function failDiscoveryCompanyRun",
);
const failSrc = sliceFunction(
  "export async function failDiscoveryCompanyRun",
  "export async function startAutomaticDiscoveryRun",
);

function seedClaimed(worker = "github-actions") {
  companies.clear();
  runs.clear();
  companies.set(COMPANY_ID, {
    id: COMPANY_ID,
    active_run_id: RUN_ID,
    consecutive_failures: 0,
    scan_priority: "manual",
    lease_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    last_error_category: null,
    last_error_summary: null,
  });
  runs.set(RUN_ID, {
    id: RUN_ID,
    company_id: COMPANY_ID,
    status: "claimed",
    worker_identity: worker,
  });
}

describe("complete/fail discovery company run schemas", () => {
  it("requires worker_identity", () => {
    expect(() =>
      completeDiscoveryCompanyRunSchema.parse({
        run_id: RUN_ID,
        success: true,
      }),
    ).toThrow();
    expect(() =>
      failDiscoveryCompanyRunSchema.parse({
        run_id: RUN_ID,
        error_summary: "boom",
      }),
    ).toThrow();
  });
});

describe("complete/fail SQL ownership contracts", () => {
  it("locks eligible ownership before either lifecycle update", () => {
    for (const src of [completeSrc, failSrc]) {
      expect(src).toContain("WITH eligible AS");
      expect(src).toContain("FOR UPDATE OF r, c");
      expect(src).toContain("c.active_run_id = r.id");
      expect(src).toContain("r.status = 'claimed'");
      expect(src).toContain("r.worker_identity = ${workerIdentity}");
      const eligibleIdx = src.indexOf("WITH eligible AS");
      const doneIdx = src.indexOf("done AS");
      const companyIdx = src.indexOf("company AS");
      expect(eligibleIdx).toBeGreaterThanOrEqual(0);
      expect(doneIdx).toBeGreaterThan(eligibleIdx);
      expect(companyIdx).toBeGreaterThan(doneIdx);
    }
  });

  it("drives both mutations from eligible and aborts on partial counts", () => {
    for (const src of [completeSrc, failSrc]) {
      expect(src).toMatch(/FROM eligible e[\s\S]*WHERE r\.id = e\.run_id/);
      expect(src).toMatch(
        /FROM eligible e[\s\S]*WHERE c\.id = e\.company_id[\s\S]*c\.active_run_id = e\.run_id/,
      );
      expect(src).toContain("assert_atomic");
      expect(src).toContain("(1 / 0)::boolean");
      // Must not update company FROM done (old partial-commit pattern).
      const companyCte = src.slice(src.indexOf("company AS"), src.indexOf("assert_atomic"));
      expect(companyCte).toContain("FROM eligible e");
      expect(companyCte).not.toContain("FROM done");
    }
  });
});

describe("completeDiscoveryCompanyRun / failDiscoveryCompanyRun behavior", () => {
  beforeEach(() => {
    seedClaimed();
    txCalls.count = 0;
  });

  it("correct owner completes a run and clears the lease", async () => {
    const result = await completeDiscoveryCompanyRun({
      run_id: RUN_ID,
      worker_identity: "github-actions",
      success: true,
      metrics: {},
    });
    expect(result.ok).toBe(true);
    expect(result.idempotent_replay).toBe(false);
    expect(runs.get(RUN_ID)?.status).toBe("completed");
    expect(companies.get(COMPANY_ID)?.active_run_id).toBeNull();
  });

  it("correct owner fails a run and clears the lease", async () => {
    const result = await failDiscoveryCompanyRun({
      run_id: RUN_ID,
      worker_identity: "github-actions",
      error_category: "unknown",
      error_summary: "boom",
      metrics: {},
    });
    expect(result.ok).toBe(true);
    expect(result.idempotent_replay).toBe(false);
    expect(runs.get(RUN_ID)?.status).toBe("failed");
    expect(companies.get(COMPANY_ID)?.active_run_id).toBeNull();
    expect(companies.get(COMPANY_ID)?.consecutive_failures).toBe(1);
  });

  it("rejects missing worker identity before mutation", async () => {
    const before = snapshotState();
    await expect(
      completeDiscoveryCompanyRun({
        run_id: RUN_ID,
        worker_identity: "   ",
        success: true,
        metrics: {},
      }),
    ).rejects.toThrow(/worker_identity_required/);
    expect(snapshotState()).toEqual(before);
  });

  it("rejects wrong worker identity and leaves the lease unchanged", async () => {
    const before = snapshotState();
    await expect(
      completeDiscoveryCompanyRun({
        run_id: RUN_ID,
        worker_identity: "intruder",
        success: true,
        metrics: {},
      }),
    ).rejects.toThrow(/owner_mismatch/);
    expect(snapshotState()).toEqual(before);
    expect(txCalls.count).toBe(0);
  });

  it("same-owner idempotent replay succeeds without a second mutation", async () => {
    await completeDiscoveryCompanyRun({
      run_id: RUN_ID,
      worker_identity: "github-actions",
      success: true,
      metrics: {},
    });
    const afterFirst = snapshotState();
    const txAfterFirst = txCalls.count;
    const again = await completeDiscoveryCompanyRun({
      run_id: RUN_ID,
      worker_identity: "github-actions",
      success: true,
      metrics: {},
    });
    expect(again.idempotent_replay).toBe(true);
    expect(snapshotState()).toEqual(afterFirst);
    expect(txCalls.count).toBe(txAfterFirst);
  });

  it("rejects claimed run when company active_run_id no longer references it (no partial terminal)", async () => {
    // Run still claimed, but lease was recovered/replaced.
    companies.get(COMPANY_ID)!.active_run_id = OTHER_RUN_ID;
    runs.set(OTHER_RUN_ID, {
      id: OTHER_RUN_ID,
      company_id: COMPANY_ID,
      status: "claimed",
      worker_identity: "fresh-worker",
    });
    const before = snapshotState();

    await expect(
      completeDiscoveryCompanyRun({
        run_id: RUN_ID,
        worker_identity: "github-actions",
        success: true,
        metrics: {},
      }),
    ).rejects.toThrow(/lease_not_active/);

    expect(snapshotState()).toEqual(before);
    expect(runs.get(RUN_ID)?.status).toBe("claimed");
    expect(companies.get(COMPANY_ID)?.active_run_id).toBe(OTHER_RUN_ID);
    expect(txCalls.count).toBe(0);
  });

  it("stale recovery then late worker response does not overwrite newer state", async () => {
    // Expire original claim.
    runs.get(RUN_ID)!.status = "expired";
    companies.get(COMPANY_ID)!.active_run_id = OTHER_RUN_ID;
    runs.set(OTHER_RUN_ID, {
      id: OTHER_RUN_ID,
      company_id: COMPANY_ID,
      status: "claimed",
      worker_identity: "fresh-worker",
    });
    const before = snapshotState();

    await expect(
      completeDiscoveryCompanyRun({
        run_id: RUN_ID,
        worker_identity: "github-actions",
        success: true,
        metrics: {},
      }),
    ).rejects.toThrow(/not_claimable:expired/);

    expect(snapshotState()).toEqual(before);
  });

  it("rejects cross-operation replay of a failed run via complete", async () => {
    runs.get(RUN_ID)!.status = "failed";
    companies.get(COMPANY_ID)!.active_run_id = null;
    const before = snapshotState();
    await expect(
      completeDiscoveryCompanyRun({
        run_id: RUN_ID,
        worker_identity: "github-actions",
        success: true,
        metrics: {},
      }),
    ).rejects.toThrow(/not_claimable:failed/);
    expect(snapshotState()).toEqual(before);
  });
});
