import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const envExamplePath = path.resolve(__dirname, "../../../../.env.example");
const remoteEnvExamplePath = path.resolve(
  __dirname,
  "../../../.env.example",
);

function assertCleanUtf8EnvExample(filePath: string) {
  const bytes = readFileSync(filePath);
  // Must decode as UTF-8 without replacement characters.
  const text = bytes.toString("utf8");
  expect(text).not.toContain("\uFFFD");
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const ch = text[i];
    if (ch === "\n" || ch === "\r" || ch === "\t") continue;
    expect(code).toBeGreaterThanOrEqual(32);
    // Keep env examples ASCII-safe for comment punctuation.
    expect(code).toBeLessThan(128);
  }
}

describe(".env.example encoding", () => {
  it("root .env.example is valid UTF-8 with no control or replacement characters", () => {
    assertCleanUtf8EnvExample(envExamplePath);
  });

  it("remote_mcp/.env.example is valid UTF-8 with no control or replacement characters", () => {
    assertCleanUtf8EnvExample(remoteEnvExamplePath);
  });
});
