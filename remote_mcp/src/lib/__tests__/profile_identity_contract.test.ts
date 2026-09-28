import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getActiveProfileId, getActiveProfileVersion } from "@/lib/dashboard/time";

const PROFILE_JSON = path.resolve(__dirname, "../../../../data/job_search_profile.json");

describe("active profile identity contract", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("dashboard defaults match data/job_search_profile.json", () => {
    delete process.env.DASHBOARD_PROFILE_ID;
    delete process.env.DASHBOARD_PROFILE_VERSION;
    const profile = JSON.parse(readFileSync(PROFILE_JSON, "utf-8")) as {
      profile_id: string;
      profile_version: string;
    };
    expect(getActiveProfileId()).toBe(profile.profile_id);
    expect(getActiveProfileVersion()).toBe(profile.profile_version);
  });

  it("allows an explicit override for a new profile generation", () => {
    process.env.DASHBOARD_PROFILE_ID = "jay";
    process.env.DASHBOARD_PROFILE_VERSION = "jay-ai-v2";
    expect(getActiveProfileId()).toBe("jay");
    expect(getActiveProfileVersion()).toBe("jay-ai-v2");
  });
});
