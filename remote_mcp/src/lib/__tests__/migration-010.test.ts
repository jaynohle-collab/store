import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TOOL_PERMISSIONS } from "@/lib/config";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/010_automatic_discovery_companies.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

const workflowPath = path.resolve(
  __dirname,
  "../../../../.github/workflows/automatic-job-discovery.yml",
);
const workflowYaml = readFileSync(workflowPath, "utf8");

describe("010_automatic_discovery_companies.sql contract", () => {
  it("is additive and transactional", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).not.toMatch(/DELETE FROM/i);
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS discovery_companies");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS discovery_company_runs");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS automatic_discovery_runs");
  });

  it("defines registry constraints for provider, priority, and org id", () => {
    expect(migrationSql).toContain("discovery_companies_company_key_unique");
    expect(migrationSql).toContain("discovery_companies_ats_provider_check");
    expect(migrationSql).toContain("discovery_companies_scan_priority_check");
    expect(migrationSql).toContain("discovery_companies_failures_nonneg");
    expect(migrationSql).toContain("discovery_companies_ats_org_when_required");
    expect(migrationSql).toContain("'greenhouse'");
    expect(migrationSql).toContain("'ashby'");
    expect(migrationSql).toContain("'lever'");
    expect(migrationSql).toContain("'workday'");
    expect(migrationSql).toContain("'company_careers'");
    expect(migrationSql).toContain("'manual'");
    expect(migrationSql).toContain("'hot'");
    expect(migrationSql).toContain("'high'");
    expect(migrationSql).toContain("'normal'");
    expect(migrationSql).toContain("'inactive'");
    expect(migrationSql).toContain("discovery_company_runs_status_check");
    expect(migrationSql).toContain("'claimed'");
    expect(migrationSql).toContain("automatic_discovery_runs_status_check");
    expect(migrationSql).toContain("'running'");
    expect(migrationSql).toContain("'partial'");
  });

  it("seeds official-API starter companies disabled by default", () => {
    expect(migrationSql).toContain("INSERT INTO discovery_companies");
    expect(migrationSql).toContain("('stripe'");
    expect(migrationSql).toContain("('notion'");
    expect(migrationSql).toContain("('netflix'");
    expect(migrationSql).toContain("('figma'");
    expect(migrationSql).toContain("('airbnb'");
    expect(migrationSql).toContain("('datadog'");
    expect(migrationSql).toContain("('cloudflare'");
    expect(migrationSql).toContain("('ramp'");
    expect(migrationSql).toContain("('openai'");
    expect(migrationSql).toContain("('shopify'");
    expect(migrationSql).toContain("ON CONFLICT (company_key) DO NOTHING");
    expect(migrationSql).not.toMatch(/api[_-]?key/i);
    // Starter seeds must be disabled so schedule enable cannot fan out unexpectedly.
    expect(migrationSql).toMatch(/DISABLED by default/i);
    expect(migrationSql).not.toMatch(
      /\('stripe',\s*'Stripe',[^;]*?TRUE\)/,
    );
    const seedBlock = migrationSql.slice(migrationSql.indexOf("INSERT INTO discovery_companies"));
    const trueInSeedValues = (seedBlock.match(/TRUE/g) || []).length;
    expect(trueInSeedValues).toBe(0);
  });

  it("indexes due companies, leases, and run history", () => {
    expect(migrationSql).toContain("idx_discovery_companies_due");
    expect(migrationSql).toContain("idx_discovery_companies_provider");
    expect(migrationSql).toContain("idx_discovery_companies_active_lease");
    expect(migrationSql).toContain("idx_discovery_company_runs_status_started");
    expect(migrationSql).toContain("idx_automatic_discovery_runs_started");
    expect(migrationSql).toContain(
      "idx_discovery_company_runs_one_claimed_per_company",
    );
    expect(migrationSql).toContain("WHERE status = 'claimed'");
    expect(migrationSql).toContain("WHERE enabled = TRUE");
  });
});

describe("automatic-job-discovery workflow contract", () => {
  it("schedules every 6h with kill switch, concurrency, and secret checks", () => {
    expect(workflowYaml).toContain("workflow_dispatch:");
    expect(workflowYaml).toContain("schedule:");
    expect(workflowYaml).toMatch(/cron:\s*["']0 \*\/6 \* \* \*["']/);
    expect(workflowYaml).toContain("AUTO_DISCOVERY_SCHEDULE_ENABLED");
    // Exact equality to 'true' — unset / false / TRUE must not enable schedule.
    expect(workflowYaml).toContain(
      "vars.AUTO_DISCOVERY_SCHEDULE_ENABLED == 'true'",
    );
    expect(workflowYaml).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflowYaml).toContain("concurrency:");
    expect(workflowYaml).toContain("cancel-in-progress: false");
    expect(workflowYaml).toContain("permissions:");
    expect(workflowYaml).toContain("contents: read");
    expect(workflowYaml).toContain("timeout-minutes: 60");
    expect(workflowYaml).toContain("Verify required secrets are present");
    expect(workflowYaml).toContain("Never print secret values");
    expect(workflowYaml).toContain("AUTH0_CLIENT_ID");
    expect(workflowYaml).toContain("AUTH0_CLIENT_SECRET");
    expect(workflowYaml).toContain("GEMINI_API_KEY");
    expect(workflowYaml).toContain("GROQ_API_KEY");
    expect(workflowYaml).toContain("OPENAI_API_KEY");
    expect(workflowYaml).toContain(
      "python -m job_agent.examples.automatic_discovery_run",
    );
    expect(workflowYaml).toContain(
      "python -m job_agent.examples.process_discovery_inbox",
    );
    expect(workflowYaml).not.toContain("DATABASE_URL");
    expect(workflowYaml).not.toMatch(/echo\s+\$\{\{\s*secrets\./);
    expect(workflowYaml).not.toContain("jobs:delete");
    expect(workflowYaml).not.toContain("jobs:revert");
  });
});

describe("Milestone 5 MCP permissions (migration companion)", () => {
  it("maps status and retention tools to jobs:read", () => {
    expect(TOOL_PERMISSIONS.get_automatic_discovery_status).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.preview_description_retention).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.claim_due_discovery_companies).toBe("jobs:worker");
  });
});
