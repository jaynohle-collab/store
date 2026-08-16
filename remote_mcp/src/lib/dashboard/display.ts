export function formatMatch(value: unknown): string {
  if (value == null || value === "") return "—";
  const score = Number(value);
  if (!Number.isFinite(score)) return "—";
  return `${Math.round(score)}`;
}
