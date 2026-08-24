/**
 * Dashboard score display — Python Rank vs GPT Fit are separate systems.
 */

export const PYTHON_RANK_LABEL = "Rank";
export const PYTHON_RANK_TOOLTIP =
  "Python profile-v1 dashboard match score (ranking only; does not gate discovery admission).";

export const GPT_FIT_LABEL = "GPT Fit";
export const GPT_FIT_TOOLTIP =
  "Latest GPT admission relevance score (gpt-fit-v1/v2 evidence; separate from Python Rank).";

export function formatPythonRank(value: unknown): string {
  if (value == null || value === "") return "—";
  const score = Number(value);
  if (!Number.isFinite(score)) return "—";
  return `${Math.round(score)}`;
}

export function formatGptFit(value: unknown): string {
  if (value == null || value === "") return "—";
  const score = Number(value);
  if (!Number.isFinite(score)) return "—";
  return `${Math.round(score)}`;
}

export function gptFitTitle(evaluationVersion: unknown): string {
  const version =
    evaluationVersion == null || evaluationVersion === ""
      ? "unknown version"
      : String(evaluationVersion);
  return `${GPT_FIT_TOOLTIP} Version: ${version}.`;
}

export type GptEvidenceRow = {
  gpt_relevance_score?: number | null;
  evaluation_version?: string | null;
  created_at?: string | null;
  id?: string | null;
};

/**
 * Pick the latest applicable GPT evaluation from candidates for the same posting URL.
 * Prefers the pinned required version, then highest created_at + id.
 */
export function selectLatestGptEvidence(
  rows: GptEvidenceRow[],
  requiredVersion: string | null,
): GptEvidenceRow | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => {
    const aVersion = String(a.evaluation_version ?? "");
    const bVersion = String(b.evaluation_version ?? "");
    if (requiredVersion) {
      const aPin = aVersion === requiredVersion ? 0 : 1;
      const bPin = bVersion === requiredVersion ? 0 : 1;
      if (aPin !== bPin) return aPin - bPin;
    }
    const aCreated = Date.parse(String(a.created_at ?? "")) || 0;
    const bCreated = Date.parse(String(b.created_at ?? "")) || 0;
    if (aCreated !== bCreated) return bCreated - aCreated;
    const aId = String(a.id ?? "");
    const bId = String(b.id ?? "");
    return bId.localeCompare(aId);
  });
  return sorted[0] ?? null;
}
