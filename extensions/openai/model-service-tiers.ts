import type { ProviderCatalogOutcome } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url.js";

/** Only authenticated remote rows may supply this private observation, never fallback seeds. */
export function readOpenAICodexServiceTiers(
  rows: readonly unknown[],
): NonNullable<ProviderCatalogOutcome["modelServiceTiers"]> {
  return rows.flatMap((row) => {
    const record = asOptionalRecord(row);
    const modelId = normalizeOptionalString(record?.slug) ?? normalizeOptionalString(record?.id);
    const tiers = record?.service_tiers;
    if (!modelId || !Array.isArray(tiers)) {
      return [];
    }
    const serviceTiers: string[] = [];
    for (const tier of tiers) {
      const id = normalizeOptionalString(asOptionalRecord(tier)?.id);
      if (!id) {
        return [];
      }
      serviceTiers.push(id);
    }
    return [
      {
        modelId,
        runtimeId: "codex",
        api: "openai-chatgpt-responses",
        baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
        serviceTiers: [...new Set(serviceTiers)],
      },
    ];
  });
}
