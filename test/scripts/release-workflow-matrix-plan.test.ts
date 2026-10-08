// Release Workflow Matrix Plan tests cover release workflow matrix plan script behavior.
import { spawnSync } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createReleaseSourceSelection,
  createReleaseWorkflowMatrixPlan,
} from "../../scripts/plan-release-workflow-matrix.mjs";

type MatrixEntry = {
  advisory?: boolean;
  chunk_id?: string;
  id?: string;
  label?: string;
  profiles?: string;
  providers?: string;
  suite_group?: string;
  suite_id?: string;
};

const PACKAGE_UPDATE_CHUNKS = [
  "package-update-openai",
  "package-update-onboarding",
  "package-update-migrations",
  "package-update-self-upgrade",
];

const FULL_DOCKER_CHUNKS = [
  "core",
  ...PACKAGE_UPDATE_CHUNKS,
  "plugins-runtime-plugins",
  "plugins-runtime-services",
  "plugins-runtime-install-a",
  "plugins-runtime-install-b",
  "plugins-runtime-install-c",
  "plugins-runtime-install-d",
  "plugins-runtime-install-e",
  "plugins-runtime-install-f",
  "plugins-runtime-install-g",
  "plugins-runtime-install-h",
];

// The six-way first-hop self-upgrade aggregate stays full-only until it runs in waves.
const STABLE_DOCKER_CHUNKS = FULL_DOCKER_CHUNKS.filter(
  (chunk) => chunk !== "package-update-self-upgrade",
);

const PROFILE_EXPECTATIONS = [
  {
    profile: "minimum",
    dockerE2eChunks: PACKAGE_UPDATE_CHUNKS,
    liveModelProviders: ["openai"],
  },
  {
    profile: "beta",
    dockerE2eChunks: PACKAGE_UPDATE_CHUNKS,
    liveModelProviders: ["openai"],
  },
  {
    profile: "stable",
    dockerE2eChunks: STABLE_DOCKER_CHUNKS,
    liveModelProviders: ["anthropic", "google", "minimax", "openai"],
  },
  {
    profile: "full",
    dockerE2eChunks: FULL_DOCKER_CHUNKS,
    liveModelProviders: [
      "anthropic",
      "google",
      "minimax",
      "moonshot",
      "openai",
      "opencode-go",
      "openrouter",
      "xai",
      "zai",
      "fireworks",
    ],
  },
];

describe("scripts/plan-release-workflow-matrix.mjs", () => {
  it.each([
    { input: undefined, profile: "stable" },
    { input: "", profile: "stable" },
    ...PROFILE_EXPECTATIONS.map(({ profile }) => ({ input: profile, profile })),
  ])("normalizes CLI profile $input to $profile matrices", ({ input, profile }) => {
    const result = spawnSync(process.execPath, ["scripts/plan-release-workflow-matrix.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_TEST_PROFILE: input,
        INCLUDE_RELEASE_PATH_SUITES: "true",
        INCLUDE_LIVE_SUITES: "true",
        DOCKER_LANES: "",
        LIVE_MODEL_PROVIDERS: "",
        LIVE_SUITE_FILTER: "",
        LIVE_MODELS_ONLY: "false",
        PREPARE_ONLY: "false",
        GITHUB_STEP_SUMMARY: "",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const outputs = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    const expected = expectDefined(
      PROFILE_EXPECTATIONS.find((row) => row.profile === profile),
      `matrix expectations for ${profile}`,
    );
    expect(
      JSON.parse(expectDefined(outputs.docker_e2e_matrix, "Docker E2E matrix output")).include.map(
        (row: MatrixEntry) => row.chunk_id,
      ),
    ).toEqual(expected.dockerE2eChunks);
    expect(outputs.docker_e2e_count).toBe(String(expected.dockerE2eChunks.length));
    expect(
      JSON.parse(
        expectDefined(outputs.live_models_matrix, "live models matrix output"),
      ).include.map((row: MatrixEntry) => row.providers),
    ).toEqual(expected.liveModelProviders);
    expect(outputs.live_models_count).toBe(String(expected.liveModelProviders.length));
  });

  it.each(["unknown", " stable "])("rejects nonempty invalid CLI profile %j", (profile) => {
    const result = spawnSync(process.execPath, ["scripts/plan-release-workflow-matrix.mjs"], {
      encoding: "utf8",
      env: { ...process.env, RELEASE_TEST_PROFILE: profile, GITHUB_STEP_SUMMARY: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown release profile");
  });

  it("keeps the API strict for an empty CLI profile value", () => {
    expect(() => createReleaseWorkflowMatrixPlan({ releaseProfile: "" })).toThrow(
      "unknown release profile",
    );
  });

  it.each([
    ["beta", "", 0],
    ["stable", "onboard", 1],
  ])(
    "does not admit an unscheduled OpenWebUI job for %s / %s",
    (releaseProfile, dockerLanes, count) => {
      const selected = createReleaseSourceSelection({
        releaseProfile,
        dockerLanes,
        includeOpenWebUI: true,
      });
      expect(selected.docker).toHaveLength(count);
      expect(
        selected.docker.flatMap((group: { lanes?: string[] }) => group.lanes ?? []),
      ).not.toContain("openwebui");
    },
  );

  it.each([
    [
      "full",
      "live-gateway-advisory-docker",
      [
        "live-gateway-advisory-docker-deepseek-fireworks",
        "live-gateway-advisory-docker-opencode-openrouter",
        "live-gateway-advisory-docker-xai-zai",
      ],
    ],
    [
      "stable",
      "live-codex-harness-gpt56-docker",
      [
        "live-codex-harness-gpt56-sol-docker",
        "live-codex-harness-gpt56-terra-docker",
        "live-codex-harness-gpt56-luna-docker",
      ],
    ],
    ["full", "live-codex-harness-gpt56-sol-docker", ["live-codex-harness-gpt56-sol-docker"]],
    ["stable", "live-codex-harness-gpt56-sol-docker", ["live-codex-harness-gpt56-sol-docker"]],
    ["beta", "live-codex-harness-gpt56-sol-docker", []],
    ["beta", "live-cache", []],
  ])(
    "binds focused Docker consumer rows for %s / %s",
    (releaseProfile, liveSuiteFilter, expected) => {
      const plan = createReleaseWorkflowMatrixPlan({
        releaseProfile,
        liveSuiteFilter,
        includeLiveSuites: true,
      });
      expect(plan.liveDocker?.matrix.include.map((entry: MatrixEntry) => entry.suite_id)).toEqual(
        expected,
      );
      const disabled = createReleaseWorkflowMatrixPlan({
        releaseProfile,
        liveSuiteFilter,
        includeLiveSuites: true,
        liveModelsOnly: true,
      });
      expect(disabled.liveDocker?.count).toBe(0);
    },
  );

  it.each(PROFILE_EXPECTATIONS)(
    "keeps $profile release jobs to profile-enabled Docker E2E chunks and live model providers",
    ({ profile, dockerE2eChunks, liveModelProviders }) => {
      const plan = createReleaseWorkflowMatrixPlan({
        includeLiveSuites: true,
        includeReleasePathSuites: true,
        releaseProfile: profile,
      });

      expect(plan.dockerE2e.matrix.include.map((entry: MatrixEntry) => entry.chunk_id)).toEqual(
        dockerE2eChunks,
      );
      const selfUpgrade = plan.dockerE2e.matrix.include.find(
        (entry: MatrixEntry) => entry.chunk_id === "package-update-self-upgrade",
      );
      if (dockerE2eChunks.includes("package-update-self-upgrade")) {
        expect(selfUpgrade).toMatchObject({ timeout_minutes: 130 });
      } else {
        expect(selfUpgrade).toBeUndefined();
      }
      expect(
        plan.dockerE2e.matrix.include.find(
          (entry: MatrixEntry) => entry.chunk_id === "package-update-openai",
        ),
      ).toMatchObject({ timeout_minutes: 160 });
      expect(plan.liveModels.matrix.include.map((entry: MatrixEntry) => entry.providers)).toEqual(
        liveModelProviders,
      );
      const admission = createReleaseSourceSelection({
        includeLiveSuites: true,
        includeReleasePathSuites: true,
        releaseProfile: profile,
      });
      expect(admission.docker.map((entry: { chunk?: string }) => entry.chunk)).toEqual(
        dockerE2eChunks,
      );
      expect(admission.codexSuites).toEqual(
        plan.liveDocker.matrix.include
          .filter((entry: MatrixEntry) => entry.suite_id?.startsWith("live-codex-harness"))
          .map((entry: MatrixEntry) => entry.suite_id),
      );
    },
  );

  it("reports omitted lanes for release jobs excluded by the selected profile", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      releaseProfile: "beta",
    });

    expect(plan.dockerE2e.omitted.map((entry: MatrixEntry) => entry.id)).toContain("core");
    expect(plan.liveModels.omitted.map((entry: MatrixEntry) => entry.id)).toContain("anthropic");
  });

  it("limits MiniMax Docker live-model coverage to the stable M3 pair", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      releaseProfile: "stable",
    });

    expect(plan.liveModels.matrix.include).toContainEqual({
      provider_label: "MiniMax",
      providers: "minimax",
      models: "minimax/MiniMax-M3,minimax-portal/MiniMax-M3",
      max_models: "2",
      profiles: "stable full",
    });
  });

  it("disables live model planning when focused recovery targets another live suite", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      liveSuiteFilter: "live-cache",
      releaseProfile: "full",
    });

    expect(plan.liveModels.count).toBe(0);
    expect(plan.liveModels.omitted).toHaveLength(10);
    expect(plan.liveModels.omitted[0]?.reason).toBe(
      "Docker live model matrix disabled by input selection",
    );
  });
});
