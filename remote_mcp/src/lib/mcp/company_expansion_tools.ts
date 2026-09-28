import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";

import { assertToolPermission } from "../auth/permissions";
import {
  claimDiscoveryCompanyCandidates,
  claimDiscoveryCompanyCandidatesSchema,
  listDiscoveryCompanyCandidates,
  listDiscoveryCompanyCandidatesSchema,
  listDiscoveryPostingUrlHints,
  listDiscoveryPostingUrlHintsSchema,
  recordDiscoveryCompanyVerification,
  recordDiscoveryCompanyVerificationSchema,
  upsertDiscoveryCompanyCandidates,
  upsertDiscoveryCompanyCandidatesSchema,
} from "../db/discovery_company_candidates";

const NOTE =
  " Company expansion state only — MCP never crawls, verifies endpoints, scores, or" +
  " creates canonical jobs. Python verifies official ATS endpoints; only verified" +
  " candidates are promoted into the scan registry (no duplicate keys or ATS orgs).";

function getAuth(context: { http?: { authInfo?: AuthInfo } }): AuthInfo | undefined {
  return context.http?.authInfo;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function registerCompanyExpansionTools(server: McpServer): void {
  server.registerTool(
    "list_discovery_company_candidates",
    {
      title: "List Discovery Company Candidates",
      description: "List company candidates and their verification status." + NOTE,
      inputSchema: listDiscoveryCompanyCandidatesSchema,
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_discovery_company_candidates");
        const candidates = await listDiscoveryCompanyCandidates(args);
        return jsonResult({ ok: true, count: candidates.length, candidates });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to list company candidates",
        );
      }
    },
  );

  server.registerTool(
    "list_discovery_posting_url_hints",
    {
      title: "List Discovery Posting URL Hints",
      description:
        "Read-only: official ATS posting URLs from canonical job history and GPT evidence," +
        " used to derive verified ATS identifiers for new companies." + NOTE,
      inputSchema: listDiscoveryPostingUrlHintsSchema,
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_discovery_posting_url_hints");
        const hints = await listDiscoveryPostingUrlHints(args);
        return jsonResult({ ok: true, count: hints.length, hints });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to list posting URL hints",
        );
      }
    },
  );

  server.registerTool(
    "upsert_discovery_company_candidates",
    {
      title: "Upsert Discovery Company Candidates",
      description:
        "Idempotently register 1–100 company candidates (pending verification). Existing" +
        " candidates and registered companies are left untouched." + NOTE,
      inputSchema: upsertDiscoveryCompanyCandidatesSchema,
      annotations: WRITE,
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "upsert_discovery_company_candidates");
        const payload = await upsertDiscoveryCompanyCandidates(args);
        return jsonResult({ ok: true, ...payload });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to upsert company candidates",
        );
      }
    },
  );

  server.registerTool(
    "claim_discovery_company_candidates",
    {
      title: "Claim Discovery Company Candidates",
      description:
        "Worker-only: lease due company candidates (pending, retryable, or stale) for" +
        " endpoint verification." + NOTE,
      inputSchema: claimDiscoveryCompanyCandidatesSchema,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "claim_discovery_company_candidates");
        const payload = await claimDiscoveryCompanyCandidates(args);
        return jsonResult({ ok: true, ...payload });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to claim company candidates",
        );
      }
    },
  );

  server.registerTool(
    "record_discovery_company_verification",
    {
      title: "Record Discovery Company Verification",
      description:
        "Worker-only: record a leased candidate's verification outcome. Verified" +
        " candidates are promoted (enabled, normal priority) unless already registered;" +
        " failures back off exponentially and are rejected after repeated failures." +
        NOTE,
      inputSchema: recordDiscoveryCompanyVerificationSchema,
      annotations: WRITE,
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "record_discovery_company_verification");
        const payload = await recordDiscoveryCompanyVerification(args);
        return jsonResult(payload);
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to record company verification",
        );
      }
    },
  );
}
