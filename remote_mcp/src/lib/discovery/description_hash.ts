/**
 * Canonical discovery description hashing (Python fingerprint parity).
 * Hash = sha256(normalize_fingerprint_text(description))[:16] lowercase hex.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import { normalizeFingerprintText } from "./normalize";

/** Version string returned by compute_discovery_description_hashes. */
export const DESCRIPTION_NORMALIZATION_VERSION = "fingerprint-v1";

export const DESCRIPTION_HASH_HEX_PATTERN = /^[a-f0-9]{16}$/;

export const MAX_DESCRIPTION_HASH_ITEMS = 20;
/** Per-description UTF-16 code unit bound (Zod string length, additional defense). */
export const MAX_DESCRIPTION_CHARS = 100_000;
/** Per-description UTF-8 byte bound (authoritative request-size limit). */
export const MAX_DESCRIPTION_BYTES = 100_000;
/** Total JavaScript characters across all descriptions in one request. */
export const MAX_DESCRIPTION_CHARS_TOTAL = 400_000;
/** Total UTF-8 bytes across all descriptions in one request. */
export const MAX_DESCRIPTION_BYTES_TOTAL = 400_000;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function normalizeDescriptionForHash(description: string | null | undefined): string {
  return normalizeFingerprintText(description);
}

/** Exact Python `compute_description_hash` / fingerprint parity. */
export function computeDescriptionHash(description: string | null | undefined): string | null {
  const normalized = normalizeDescriptionForHash(description);
  if (!normalized) return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

export function isCanonicalDescriptionHash(value: string | null | undefined): boolean {
  return Boolean(value && DESCRIPTION_HASH_HEX_PATTERN.test(value));
}

const requiredClientId = z
  .string()
  .max(128)
  .refine((value) => value.trim().length > 0, "must be a non-empty string");

export const computeDiscoveryDescriptionHashesSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            client_candidate_id: requiredClientId,
            description: z.string().min(1).max(MAX_DESCRIPTION_CHARS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_DESCRIPTION_HASH_ITEMS),
  })
  .strict()
  .superRefine((payload, ctx) => {
    let totalChars = 0;
    let totalBytes = 0;
    payload.items.forEach((item, index) => {
      const bytes = utf8ByteLength(item.description);
      totalChars += item.description.length;
      totalBytes += bytes;
      if (bytes > MAX_DESCRIPTION_BYTES) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "description"],
          message: `Description UTF-8 size ${bytes} exceeds max ${MAX_DESCRIPTION_BYTES} bytes`,
        });
      }
    });
    if (totalChars > MAX_DESCRIPTION_CHARS_TOTAL) {
      ctx.addIssue({
        code: "custom",
        message: `Total description size ${totalChars} exceeds max ${MAX_DESCRIPTION_CHARS_TOTAL}`,
      });
    }
    if (totalBytes > MAX_DESCRIPTION_BYTES_TOTAL) {
      ctx.addIssue({
        code: "custom",
        message: `Total description UTF-8 size ${totalBytes} exceeds max ${MAX_DESCRIPTION_BYTES_TOTAL} bytes`,
      });
    }
  });

export type ComputeDiscoveryDescriptionHashesInput = z.infer<
  typeof computeDiscoveryDescriptionHashesSchema
>;

export type DiscoveryDescriptionHashResult = {
  client_candidate_id: string;
  description_hash: string | null;
  normalization_version: string;
};

export function computeDiscoveryDescriptionHashes(
  input: ComputeDiscoveryDescriptionHashesInput,
): { results: DiscoveryDescriptionHashResult[] } {
  const parsed = computeDiscoveryDescriptionHashesSchema.parse(input);
  return {
    results: parsed.items.map((item) => ({
      client_candidate_id: item.client_candidate_id,
      description_hash: computeDescriptionHash(item.description),
      normalization_version: DESCRIPTION_NORMALIZATION_VERSION,
    })),
  };
}
