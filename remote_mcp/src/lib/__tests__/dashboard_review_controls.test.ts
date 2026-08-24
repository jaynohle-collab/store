import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(path.resolve(__dirname, "../db/dashboard.ts"), "utf8");
const toApplySource = readFileSync(path.resolve(__dirname, "../db/dashboard_to_apply.ts"), "utf8");
const toApplyPageSource = readFileSync(
  path.resolve(__dirname, "../../app/dashboard/to-apply/page.tsx"),
  "utf8",
);
const appliedPageSource = readFileSync(
  path.resolve(__dirname, "../../app/dashboard/applied/page.tsx"),
  "utf8",
);
const undoRouteSource = readFileSync(
  path.resolve(__dirname, "../../app/api/applications/[id]/undo/route.ts"),
  "utf8",
);

describe("Milestone 3B dashboard review controls", () => {
  it("uses server-side CASE ordering for To Apply sorts", () => {
    expect(toApplySource).toContain("CASE WHEN ${sort} = 'company'");
    expect(toApplySource).toContain("CASE WHEN ${sort} = 'gpt'");
    expect(toApplySource).toContain("SELECT COUNT(*)::int AS total");
    expect(toApplySource).toContain("latest_gpt");
    expect(toApplySource).toContain("le.metadata::text ILIKE");
    expect(toApplySource).toContain("ESCAPE '\\\\'");
    expect(toApplySource).toContain("REMOTE_SQL_PATTERNS");
  });

  it("defaults To Apply page to remote US filter and listToApplyJobs", () => {
    expect(toApplyPageSource).toContain("listToApplyJobs");
    expect(toApplyPageSource).toContain("parseRemoteFilter");
    expect(toApplyPageSource).toContain("DashboardPagination");
  });

  it("allows planned applications in To Apply SQL eligibility", () => {
    expect(dashboardSource).toContain("pa.application_status = 'planned'");
    expect(toApplySource).toContain("pa.application_status = 'planned'");
  });

  it("uses undo_applied events without deleting history", () => {
    expect(dashboardSource).toContain("'undo_applied'");
    expect(dashboardSource).toContain("export async function undoApplied");
    expect(undoRouteSource).toContain("undoApplied");
    expect(undoRouteSource).toContain("withDashboardApi");
  });

  it("Applied page uses server-side listApplicationsPage with pagination", () => {
    expect(appliedPageSource).toContain("listApplicationsPage");
    expect(appliedPageSource).toContain("showUndo");
    expect(dashboardSource).toContain("CASE WHEN ${sort} = 'status'");
  });

  it("does not modify MCP discovery tool registrations", () => {
    const lifecycleTools = readFileSync(
      path.resolve(__dirname, "../mcp/lifecycle_tools.ts"),
      "utf8",
    );
    expect(lifecycleTools).toContain("check_discovery_candidates");
    expect(lifecycleTools).not.toContain("undoApplied");
  });
});
