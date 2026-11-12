import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_32_BYTES = /^[a-f0-9]{64}$/;
const SAFE_QUERY: Record<string, readonly string[]> = {
  sslmode: ["require", "verify-ca", "verify-full"],
  channel_binding: ["prefer", "require"],
};

function invalid(): never {
  throw new Error("backend_target_unavailable");
}

/** Pure, deliberately narrow parser. This identifies configuration, not a live SQL session. */
export function canonicalizeBackendTarget(databaseUrl: string): string {
  // Reject characters URL parsers can silently strip/normalize, including backslashes.
  if (typeof databaseUrl !== "string" || databaseUrl.length > 8192 || /[^\x21-\x7e]|\\/.test(databaseUrl)) invalid();
  const parts = /^(?:postgres|postgresql):\/\/([^/?#@]+)@([^/?#@:]+)(?::([0-9]{1,5}))?\/([^/?#]+)(?:\?([^#]+))?$/.exec(databaseUrl);
  if (!parts) invalid();
  const [, credentials, rawHost, rawPort, rawDatabase, query] = parts;
  if (credentials !== undefined) {
    // Validate escapes without ever including user/password in the canonical message.
    let decodedCredentials: string;
    try { decodedCredentials = decodeURIComponent(credentials); } catch { invalid(); }
    if (!decodedCredentials.split(":", 1)[0] || /[\u0000-\u001f\u007f]/.test(decodedCredentials)) invalid();
  }
  const host = rawHost.toLowerCase();
  const hostParts = /^(ep-[a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z0-9]+(?:-[a-z0-9]+)*)\.(aws|azure)\.neon\.tech$/.exec(host);
  if (!hostParts || hostParts[1].length > 63 || hostParts[2].length > 63) invalid();
  const endpoint = hostParts[1].replace(/-pooler$/, "");
  if (endpoint === "ep") invalid();
  const directHost = `${endpoint}.${hostParts[2]}.${hostParts[3]}.neon.tech`;
  const port = rawPort === undefined ? 5432 : Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) invalid();
  let database: string;
  try { database = decodeURIComponent(rawDatabase); } catch { invalid(); }
  if (!database || database.length > 63 || /[^A-Za-z0-9_.-]/.test(database) || /^\.+$/.test(database)) invalid();
  if (query !== undefined) {
    const seen = new Set<string>();
    for (const pair of query.split("&")) {
      const match = /^([a-z_]+)=([a-z-]+)$/.exec(pair);
      if (!match || seen.has(match[1]) || !Object.hasOwn(SAFE_QUERY, match[1])
          || !SAFE_QUERY[match[1]].includes(match[2])) invalid();
      seen.add(match[1]);
    }
  }
  return JSON.stringify(["neon-target-v1", directHost, String(port), database]);
}

/** Nonce-keyed HMAC; never return this digest from the MCP tool. */
export function backendTargetDigest(databaseUrl: string, challenge: string): Buffer {
  if (typeof challenge !== "string" || challenge.length !== 64 || !HEX_32_BYTES.test(challenge)) invalid();
  return createHmac("sha256", Buffer.from(challenge, "hex"))
    .update(canonicalizeBackendTarget(databaseUrl), "utf8").digest();
}

export function matchesBackendTarget(databaseUrl: string, challenge: string, expectedDigest: string): boolean {
  if (typeof expectedDigest !== "string" || expectedDigest.length !== 64 || !HEX_32_BYTES.test(expectedDigest)) invalid();
  return timingSafeEqual(backendTargetDigest(databaseUrl, challenge), Buffer.from(expectedDigest, "hex"));
}
