import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type StringOptions<T extends string> = readonly T[] | ReadonlySet<T>;

const GENERIC_CHANNEL_PREFIXES = ["channel:", "chat:", "user:"] as const;

export function isStringOption<T extends string>(
  value: unknown,
  options: StringOptions<T>,
): value is T {
  return (
    typeof value === "string" &&
    (Array.isArray(options)
      ? (options as readonly string[]).includes(value)
      : (options as ReadonlySet<string>).has(value))
  );
}

export function readTrimmedStringAlias(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = normalizeOptionalString(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function stripChannelPrefix(
  value: string | undefined,
  channelId: string,
): string | undefined {
  if (!value) {
    return undefined;
  }
  for (const prefix of GENERIC_CHANNEL_PREFIXES) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  const prefix = `${channelId}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
