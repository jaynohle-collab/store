import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  completeDiscoveryCompanyRunSchema,
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

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const COMPANY_ID = "22222222-2222-2222-2222-222222222222";

type CompanyRow = {
  id: string;
  active_run_id: string | null;
  consecutive_failures: number;
  scan_priority: string;
};

type RunRow = {
  id: string;
  company_id: string;
  status: "claimed" | "completed" | "failed" | "expired";
  worker_identity: string;
  error_category?: string | null;
  error_summary?: string | null;
};

/**
 * Models the ownership predicates used by complete/fail:
 * update run only when claimed + matching worker_identity;
 * clear company lease only when active_run_id still references that run.
 */
function finishOwnedRun(
  companies: Map<string, CompanyRow>,
  runs: Map<string, RunRow>,
  opts: {
    runId: string;
    workerIdentity: string;
    mode: "completed" | "failed";
  },
): { ok: true; idempotent_replay: boolean } | { error: string } {
  const run = runs.get(opts.runId);
  if (!run) return { error: "not_found" };
  const company = companies.get(run.company_id);
  if (!company) return { error: "not_found" };

  if (run.status === opts.mode) {
    if (run.worker_identity !== opts.workerIdentity) {
      return { error: "discovery_company_run_owner_mismatch" };
    }
    return { ok: true, idempotent_replay: true };
  }

  if (run.status !== "claimed") {
    return { error: `discovery_company_run_not_claimable:${run.status}` };
  }
  if (run.worker_identity !== opts.workerIdentity) {
    return { error: "discovery_company_run_owner_mismatch" };
  }
  if (company.active_run_id !== run.id) {
    return { error: "discovery_company_run_lease_not_active" };
  }

  // Atomic predicate simulation (single success path).
  if (
    run.status !== "claimed" ||
    run.worker_identity !== opts.workerIdentity ||
    company.active_run_id !== run.id
  ) {
    return { error: "race" };
  }

  run.status = opts.mode;
  company.active_run_id = null;
  if (opts.mode === "failed") {
    company.consecutive_failures += 1;
  } else {
    company.consecutive_failures = 0;
  }
  return { ok: true, idempotent_replay: false };
}

function recoverStale(
  companies: Map<string, CompanyRow>,
  runs: Map<string, RunRow>,
  runId: string,
) {
  const run = runs.get(runId);
  if (!run || run.status !== "claimed") return false;
  const company = companies.get(run.company_id);
  if (!company || company.active_run_id !== run.id) return false;
  run.status = "expired";
  company.active_run_id = null;
  company.consecutive_failures += 1;
  return true;
}

function seedClaimed(worker = "github-actions") {
  const companies = new Map<string, CompanyRow>([
    [
      COMPANY_ID,
      {
        id: COMPANY_ID,
        active_run_id: RUN_ID,
        consecutive_failures: 0,
        scan_priority: "manual",
      },
    ],
  ]);
  const runs = new Map<string, RunRow>([
    [
      RUN_ID,
      {
        id: RUN_ID,
        company_id: COMPANY_ID,
        status: "claimed",
        worker_identity: worker,
      },
    ],
  ]);
  return { companies, runs };
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

  it("rejects empty worker_identity", () => {
    expect(() =>
      completeDiscoveryCompanyRunSchema.parse({
        run_id: RUN_ID,
        worker_identity: "",
        success: true,
      }),
    ).toThrow();
  });
});

describe("complete/fail SQL ownership contracts", () => {
  it("gates run updates on claimed status and matching worker_identity", () => {
    expect(completeSrc).toMatch(
      /WHERE id = \$\{input\.run_id\}::uuid[\s\S]*AND status = 'claimed'[\s\S]*AND worker_identity = \$\{workerIdentity\}/,
    );
    expect(failSrc).toMatch(
      /WHERE id = \$\{input\.run_id\}::uuid[\s\S]*AND status = 'claimed'[\s\S]*AND worker_identity = \$\{workerIdentity\}/,
    );
  });

  it("clears company lease only when active_run_id still references the run", () => {
    expect(completeSrc).toContain("AND c.active_run_id = d.id");
    expect(failSrc).toContain("AND c.active_run_id = d.id");
    expect(completeSrc).toContain("WHERE EXISTS (SELECT 1 FROM company)");
    expect(failSrc).toContain("WHERE EXISTS (SELECT 1 FROM company)");
  });

  it("rejects owner mismatch and non-claimable statuses without treating them as success", () => {
    expect(completeSrc).toContain("discovery_company_run_owner_mismatch");
    expect(failSrc).toContain("discovery_company_run_owner_mismatch");
    expect(completeSrc).toContain("discovery_company_run_not_claimable:");
    expect(failSrc).toContain("discovery_company_run_not_claimable:");
    expect(completeSrc).toContain("discovery_company_run_lease_not_active");
    expect(failSrc).toContain("discovery_company_run_lease_not_active");
  });
});

describe("owned company-run lifecycle simulation", () => {
  it("correct owner completes a run", () => {
    const { companies, runs } = seedClaimed();
    const result = finishOwnedRun(companies, runs, {
      runId: RUN_ID,
      workerIdentity: "github-actions",
      mode: "completed",
    });
    expect(result).toEqual({ ok: true, idempotent_replay: false });
    expect(runs.get(RUN_ID)?.status).toBe("completed");
    expect(companies.get(COMPANY_ID)?.active_run_id).toBeNull();
  });

  it("correct owner fails a run", () => {
    const { companies, runs } = seedClaimed();
    const result = finishOwnedRun(companies, runs, {
      runId: RUN_ID,
      workerIdentity: "github-actions",
      mode: "failed",
    });
    expect(result).toEqual({ ok: true, idempotent_replay: false });
    expect(runs.get(RUN_ID)?.status).toBe("failed");
    expect(companies.get(COMPANY_ID)?.active_run_id).toBeNull();
    expect(companies.get(COMPANY_ID)?.consecutive_failures).toBe(1);
  });

  it("wrong worker identity is rejected and the lease remains unchanged", () => {
    const { companies, runs } = seedClaimed("owner-a");
    const before = structuredClone({
      company: companies.get(COMPANY_ID),
      run: runs.get(RUN_ID),
    });
    const result = finishOwnedRun(companies, runs, {
      runId: RUN_ID,
      workerIdentity: "intruder",
      mode: "completed",
    });
    expect(result).toEqual({ error: "discovery_company_run_owner_mismatch" });
    expect(companies.get(COMPANY_ID)).toEqual(before.company);
    expect(runs.get(RUN_ID)).toEqual(before.run);
  });

  it("same-owner idempotent replay succeeds without changing terminal state twice", () => {
    const { companies, runs } = seedClaimed();
    expect(
      finishOwnedRun(companies, runs, {
        runId: RUN_ID,
        workerIdentity: "github-actions",
        mode: "completed",
      }),
    ).toEqual({ ok: true, idempotent_replay: false });
    const afterFirst = structuredClone({
      company: companies.get(COMPANY_ID),
      run: runs.get(RUN_ID),
    });
    expect(
      finishOwnedRun(companies, runs, {
        runId: RUN_ID,
        workerIdentity: "github-actions",
        mode: "completed",
      }),
    ).toEqual({ ok: true, idempotent_replay: true });
    expect(companies.get(COMPANY_ID)).toEqual(afterFirst.company);
    expect(runs.get(RUN_ID)).toEqual(afterFirst.run);
  });

  it("stale lease recovery then late worker response does not overwrite newer state", () => {
    const { companies, runs } = seedClaimed("stale-worker");
    expect(recoverStale(companies, runs, RUN_ID)).toBe(true);
    expect(runs.get(RUN_ID)?.status).toBe("expired");
    expect(companies.get(COMPANY_ID)?.active_run_id).toBeNull();

    // Newer claim by another worker.
    const newRunId = "33333333-3333-3333-3333-333333333333";
    runs.set(newRunId, {
      id: newRunId,
      company_id: COMPANY_ID,
      status: "claimed",
      worker_identity: "fresh-worker",
    });
    companies.get(COMPANY_ID)!.active_run_id = newRunId;

    const before = structuredClone({
      company: companies.get(COMPANY_ID),
      stale: runs.get(RUN_ID),
      fresh: runs.get(newRunId),
    });

    const late = finishOwnedRun(companies, runs, {
      runId: RUN_ID,
      workerIdentity: "stale-worker",
      mode: "completed",
    });
    expect(late).toEqual({
      error: "discovery_company_run_not_claimable:expired",
    });
    expect(companies.get(COMPANY_ID)).toEqual(before.company);
    expect(runs.get(RUN_ID)).toEqual(before.stale);
    expect(runs.get(newRunId)).toEqual(before.fresh);
  });
});
