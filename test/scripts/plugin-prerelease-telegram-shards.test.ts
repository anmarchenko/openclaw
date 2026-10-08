import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  createExtensionTestShards,
} from "../../scripts/lib/extension-test-plan.mts";

describe("plugin prerelease Telegram extension shards", () => {
  it("keeps Telegram out of balanced batches and covers every extension exactly once", () => {
    const allShards = createExtensionTestShards({
      cwd: process.cwd(),
      shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
    });
    const allExtensionIds = allShards.flatMap((shard) => shard.extensionIds);
    const genericExtensionIds = allExtensionIds.filter((extensionId) => extensionId !== "telegram");
    const genericShards = createExtensionTestShards({
      cwd: process.cwd(),
      extensionIds: genericExtensionIds,
      shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
    });

    expect(genericShards).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
    expect(genericShards.flatMap((shard) => shard.extensionIds)).not.toContain("telegram");
    expect(
      genericShards
        .flatMap((shard) => shard.extensionIds)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(genericExtensionIds.toSorted((left, right) => left.localeCompare(right)));
    expect(allExtensionIds.filter((extensionId) => extensionId === "telegram")).toEqual([
      "telegram",
    ]);
    expect(
      allShards
        .flatMap((shard) => shard.planGroups)
        .find((group) => group.config === "test/vitest/vitest.extension-telegram.config.ts"),
    ).toMatchObject({
      config: "test/vitest/vitest.extension-telegram.config.ts",
      extensionIds: ["telegram"],
      roots: ["extensions/telegram"],
    });
    expect(new Set(genericShards.flatMap((shard) => shard.extensionIds)).size).toBe(
      genericExtensionIds.length,
    );
  });
});
