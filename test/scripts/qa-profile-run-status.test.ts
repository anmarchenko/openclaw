import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const collectorPath = path.join(repoRoot, "scripts/qa/qa-profile-run-status.mjs");
const targetSha = "a".repeat(40);
const protocolSha = "b".repeat(40);
const plan = {
  include: [
    { id: "shard-01", categoryIds: ["fixture.one"], scenarioIds: ["scenario-one"] },
    { id: "shard-02", categoryIds: ["fixture.two"], scenarioIds: ["scenario-two"] },
  ],
};

function fixture(layout: "named" | "direct" = "named") {
  const root = tempDirs.make("openclaw-qa-profile-status-");
  const selected = path.join(root, "selected");
  mkdirSync(selected);
  const input = path.join(selected, ".artifacts/qa-profile-shards");
  const output = path.join(selected, ".artifacts/qa-e2e/profile-all-42-1");
  const env = {
    PATH: process.env.PATH ?? "",
    INPUT_DIR: input,
    OUTPUT_DIR: output,
    PLAN_MATRIX_JSON: JSON.stringify(plan),
    QA_PROFILE: "all",
    TARGET_SHA: targetSha,
    PROTOCOL_BASE_SHA: protocolSha,
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    SHARD_COUNT: "2",
    GITHUB_OUTPUT: path.join(root, "github-output"),
    QA_EXIT_CODE: "",
    SHARD_JOB_OUTCOME: "failure",
    DOWNLOAD_OUTCOME: "success",
    AGGREGATE_OUTCOME: "failure",
    FINALIZE_OUTCOME: "skipped",
  };
  const status = (index = 0) => ({
    target: { sha: targetSha, protocolBaseSha: protocolSha },
    profile: "all",
    shard: plan.include[index],
    run: { id: "42", attempt: 1 },
    exitCode: 0,
    timedOut: false,
    timeoutOutcome: "none",
    completedAt: "2026-09-10T00:00:00.000Z",
  });
  const writeShard = (index = 0, payload: unknown = status(index), artifactSha = targetSha) => {
    const directory =
      layout === "direct"
        ? input
        : path.join(input, `qa-profile-evidence-shard-${plan.include[index]!.id}-${artifactSha}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "qa-evidence.json"), '{"fixture":"unchanged"}\n');
    const statusPath = path.join(directory, "qa-profile-run-status.json");
    writeFileSync(
      statusPath,
      typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`,
    );
    return statusPath;
  };
  const collect = (overrides: Partial<typeof env> = {}) => {
    const run = spawnSync(process.execPath, [collectorPath], {
      cwd: root,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const text = readFileSync(path.join(output, "qa-profile-run-status.json"), "utf8");
    return { text, result: JSON.parse(text) };
  };
  return { root, selected, input, output, env, status, writeShard, collect };
}

describe("QA profile failure diagnostics", () => {
  it.each([
    { label: "one of two planned shards", matrix: plan, missing: ["shard-01"] },
    { label: "one planned shard", matrix: { include: [plan.include[1]] }, missing: [] },
  ])("retains a directly extracted survivor with $label", ({ matrix, missing }) => {
    const f = fixture("direct");
    const statusPath = f.writeShard(1, {
      ...f.status(1),
      exitCode: 137,
      timedOut: true,
      timeoutOutcome: "kill",
    });
    const evidencePath = path.join(f.input, "qa-evidence.json");
    const payloadFiles = [
      ["qa-suite-report.md", "# QA scenario suite\n"],
      ["qa-suite-summary.json", '{"scenarios":[]}\n'],
      ["script/qa-evidence.json", '{"execution":"nested"}\n'],
    ] as const;
    for (const [relativePath, content] of payloadFiles) {
      const filePath = path.join(f.input, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
    const inputPaths = [
      statusPath,
      evidencePath,
      ...payloadFiles.map(([relativePath]) => path.join(f.input, relativePath)),
    ];
    const originalInputs = inputPaths.map((filePath) => readFileSync(filePath));
    const { result } = f.collect({
      PLAN_MATRIX_JSON: JSON.stringify(matrix),
      SHARD_COUNT: String(matrix.include.length),
    });
    expect(result.shards).toEqual([
      {
        id: "shard-02",
        source: "artifact-001",
        exitCode: 137,
        timedOut: true,
        timeoutOutcome: "kill",
        completedAt: "2026-09-10T00:00:00.000Z",
      },
    ]);
    expect(result).toMatchObject({ exitCode: null, timedOut: true, timeoutOutcome: "kill" });
    expect(result.diagnostics).toMatchObject({
      stages: { AGGREGATE_OUTCOME: "failure", FINALIZE_OUTCOME: "skipped" },
      statusFiles: 1,
      evidenceFiles: 1,
      missingStatuses: missing,
      missingEvidence: missing,
      issues: [],
    });
    expect(inputPaths.map((filePath) => readFileSync(filePath))).toEqual(originalInputs);
    expect(readdirSync(f.output)).toEqual(["qa-profile-run-status.json"]);
  });

  it("does not attribute directly extracted evidence to an unplanned shard", () => {
    const f = fixture("direct");
    f.writeShard(0, {
      ...f.status(),
      shard: { ...plan.include[0], id: "shard-99" },
    });
    const { result } = f.collect();
    expect(result.diagnostics).toMatchObject({
      statusFiles: 1,
      evidenceFiles: 1,
      missingStatuses: ["shard-01", "shard-02"],
      missingEvidence: ["shard-01", "shard-02"],
    });
    expect(result.diagnostics.issues).toContainEqual({
      source: "artifact-001",
      reason: "unexpected-shard",
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a directly extracted status symlink",
    () => {
      const f = fixture("direct");
      mkdirSync(f.input, { recursive: true });
      const target = path.join(f.root, "private-status.json");
      const original = JSON.stringify({ ...f.status(), stderr: "private-status-sentinel" });
      writeFileSync(target, original);
      symlinkSync(target, path.join(f.input, "qa-profile-run-status.json"));
      const { text, result } = f.collect();
      expect(result.shards).toEqual([]);
      expect(result.diagnostics).toMatchObject({
        statusFiles: 0,
        missingStatuses: ["shard-01", "shard-02"],
      });
      expect(result.diagnostics.issues).toContainEqual({
        source: "artifact-001",
        reason: "missing-or-malformed-status",
      });
      expect(text).not.toContain("private-status-sentinel");
      expect(text).not.toContain(f.root);
      expect(readFileSync(target, "utf8")).toBe(original);
    },
  );

  it("retains unknown outcomes when no download directory exists", () => {
    const { result } = fixture().collect({
      DOWNLOAD_OUTCOME: "failure",
      AGGREGATE_OUTCOME: "skipped",
    });
    expect(result).toMatchObject({
      exitCode: null,
      timedOut: null,
      timeoutOutcome: null,
      shards: [],
    });
    expect(result.diagnostics).toMatchObject({
      missingStatuses: ["shard-01", "shard-02"],
      missingEvidence: ["shard-01", "shard-02"],
      issues: [{ source: null, reason: "input-unavailable" }],
    });
  });

  it("retains other shard diagnostics when an ID cannot be coerced to a string", () => {
    const f = fixture();
    f.writeShard(0, { ...f.status(), shard: { ...plan.include[0], id: { toString: null } } });
    f.writeShard(1);
    const { result } = f.collect();
    expect(result.shards.map((shard: { id: string | null }) => shard.id)).toEqual([
      null,
      "shard-02",
    ]);
    expect(result.diagnostics.missingStatuses).toEqual(["shard-01"]);
    expect(result.diagnostics.issues).toContainEqual({
      source: "artifact-001",
      reason: "unexpected-shard",
    });
  });

  it.each([
    [0, false, "none"],
    [1, false, "none"],
    [124, false, "none"],
    [137, false, "none"],
    [124, true, "term"],
    [137, true, "kill"],
  ])(
    "preserves exit %i and supervised timeout %s/%s independently",
    (code, timedOut, timeoutOutcome) => {
      const f = fixture();
      f.writeShard(0, { ...f.status(), exitCode: code, timedOut, timeoutOutcome });
      f.writeShard(1);
      const { result } = f.collect({
        QA_EXIT_CODE: String(code),
        AGGREGATE_OUTCOME: "success",
        FINALIZE_OUTCOME: "success",
      });
      expect(result).toMatchObject({ exitCode: code, timedOut, timeoutOutcome });
      expect(result.shards[0]).toMatchObject({ exitCode: code, timedOut, timeoutOutcome });
      expect(result.diagnostics.issues).toEqual([]);
    },
  );

  it.each(
    (["named", "direct"] as const).flatMap((layout) =>
      ['{"untrusted-status-sentinel":', "null", "[]", "x".repeat(65 * 1024)].map((payload) => ({
        layout,
        payload,
      })),
    ),
  )("bounds malformed $layout status input %#", ({ layout, payload }) => {
    const f = fixture(layout);
    const source = f.writeShard(0, payload);
    const original = readFileSync(source);
    const { text, result } = f.collect();
    expect(result.shards).toEqual([]);
    expect(result.diagnostics.issues[0].reason).toBe(
      payload.length > 64 * 1024 ? "status-size-limit" : "missing-or-malformed-status",
    );
    expect(readFileSync(source)).toEqual(original);
    expect(result.diagnostics.missingStatuses).toEqual(["shard-01", "shard-02"]);
    expect(text).not.toContain("untrusted-status-sentinel");
    expect(text).not.toContain(f.root);
    expect(Buffer.byteLength(text)).toBeLessThan(2048);
  });

  it("reports duplicate, unexpected, identity and membership diagnostics without leaking payloads", () => {
    const f = fixture();
    const privateText = "private-payload-sentinel:/operator/home?token=secret";
    f.writeShard();
    f.writeShard(0, f.status(), "c".repeat(40));
    f.writeShard(1, {
      ...f.status(1),
      profile: privateText,
      target: { sha: "d".repeat(40), protocolBaseSha: "e".repeat(40), ref: privateText },
      run: { id: "43", attempt: 2 },
      shard: { id: "shard-99", categoryIds: [privateText], scenarioIds: [{ toString: null }] },
      stderr: privateText,
      exitCode: privateText,
      timedOut: privateText,
      timeoutOutcome: privateText,
      completedAt: privateText,
    });
    const { text, result } = f.collect();
    expect(text).not.toContain(privateText);
    expect(text).not.toContain(f.root);
    expect(result.target).toEqual({ sha: targetSha, protocolBaseSha: protocolSha });
    expect(result.diagnostics.duplicateStatuses).toEqual(["shard-01"]);
    expect(result.diagnostics.missingStatuses).toEqual(["shard-02"]);
    expect(result.diagnostics.issues.map((issue: { reason: string }) => issue.reason)).toEqual(
      expect.arrayContaining([
        "artifact-sha-mismatch",
        "unexpected-shard",
        "artifact-shard-mismatch",
        "profile-mismatch",
        "target-sha-mismatch",
        "protocol-sha-mismatch",
        "run-id-mismatch",
        "run-attempt-mismatch",
        "category-membership-mismatch",
        "scenario-membership-mismatch",
        "invalid-outcome",
        "invalid-completion-time",
      ]),
    );
  });

  it("records missing evidence and finalizer failure without rewriting the aggregate exit", () => {
    const f = fixture();
    const directory = path.join(f.input, `qa-profile-evidence-shard-shard-01-${targetSha}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "qa-profile-run-status.json"), JSON.stringify(f.status()));
    const { result } = f.collect({
      QA_EXIT_CODE: "0",
      AGGREGATE_OUTCOME: "success",
      FINALIZE_OUTCOME: "failure",
    });
    expect(result.exitCode).toBe(0);
    expect(result.diagnostics.stages.FINALIZE_OUTCOME).toBe("failure");
    expect(result.diagnostics.missingEvidence).toEqual(["shard-01", "shard-02"]);
    expect(result).not.toHaveProperty("qaPassed");
  });

  it("bounds the artifact inventory and produces deterministic output", () => {
    const f = fixture();
    for (let index = 0; index < 129; index += 1) {
      mkdirSync(path.join(f.input, String(index)), { recursive: true });
    }
    const first = f.collect();
    const second = f.collect();
    expect(first.text).toBe(second.text);
    expect(first.result.shards).toEqual([]);
    expect(first.result.diagnostics.issues).toEqual([{ source: null, reason: "artifact-limit" }]);
    expect(Buffer.byteLength(first.text)).toBeLessThan(2048);
  });
});
