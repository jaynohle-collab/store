import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/db/client", () => ({
  getSql: () => {
    throw new Error("getSql should not be called in rotation unit tests");
  },
  resetSqlClient: () => undefined,
}));

import type { McpServer } from "@modelcontextprotocol/server";
import { TOOL_PERMISSIONS } from "@/lib/config";
import {
  backdateActiveClaimStartedAt,
  claimNextDiscoverySource,
  completeDiscoverySource,
  failDiscoverySource,
  getDiscoveryRotation,
  getMemorySourceFailureCount,
  getMemoryRun,
  resetInMemoryDiscoveryRotation,
  setMemorySourceEnabled,
  useInMemoryDiscoveryRotation,
} from "@/lib/db/discovery_rotation";
import { registerJobTools } from "@/lib/mcp/tools";
import {
  assertCheckpointSize,
  assertCounterChain,
  DEFAULT_CLAIM_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  getMaxAttempts,
  sanitizeDiscoveryError,
  shouldSkipAfterFailure,
} from "@/lib/discovery/rotation";

describe("discovery source rotation", () => {
  beforeEach(() => {
    useInMemoryDiscoveryRotation();
    resetInMemoryDiscoveryRotation();
    delete process.env.DISCOVERY_SOURCE_CLAIM_TIMEOUT_MINUTES;
    delete process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS;
    delete process.env.DISCOVERY_SOURCE_CHECKPOINT_MAX_BYTES;
    vi.clearAllMocks();
  });

  function makeExtra(scopes: string[]) {
    return {
      http: {
        authInfo: { token: "t", clientId: "c", scopes },
      },
    };
  }

  function register() {
    const tools: Record<
      string,
      {
        config: Record<string, unknown>;
        handler: (
          args: Record<string, unknown>,
          extra: ReturnType<typeof makeExtra>,
        ) => Promise<{
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        }>;
      }
    > = {};
    const server = {
      registerTool(
        name: string,
        config: Record<string, unknown>,
        handler: (typeof tools)[string]["handler"],
      ) {
        tools[name] = { config, handler };
      },
    } as unknown as McpServer;
    registerJobTools(server);
    return tools;
  }

  function parse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
    if (result.isError) return { isError: true, text: result.content[0]?.text };
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  async function claimAndComplete(sourceKey: string, qualified = 0) {
    const claim = await claimNextDiscoverySource();
    expect(claim.source_key).toBe(sourceKey);
    const done = await completeDiscoverySource({
      run_id: claim.run_id,
      discovered_count: Math.max(1, qualified),
      preflight_skipped_count: 0,
      evaluated_count: qualified,
      qualified_count: qualified,
      submitted_count: 0,
    });
    return { claim, done };
  }

  async function failCurrentClaim(error = "transient error") {
    const snap = await getDiscoveryRotation();
    expect(snap.active_run_id).toBeTruthy();
    return failDiscoverySource({
      run_id: snap.active_run_id!,
      error,
    });
  }

  it("starts at ashby with attempt_number 1", async () => {
    const snap = await getDiscoveryRotation();
    expect(snap.current_source_key).toBe("ashby");
    expect(snap.cycle_id).toBe(1);
    expect(snap.max_attempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(snap.enabled_sources.map((s) => s.source_key)).toEqual([
      "ashby",
      "greenhouse",
      "lever",
      "workday",
      "company_careers",
    ]);

    const claim = await claimNextDiscoverySource();
    expect(claim.source_key).toBe("ashby");
    expect(claim.attempt_number).toBe(1);
    expect(claim.cycle_id).toBe(1);
  });

  it("advances in configured order", async () => {
    await claimAndComplete("ashby");
    await claimAndComplete("greenhouse");
    await claimAndComplete("lever");
    await claimAndComplete("workday");
    const last = await claimAndComplete("company_careers");
    expect(last.done.next_source_key).toBe("ashby");
    expect(last.done.wrapped).toBe(true);
    expect(last.done.next_cycle_id).toBe(2);
  });

  it("advances when qualified_count is zero", async () => {
    const claim = await claimNextDiscoverySource();
    const done = await completeDiscoverySource({
      run_id: claim.run_id,
      discovered_count: 0,
      preflight_skipped_count: 0,
      evaluated_count: 0,
      qualified_count: 0,
      submitted_count: 0,
    });
    expect(done.run.status).toBe("completed");
    expect(done.next_source_key).toBe("greenhouse");
  });

  it("skips disabled sources on advance", async () => {
    setMemorySourceEnabled("greenhouse", false);
    setMemorySourceEnabled("lever", false);
    const { done } = await claimAndComplete("ashby");
    expect(done.next_source_key).toBe("workday");
  });

  it("wraps to a new cycle and clears failure counts", async () => {
    process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS = "2";
    await claimNextDiscoverySource();
    await failCurrentClaim();
    await claimNextDiscoverySource();
    await failCurrentClaim(); // skip ashby -> greenhouse

    for (const key of ["greenhouse", "lever", "workday"]) {
      await claimAndComplete(key);
    }
    const { done } = await claimAndComplete("company_careers");
    expect(done.wrapped).toBe(true);
    expect(done.next_cycle_id).toBe(2);

    const snap = await getDiscoveryRotation();
    expect(snap.source_failure_counts).toEqual({});
    expect(snap.current_source_key).toBe("ashby");

    const next = await claimNextDiscoverySource();
    expect(next.cycle_id).toBe(2);
    expect(next.source_key).toBe("ashby");
    expect(next.attempt_number).toBe(1);
  });

  it("rejects concurrent claims for the same cursor", async () => {
    await claimNextDiscoverySource();
    await expect(claimNextDiscoverySource()).rejects.toThrow(/already claimed/i);
  });

  async function staleCurrentAndClaimNext() {
    backdateActiveClaimStartedAt(
      new Date(Date.now() - DEFAULT_CLAIM_TIMEOUT_MS - 1000).toISOString(),
    );
    return claimNextDiscoverySource();
  }

  it("stale attempt 1 retries as attempt 2 on the same source", async () => {
    process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS = "3";
    const first = await claimNextDiscoverySource();
    expect(first.attempt_number).toBe(1);
    const next = await staleCurrentAndClaimNext();
    expect(next.source_key).toBe("ashby");
    expect(next.attempt_number).toBe(2);
    expect(next.recovered_stale_run_id).toBe(first.run_id);
    expect(next.stale_source_key).toBe("ashby");
    expect(next.stale_source_skipped).toBe(false);
    expect(getMemorySourceFailureCount("ashby")).toBe(1);
  });

  it("stale attempt 2 retries as attempt 3 on the same source", async () => {
    process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS = "3";
    await claimNextDiscoverySource(); // attempt 1
    const second = await staleCurrentAndClaimNext(); // attempt 2
    expect(second.attempt_number).toBe(2);
    const third = await staleCurrentAndClaimNext(); // attempt 3
    expect(third.source_key).toBe("ashby");
    expect(third.attempt_number).toBe(3);
    expect(third.recovered_stale_run_id).toBe(second.run_id);
    expect(third.stale_source_skipped).toBe(false);
    expect(getMemorySourceFailureCount("ashby")).toBe(2);
  });

  it("stale attempt 3 at max skips and claims the next source", async () => {
    process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS = "3";
    await claimNextDiscoverySource(); // 1
    await staleCurrentAndClaimNext(); // 2
    const third = await staleCurrentAndClaimNext(); // 3
    expect(third.source_key).toBe("ashby");
    expect(third.attempt_number).toBe(3);
    const next = await staleCurrentAndClaimNext(); // skip -> greenhouse
    expect(next.recovered_stale_run_id).toBe(third.run_id);
    expect(next.stale_source_key).toBe("ashby");
    expect(next.stale_source_skipped).toBe(true);
    expect(next.source_key).toBe("greenhouse");
    expect(next.cycle_id).toBe(1);
    expect(next.attempt_number).toBe(1);
    expect(getMemorySourceFailureCount("ashby")).toBe(0);
    expect(getMemoryRun(third.run_id)?.status).toBe("skipped_after_failures");

    const snap = await getDiscoveryRotation();
    expect(snap.current_source_key).toBe("greenhouse");
    expect(snap.latest_run?.status).toBe("claimed");
    expect(getMemorySourceFailureCount("greenhouse")).toBe(0);
  });

  it("stale-at-max on the final source wraps the cycle", async () => {
    process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS = "1";
    for (const key of ["ashby", "greenhouse", "lever", "workday"]) {
      await claimAndComplete(key);
    }
    const stale = await claimNextDiscoverySource();
    expect(stale.source_key).toBe("company_careers");
    expect(stale.cycle_id).toBe(1);
    expect(stale.attempt_number).toBe(1);
    const next = await staleCurrentAndClaimNext();
    expect(next.stale_source_skipped).toBe(true);
    expect(next.stale_source_key).toBe("company_careers");
    expect(next.recovered_stale_run_id).toBe(stale.run_id);
    expect(next.source_key).toBe("ashby");
    expect(next.cycle_id).toBe(2);
    expect(next.attempt_number).toBe(1);
    expect(getMemoryRun(stale.run_id)?.status).toBe("skipped_after_failures");
  });

  it("never creates an attempt_number greater than max", async () => {
    process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS = "3";
    const attempts: number[] = [];
    const sources: string[] = [];
    let claim = await claimNextDiscoverySource();
    attempts.push(claim.attempt_number);
    sources.push(claim.source_key);
    for (let i = 0; i < 3; i++) {
      claim = await staleCurrentAndClaimNext();
      attempts.push(claim.attempt_number);
      sources.push(claim.source_key);
      expect(claim.attempt_number).toBeLessThanOrEqual(3);
    }
    expect(attempts).toEqual([1, 2, 3, 1]);
    expect(sources).toEqual(["ashby", "ashby", "ashby", "greenhouse"]);
  });

  it("still allows only one claimed run globally after stale recovery", async () => {
    await claimNextDiscoverySource();
    await expect(claimNextDiscoverySource()).rejects.toThrow(/already claimed/i);
    await staleCurrentAndClaimNext();
    await expect(claimNextDiscoverySource()).rejects.toThrow(/already claimed/i);
  });

  it("retries below max attempts then skips with skipped_after_failures", async () => {
    process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS = "3";

    const c1 = await claimNextDiscoverySource();
    expect(c1.attempt_number).toBe(1);
    const f1 = await failDiscoverySource({ run_id: c1.run_id, error: "err1" });
    expect(f1.retry_required).toBe(true);
    expect(f1.auto_advanced).toBe(false);
    if ("cursor_source_key" in f1) expect(f1.cursor_source_key).toBe("ashby");
    expect(f1.run.status).toBe("failed");

    const c2 = await claimNextDiscoverySource();
    expect(c2.attempt_number).toBe(2);
    const f2 = await failDiscoverySource({ run_id: c2.run_id, error: "err2" });
    expect(f2.retry_required).toBe(true);
    expect(f2.consecutive_failures).toBe(2);

    const c3 = await claimNextDiscoverySource();
    expect(c3.attempt_number).toBe(3);
    const f3 = await failDiscoverySource({ run_id: c3.run_id, error: "err3" });
    expect(f3.retry_required).toBe(false);
    expect(f3.auto_advanced).toBe(true);
    expect(f3.run.status).toBe("skipped_after_failures");
    if ("next_source_key" in f3) expect(f3.next_source_key).toBe("greenhouse");

    const snap = await getDiscoveryRotation();
    expect(snap.current_source_key).toBe("greenhouse");
    expect(getMemorySourceFailureCount("ashby")).toBe(0);
  });

  it("resets failure count after successful completion", async () => {
    process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS = "3";
    const c1 = await claimNextDiscoverySource();
    await failDiscoverySource({ run_id: c1.run_id, error: "err" });
    expect(getMemorySourceFailureCount("ashby")).toBe(1);

    const c2 = await claimNextDiscoverySource();
    await completeDiscoverySource({
      run_id: c2.run_id,
      discovered_count: 0,
      preflight_skipped_count: 0,
      evaluated_count: 0,
      qualified_count: 0,
      submitted_count: 0,
    });
    expect(getMemorySourceFailureCount("ashby")).toBe(0);

    const snap = await getDiscoveryRotation();
    expect(snap.current_source_key).toBe("greenhouse");
  });

  it("rejects invalid run IDs on complete and fail", async () => {
    const missing = randomUUID();
    await expect(
      completeDiscoverySource({
        run_id: missing,
        discovered_count: 0,
        preflight_skipped_count: 0,
        evaluated_count: 0,
        qualified_count: 0,
        submitted_count: 0,
      }),
    ).rejects.toThrow(/Unknown discovery run/i);
    await expect(
      failDiscoverySource({ run_id: missing, error: "boom" }),
    ).rejects.toThrow(/Unknown discovery run/i);
  });

  it("rejects double completion", async () => {
    const claim = await claimNextDiscoverySource();
    await completeDiscoverySource({
      run_id: claim.run_id,
      discovered_count: 0,
      preflight_skipped_count: 0,
      evaluated_count: 0,
      qualified_count: 0,
      submitted_count: 0,
    });
    await expect(
      completeDiscoverySource({
        run_id: claim.run_id,
        discovered_count: 0,
        preflight_skipped_count: 0,
        evaluated_count: 0,
        qualified_count: 0,
        submitted_count: 0,
      }),
    ).rejects.toThrow(/cannot be completed/i);
  });

  it("rejects completion after failure", async () => {
    const claim = await claimNextDiscoverySource();
    await failDiscoverySource({ run_id: claim.run_id, error: "boom" });
    await expect(
      completeDiscoverySource({
        run_id: claim.run_id,
        discovered_count: 0,
        preflight_skipped_count: 0,
        evaluated_count: 0,
        qualified_count: 0,
        submitted_count: 0,
      }),
    ).rejects.toThrow(/cannot be completed/i);
  });

  it("rejects failure after completion", async () => {
    const claim = await claimNextDiscoverySource();
    await completeDiscoverySource({
      run_id: claim.run_id,
      discovered_count: 0,
      preflight_skipped_count: 0,
      evaluated_count: 0,
      qualified_count: 0,
      submitted_count: 0,
    });
    await expect(
      failDiscoverySource({ run_id: claim.run_id, error: "late fail" }),
    ).rejects.toThrow(/cannot be failed/i);
  });

  it("rejects invalid counter chains", async () => {
    const claim = await claimNextDiscoverySource();
    await expect(
      completeDiscoverySource({
        run_id: claim.run_id,
        discovered_count: 1,
        preflight_skipped_count: 0,
        evaluated_count: 2,
        qualified_count: 0,
        submitted_count: 0,
      }),
    ).rejects.toThrow(/evaluated_count cannot exceed discovered_count/i);
  });

  it("rejects oversized checkpoint payloads", async () => {
    process.env.DISCOVERY_SOURCE_CHECKPOINT_MAX_BYTES = "64";
    const claim = await claimNextDiscoverySource();
    await expect(
      failDiscoverySource({
        run_id: claim.run_id,
        error: "boom",
        checkpoint: { blob: "x".repeat(128) },
      }),
    ).rejects.toThrow(/checkpoint exceeds maximum size/i);
  });

  it("rejects claim when all sources are disabled", async () => {
    for (const key of ["ashby", "greenhouse", "lever", "workday", "company_careers"]) {
      setMemorySourceEnabled(key, false);
    }
    await expect(claimNextDiscoverySource()).rejects.toThrow(/No enabled discovery sources/i);
  });

  it("jumps to first enabled when current source is disabled without active claim", async () => {
    setMemorySourceEnabled("ashby", false);
    const snap = await getDiscoveryRotation();
    expect(snap.current_source_key).toBe("greenhouse");
    const claim = await claimNextDiscoverySource();
    expect(claim.source_key).toBe("greenhouse");
  });

  it("sanitizes and length-limits discovery errors", () => {
    const sanitized = sanitizeDiscoveryError("token=abc postgres://user:pass@host/db");
    expect(sanitized).toMatch(/REDACTED/);
    expect(sanitizeDiscoveryError("x".repeat(5000)).length).toBeLessThanOrEqual(2001);
  });

  it("validates counter chain helper", () => {
    expect(() =>
      assertCounterChain({
        discovered_count: 1,
        preflight_skipped_count: 0,
        evaluated_count: 1,
        qualified_count: 1,
        submitted_count: 0,
      }),
    ).not.toThrow();
    expect(() =>
      assertCounterChain({
        discovered_count: 0,
        preflight_skipped_count: 0,
        evaluated_count: 1,
        qualified_count: 0,
        submitted_count: 0,
      }),
    ).toThrow(/evaluated_count cannot exceed discovered_count/);
  });

  it("respects configurable max attempts", () => {
    process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS = "5";
    expect(getMaxAttempts()).toBe(5);
    expect(shouldSkipAfterFailure(4, 5)).toBe(false);
    expect(shouldSkipAfterFailure(5, 5)).toBe(true);
  });

  it("maps rotation tools to correct scopes", () => {
    expect(TOOL_PERMISSIONS.get_discovery_rotation).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.claim_next_discovery_source).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.complete_discovery_source).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.fail_discovery_source).toBe("jobs:write");
  });

  it("registers tools with read-only annotations where applicable", () => {
    const tools = register();
    expect(tools.get_discovery_rotation.config.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(String(tools.get_discovery_rotation.config.description)).toMatch(/does not crawl/i);
    expect(String(tools.fail_discovery_source.config.description)).toMatch(/max attempts/i);
  });

  it("enforces permissions on rotation tools", async () => {
    const tools = register();
    const readOnly = makeExtra(["jobs:read"]);
    const writer = makeExtra(["jobs:write"]);

    const deniedClaim = parse(await tools.claim_next_discovery_source.handler({}, readOnly));
    expect(deniedClaim.isError).toBe(true);

    const allowedGet = parse(await tools.get_discovery_rotation.handler({}, readOnly));
    expect(allowedGet.ok).toBe(true);
    expect(allowedGet.max_attempts).toBe(DEFAULT_MAX_ATTEMPTS);

    const claim = parse(await tools.claim_next_discovery_source.handler({}, writer));
    const complete = parse(
      await tools.complete_discovery_source.handler(
        {
          run_id: claim.run_id,
          discovered_count: 0,
          preflight_skipped_count: 0,
          evaluated_count: 0,
          qualified_count: 0,
          submitted_count: 0,
        },
        writer,
      ),
    );
    expect(complete.next_source_key).toBe("greenhouse");
  });

  it("enforces checkpoint size via helper", () => {
    process.env.DISCOVERY_SOURCE_CHECKPOINT_MAX_BYTES = "32";
    expect(() => assertCheckpointSize({ a: "123456789012345678901234567890" })).toThrow(
      /checkpoint exceeds maximum size/,
    );
  });
});
