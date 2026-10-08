import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCiCheckPlan } from "../../scripts/ci-check-plan.mts";
import {
  createExtensionOxlintShards,
  selectExtensionOxlintStripe,
} from "../../scripts/run-oxlint-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const typeSelection = vi.hoisted(() => ({
  graphs: null as { name: string; config: string }[] | null,
}));

vi.mock("../../scripts/run-tsgo-core-test-shards.mts", () => ({
  createChangedCiTypeCheckPlan: async () => ({
    mode: "targeted",
    graphs: typeSelection.graphs ?? [
      {
        name: "core-test-agents-root",
        config: "test/tsconfig/tsconfig.core.test.agents-root.json",
      },
      { name: "scripts", config: "tsconfig.scripts.json" },
    ],
  }),
}));

describe("CI check-plan completion count", () => {
  it.each([
    ["hybrid", [1, 2, 4, 5]],
    ["github", [1, 2, 3, 4, 5]],
    ["hybrid", [1, 2, 5]],
    ["blacksmith", [1, 2, 3, 4, 5]],
  ] as const)(
    "assigns root partitions without adding %s rows (%j)",
    async (runnerProfile, stripes) => {
      const core = [
        "agents-root",
        "agents-other",
        "agents-tools",
        "gateway-root",
        "gateway-server",
      ];
      typeSelection.graphs = [
        ...stripes.map((stripe) => ({
          name: `core-test-${core[stripe - 1]}`,
          config: `test/tsconfig/tsconfig.core.test.${core[stripe - 1]}.json`,
        })),
        { name: "scripts", config: "tsconfig.scripts.json" },
        { name: "test-root", config: "test/tsconfig/tsconfig.test.root.json" },
      ];
      try {
        const plan = await createCiCheckPlan({
          typeGraphBoundaryOwner: "check-plan",
          changedPaths: ["src/shared.ts"],
          changedCoreTestPaths: null,
          runnerProfile,
          checkMatrix: {
            include: [{ check_name: "check-test-types", task: "test-types", runner: "unused" }],
          },
          coreTypeMatrix: { include: [1, 2, 3, 4, 5].map((stripe) => ({ stripe })) },
          lintCoreMatrix: { include: [] },
          lintExtensionMatrix: { include: [] },
        });
        const hosted = runnerProfile !== "blacksmith";
        const moved = hosted && stripes.length >= 4;
        expect(plan.core_type_matrix.include.map((row) => row.stripe)).toEqual(
          hosted ? stripes : [],
        );
        expect(plan.core_type_matrix.include.flatMap((row) => row.root_type_stripe ?? [])).toEqual(
          moved ? ["1/4", "2/4", "3/4", "4/4"] : [],
        );
        expect(JSON.parse(plan.check_matrix.include[0]!.type_graph_names_json!)).toEqual(
          moved ? ["scripts"] : hosted ? ["scripts", "test-root"] : ["test-root", "scripts"],
        );
        expect(plan.check_job_count).toBe(1 + (hosted ? stripes.length : 0));
      } finally {
        typeSelection.graphs = null;
      }
    },
  );

  it.each(["blacksmith", "github", "hybrid"] as const)(
    "counts the actual compiler placement for %s",
    async (runnerProfile) => {
      const plan = await createCiCheckPlan({
        typeGraphBoundaryOwner: "check-plan",
        changedPaths: ["src/shared.ts"],
        changedCoreTestPaths: null,
        runnerProfile,
        checkMatrix: {
          include: [{ check_name: "check-test-types", task: "test-types", runner: "unused" }],
        },
        coreTypeMatrix: { include: [1, 2, 3, 4, 5].map((stripe) => ({ stripe })) },
        lintCoreMatrix: { include: [] },
        lintExtensionMatrix: { include: [] },
      });
      expect(plan.check_job_count).toBe(runnerProfile === "blacksmith" ? 1 : 2);
    },
  );

  it.each(["hybrid", "github", "blacksmith"])(
    "preserves complete fallback chunks while reducing only hybrid rows (%s)",
    async (runnerProfile) => {
      const cwd = tempDirs.make("ci-full-extension-lint-");
      for (let index = 0; index < 49; index++) {
        mkdirSync(join(cwd, "extensions", `plugin-${String(index).padStart(2, "0")}`), {
          recursive: true,
        });
      }
      writeFileSync(join(cwd, "extensions/root.ts"), "export {};\n");
      const shards = createExtensionOxlintShards({ cwd, platform: "linux", chunkSize: 8 });
      const plan = await createCiCheckPlan({
        typeGraphBoundaryOwner: "",
        changedPaths: ["package.json"],
        changedCoreTestPaths: null,
        runnerProfile,
        checkMatrix: { include: [{ check_name: "check-lint", task: "lint", runner: "unused" }] },
        coreTypeMatrix: { include: [] },
        lintCoreMatrix: { include: [] },
        lintExtensionMatrix: { include: [1, 2, 3, 4, 5, 6].map((stripe) => ({ stripe })) },
      });
      const rows = plan.lint_extension_matrix.include;
      expect(rows).toHaveLength(runnerProfile === "hybrid" ? 3 : 6);
      const selected = rows.flatMap((row) =>
        selectExtensionOxlintStripe(shards, {
          index: row.stripe,
          total: row.stripe_count ?? 6,
        }),
      );
      expect(selected.map(({ name, args }) => JSON.stringify({ name, args })).toSorted()).toEqual(
        shards.map(({ name, args }) => JSON.stringify({ name, args })).toSorted(),
      );
      expect(plan.check_job_count).toBe(runnerProfile === "hybrid" ? 4 : 1);
      expect(plan.central_lint_selection_json).toBe("");
    },
  );

  it("refuses a count outside the observer's existing job inventory bound", async () => {
    await expect(
      createCiCheckPlan({
        typeGraphBoundaryOwner: "",
        changedPaths: ["docs/ci.md"],
        changedCoreTestPaths: null,
        runnerProfile: "blacksmith",
        checkMatrix: {
          include: Array.from({ length: 401 }, (_, index) => ({
            check_name: `check-guards-${index}`,
            task: "guards",
            runner: "blacksmith-4vcpu-ubuntu-2404",
          })),
        },
        coreTypeMatrix: { include: [] },
        lintCoreMatrix: { include: [] },
        lintExtensionMatrix: { include: [] },
      }),
    ).rejects.toThrow("400-job");
  });
});
