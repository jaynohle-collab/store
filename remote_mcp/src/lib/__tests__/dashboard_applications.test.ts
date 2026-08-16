import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const applications: Record<string, unknown>[] = [];
const events: Record<string, unknown>[] = [];
let failEventInsert = false;

function stringsOf(strings: TemplateStringsArray): string {
  return strings.join(" ");
}

const sqlMock = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = stringsOf(strings);

    if (text.includes("FROM job_postings") && text.includes("LIMIT 1") && !text.includes("WITH")) {
      return [
        {
          id: values[0],
          canonical_job_id: "canonical-1",
          url: "https://example.com/job",
        },
      ];
    }

    if (text.includes("FROM applications WHERE posting_id") && text.includes("LIMIT 1")) {
      return applications.filter((a) => a.posting_id === values[0]).slice(0, 1);
    }

    if (text.includes("WITH inserted_app")) {
      if (applications.some((a) => a.posting_id === values[1])) {
        throw new Error("duplicate key value violates unique constraint uq_applications_posting_id");
      }
      if (failEventInsert) {
        // Simulate atomic failure: neither row is committed.
        throw new Error("forced event insert failure");
      }
      const app = {
        id: `app-${applications.length + 1}`,
        canonical_job_id: values[0],
        posting_id: values[1],
        applied_at: values[2],
        status: "applied",
        application_url: values[3],
        resume_version: values[4],
        notes: values[5],
        created_at: new Date().toISOString(),
      };
      const event = {
        id: `evt-${events.length + 1}`,
        application_id: app.id,
        event_type: "applied",
        event_at: values[2],
        notes: values[5],
        metadata: {},
      };
      applications.push(app);
      events.push(event);
      return [{ application: app, event }];
    }

    if (text.includes("WITH updated_app")) {
      const status = values[0];
      const notes = values[1];
      const appId = values[2];
      if (failEventInsert) {
        throw new Error("forced event insert failure");
      }
      const idx = applications.findIndex((a) => a.id === appId);
      if (idx < 0) return [];
      applications[idx] = {
        ...applications[idx],
        status,
        notes: notes ?? applications[idx].notes,
        updated_at: new Date().toISOString(),
      };
      const event = {
        id: `evt-${events.length + 1}`,
        application_id: appId,
        event_type: status,
        event_at: new Date().toISOString(),
        notes,
        metadata: {},
      };
      events.push(event);
      return [{ application: applications[idx], event }];
    }

    return [];
  },
  {
    transaction: async () => {
      throw new Error("sql.transaction should not be required for atomic CTEs");
    },
  },
);

vi.mock("@/lib/db/client", () => ({
  getSql: () => sqlMock,
  resetSqlClient: () => undefined,
}));

import { ConflictError, markApplied, updateApplicationWithEvent } from "@/lib/db/dashboard";

describe("atomic application writes", () => {
  beforeEach(() => {
    applications.length = 0;
    events.length = 0;
    failEventInsert = false;
  });

  it("markApplied creates application + applied event together", async () => {
    const result = await markApplied({
      postingId: "11111111-1111-4111-8111-111111111111",
      notes: "sent",
    });
    expect(result.application.status).toBe("applied");
    expect(result.event.event_type).toBe("applied");
    expect(applications).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("markApplied rolls back when event creation fails (no orphan application)", async () => {
    failEventInsert = true;
    await expect(
      markApplied({ postingId: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toThrow(/forced event insert failure/);
    expect(applications).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("markApplied returns ConflictError for duplicate posting_id", async () => {
    await markApplied({ postingId: "11111111-1111-4111-8111-111111111111" });
    await expect(
      markApplied({ postingId: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(applications).toHaveLength(1);
  });

  it("updateApplicationWithEvent updates status + inserts event atomically", async () => {
    const created = await markApplied({
      postingId: "22222222-2222-4222-8222-222222222222",
    });
    const updated = await updateApplicationWithEvent({
      applicationId: String(created.application.id),
      status: "interview",
      notes: "phone screen",
    });
    expect(updated.application.status).toBe("interview");
    expect(updated.event.event_type).toBe("interview");
    expect(events).toHaveLength(2);
  });

  it("updateApplicationWithEvent rolls back status when event insert fails", async () => {
    const created = await markApplied({
      postingId: "33333333-3333-4333-8333-333333333333",
    });
    failEventInsert = true;
    await expect(
      updateApplicationWithEvent({
        applicationId: String(created.application.id),
        status: "rejected",
      }),
    ).rejects.toThrow(/forced event insert failure/);
    expect(applications[0].status).toBe("applied");
    expect(events).toHaveLength(1);
  });
});

describe("atomic SQL shape", () => {
  it("uses single-statement CTEs for markApplied and status updates", () => {
    const source = readFileSync(path.resolve(__dirname, "../db/dashboard.ts"), "utf8");
    expect(source).toContain("WITH inserted_app AS");
    expect(source).toContain("WITH updated_app AS");
    expect(source).toContain("inserted_event AS");
  });
});
