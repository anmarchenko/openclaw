/**
 * Shared string sampling for operator logs and SDK helpers that need bounded readable lists.
 * This intentionally formats for humans, not for machine parsing.
 */
const DEFAULT_SAMPLE_LIMIT = 6;

/** Formats a bounded comma-separated sample of string entries with a hidden-count suffix. */
export function summarizeStringEntries(params: {
  /** Entries to summarize; nullish values are treated as an empty list. */
  entries?: ReadonlyArray<string> | null;
  /** Maximum visible entries; non-finite values use the default and values below one clamp to one. */
  limit?: number;
  /** Text returned when no entries are available. */
  emptyText?: string;
}): string {
  const entries = params.entries ?? [];
  if (entries.length === 0) {
    return params.emptyText ?? "";
  }
  const rawLimit = params.limit ?? DEFAULT_SAMPLE_LIMIT;
  // Keep summaries useful for operator output even when callers pass bad limits.
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.floor(rawLimit))
    : DEFAULT_SAMPLE_LIMIT;
  const sample = entries.slice(0, limit);
  const suffix = entries.length > sample.length ? ` (+${entries.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}
