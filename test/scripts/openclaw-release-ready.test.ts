import { describe, expect, it } from "vitest";
import {
  readyArtifactName,
  validateReadyRelease,
  validateReleaseButtonInputs,
} from "../../scripts/openclaw-release-ready.mjs";

const REPOSITORY = "openclaw/openclaw";
const SOURCE_SHA = "a".repeat(40);
const TOOLING_SHA = "b".repeat(40);
const TOOLING = {
  ref: `release-publish/${TOOLING_SHA.slice(0, 12)}-123`,
  fullRef: `refs/tags/release-publish/${TOOLING_SHA.slice(0, 12)}-123`,
  sha: TOOLING_SHA,
};

function inputs(overrides: Record<string, unknown> = {}) {
  return {
    tag: "v2026.9.2-beta.1",
    npm_dist_tag: "beta",
    preflight_run_id: "100",
    full_release_validation_run_id: "200",
    full_release_validation_run_attempt: "1",
    ...overrides,
  };
}

function descriptor(target: "npm" | "clawhub") {
  return {
    repository: REPOSITORY,
    runId: target === "npm" ? 300 : 400,
    runAttempt: 1,
    workflowPath: `.github/workflows/plugin-${target}-release.yml`,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: TOOLING.ref,
    workflowSha: TOOLING_SHA,
    artifactId: target === "npm" ? 500 : 600,
    artifactName: `prepared-${target}`,
    artifactDigest: `sha256:${"c".repeat(64)}`,
    artifactSizeBytes: 100,
  };
}

function readyRelease() {
  return {
    schema: "openclaw.release-ready/v1",
    repository: REPOSITORY,
    sourceSha: SOURCE_SHA,
    tooling: { ...TOOLING },
    inputs: validateReleaseButtonInputs(inputs()),
    plugins: { npm: descriptor("npm"), clawhub: descriptor("clawhub") },
  };
}

describe("release readiness contract", () => {
  it.each([
    ["v2026.9.2-beta.1", "beta"],
    ["v2026.9.2", "beta"],
    ["v2026.9.2", "latest"],
  ])("seals full-release inputs for %s on %s", (tag, channel) => {
    const value = validateReleaseButtonInputs(
      inputs({
        tag,
        npm_dist_tag: channel,
        publish_openclaw_npm: true,
        publish_docker_only: false,
      }),
    );
    expect(value).toEqual({
      ...inputs({ tag, npm_dist_tag: channel }),
      plugin_publish_scope: "all-publishable",
      publish_openclaw_npm: "true",
      publish_docker_only: "false",
      release_evidence_mode: "full-release-validation",
      wait_for_clawhub: "true",
    });
  });

  it.each([
    ["unsealed input", { prepared_plugins: "{}" }],
    ["retired soak waiver", { stable_soak_waiver: "2026.9.2 approved" }],
    ["retired lane waiver", { lane_waiver: "2026.9.2 approved" }],
    ["moving source", { tag: "main" }],
    ["missing source", { tag: "" }],
    ["wrong beta channel", { npm_dist_tag: "latest" }],
    ["alpha owner", { tag: "v2026.9.2-alpha.1", npm_dist_tag: "alpha" }],
    ["extended-stable owner", { tag: "v2026.9.33", npm_dist_tag: "latest" }],
    ["extended-stable selector", { npm_dist_tag: "extended-stable" }],
    ["invalid preflight", { preflight_run_id: "0" }],
    ["missing validation", { full_release_validation_run_id: "" }],
    ["moving validation attempt", { full_release_validation_run_attempt: "latest" }],
    ["selected repair", { plugin_publish_scope: "selected" }],
    ["partial roster", { plugins: "example" }],
    ["core omission", { publish_openclaw_npm: false }],
    ["Docker-only repair", { publish_docker_only: true }],
    ["focused evidence", { release_evidence_mode: "authorized-beta-focused" }],
    ["output injection", { windows_node_tag: "v2026.9.2\nother=true" }],
  ])("rejects %s before preparation", (_label, overrides) => {
    expect(() => validateReleaseButtonInputs(inputs(overrides))).toThrow();
  });

  it("binds the complete registry pair to the source and protected tooling", () => {
    const value = readyRelease();
    expect(validateReadyRelease(value, { sourceSha: SOURCE_SHA, tooling: TOOLING })).toEqual(value);
    expect(readyArtifactName(SOURCE_SHA, 700, 2)).toBe("release-ready-aaaaaaaaaaaa-700-2");
  });

  it.each([
    ["repository", (value) => void (value.repository = "openclaw/fork")],
    ["source SHA", (value) => void (value.sourceSha = "d".repeat(40))],
    ["tooling SHA", (value) => void (value.tooling.sha = "d".repeat(40))],
    ["tooling ref", (value) => void (value.tooling.fullRef = "refs/heads/main")],
    ["npm-only handoff", (value) => Reflect.deleteProperty(value.plugins, "clawhub")],
    ["extra registry", (value) => Object.assign(value.plugins, { other: descriptor("npm") })],
    [
      "missing normalized inputs",
      (value) => Reflect.deleteProperty(value.inputs, "wait_for_clawhub"),
    ],
    ["channel drift", (value) => void (value.inputs.npm_dist_tag = "latest")],
    ["npm producer", (value) => void (value.plugins.npm.workflowSha = "d".repeat(40))],
    ["ClawHub producer", (value) => void (value.plugins.clawhub.workflowHeadBranch = "main")],
    ["swapped registry", (value) => void (value.plugins.npm = descriptor("clawhub"))],
  ] satisfies Array<[string, (value: ReturnType<typeof readyRelease>) => unknown]>)(
    "rejects %s drift in a readiness receipt",
    (_label, mutate) => {
      const value = readyRelease();
      mutate(value);
      expect(() =>
        validateReadyRelease(value, { sourceSha: SOURCE_SHA, tooling: TOOLING }),
      ).toThrow();
    },
  );
});
