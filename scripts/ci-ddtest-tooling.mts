// Hosted-only paired comparison: canonical static tooling shards versus ddtest file lists.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { decodeNodeTestGroups, encodeNodeTestGroups } from "./lib/ci-node-test-groups-codec.mts";

type Group = {
  configs: string[];
  env?: Record<string, string>;
  includePatterns: string[];
  shard_name?: string;
  fallbackMaxWorkers?: number;
  minTotalMemoryBytes?: number;
};
type Row = {
  check_name: string;
  shard_name: string;
  test_runtime_policy: string;
  groups_gzip_base64?: string;
  groups?: Group[];
  configs?: string[];
  env?: Record<string, string>;
  includePatterns?: string[];
  targets?: string[];
  pretest_build_mode?: string;
  requires_dist?: boolean;
  requires_bun?: boolean;
  requires_go?: boolean;
  requires_ripgrep?: boolean;
  requires_sandbox_image?: boolean;
  plan_concurrency?: number;
  timeout_minutes?: number;
  git_commits?: string[];
};
type Cohort = {
  head: string;
  rows: Row[];
  files: string[];
  env: Record<string, string>;
  concurrency: number;
  hash: string;
};
const directory = resolve(".ddtest-tooling");
const planDirectory = resolve(".testoptimization");
const config = "test/vitest/vitest.tooling.config.ts";
const read = (path: string) => readFileSync(path, "utf8");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const save = (name: string, value: unknown) =>
  writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2) + "\n");
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function output(name: string, value: unknown) {
  assert(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
  );
}
function head(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  assert(
    result.status === 0 && /^[a-f0-9]{40}\s*$/.test(result.stdout),
    "Cannot resolve checkout head",
  );
  const sha = result.stdout.trim();
  assert(sha === process.env.GITHUB_SHA, "Checkout differs from workflow SHA");
  return sha;
}
function pathWithinCohort(value: unknown): string {
  assert(
    typeof value === "string" && value.length > 0 && !/[\r\n\0*?\[\]{}\\]/.test(value),
    "Expected literal test path",
  );
  const path = isAbsolute(value) ? relative(process.cwd(), value) : value.replace(/^\.\//, "");
  assert(
    !isAbsolute(path) &&
      !path.split("/").includes("..") &&
      /^(test|src\/scripts)\/.+\.test\.ts$/.test(path),
    "Unexpected tooling path",
  );
  assert(
    lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    "Expected regular test file",
  );
  assert(
    realpathSync(path).startsWith(realpathSync(process.cwd()) + sep),
    "Test path leaves checkout",
  );
  return path;
}
function distinct(files: string[], label: string): string[] {
  assert(new Set(files).size === files.length, `Duplicate ${label}`);
  return [...files].sort();
}
function groups(row: Row): Group[] {
  const decoded = row.groups_gzip_base64
    ? decodeNodeTestGroups(row.groups_gzip_base64)
    : row.groups;
  assert(
    Array.isArray(decoded) && decoded.length === 1,
    "Pilot requires one explicit group per row",
  );
  const group = decoded[0] as Group;
  assert(JSON.stringify(group.configs) === JSON.stringify([config]), "Unexpected config");
  assert(
    Array.isArray(group.includePatterns) && group.includePatterns.length > 0,
    "Missing explicit tooling inventory",
  );
  return [group];
}
function readCohort(): Cohort {
  const cohort: Cohort = JSON.parse(read(resolve(directory, "cohort.json")));
  const { hash: expected, ...payload } = cohort;
  assert(cohort.head === head() && hash(payload) === expected, "Cohort head/hash mismatch");
  assert(
    hash(JSON.parse(read(resolve(directory, "include.json")))) === hash(cohort.files),
    "Include inventory mismatch",
  );
  return cohort;
}
function inventory() {
  mkdirSync(directory, { recursive: true });
  const sha = head();
  const manifestOutput = resolve(directory, "manifest-output.txt");
  writeFileSync(manifestOutput, "");
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/ci-build-manifest.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      GITHUB_OUTPUT: manifestOutput,
      OPENCLAW_CI_EVENT_NAME: "push",
      OPENCLAW_CI_REPOSITORY: "anmarchenko/openclaw",
      OPENCLAW_CI_RUN_NODE: "true",
      OPENCLAW_CI_RUN_NODE_FAST_ONLY: "false",
      OPENCLAW_CI_RUNNER_PROFILE: "github",
      OPENCLAW_CI_NODE_RUNNER_BACKEND: "github",
      OPENCLAW_CI_CHANGED_PATHS_FILE: "",
      OPENCLAW_CI_CHANGED_PATHS_JSON: "null",
      OPENCLAW_CI_CHECKOUT_REVISION: sha,
      OPENCLAW_CI_WORKFLOW_REVISION: sha,
      OPENCLAW_CI_RELEASE_GATE: "false",
      OPENCLAW_CI_VALIDATION_TIER: "full",
    },
  });
  assert(result.status === 0, "Canonical manifest failed");
  const line = read(manifestOutput)
    .split("\n")
    .find((value) => value.startsWith("checks_node_core_nondist_matrix="));
  assert(line, "Canonical Node matrix missing");
  const matrix = JSON.parse(line.slice(line.indexOf("=") + 1));
  const rows: Row[] = matrix.include.filter(
    (row: Row) =>
      /^checks-node-core-tooling-\d+$/.test(row.check_name) &&
      !row.pretest_build_mode &&
      !row.requires_dist &&
      !row.requires_bun &&
      !row.requires_go &&
      !row.requires_ripgrep &&
      !row.requires_sandbox_image,
  );
  assert(rows.length > 1 && rows.length <= 32, "Unsupported tooling cohort size");
  rows.sort((a, b) => a.check_name.localeCompare(b.check_name));
  const env = { ...rows[0].env, ...groups(rows[0])[0].env };
  const concurrency = 1;
  const files = distinct(
    rows.flatMap((row) => {
      assert(
        row.test_runtime_policy === "node" && !row.targets?.length,
        "Unsupported runtime/targets",
      );
      assert(
        row.plan_concurrency === undefined,
        "Explicit concurrency requires revalidating canonical worker limits",
      );
      assert(!row.timeout_minutes || row.timeout_minutes === 60, "Unsupported job deadline");
      const group = groups(row)[0];
      assert(!row.git_commits?.length, "Additional Git prerequisites require explicit handling");
      assert(
        group.fallbackMaxWorkers === undefined && group.minTotalMemoryBytes === undefined,
        "Special group resources are outside this pilot",
      );
      assert(hash({ ...row.env, ...group.env }) === hash(env), "Mixed cohort environments");
      return group.includePatterns.map(pathWithinCohort);
    }),
    "cohort file ownership",
  );
  const payload = { head: sha, rows, files, env, concurrency };
  save("cohort.json", { ...payload, hash: hash(payload) });
  save("include.json", files);
  output("control_matrix", {
    include: rows.map((row, index) => ({ index, check_name: row.check_name })),
  });
  output("max_parallelism", rows.length);
  console.log(
    `Tooling cohort: ${rows.length} original runners, ${files.length} files, ${hash(files)}`,
  );
}
function planner() {
  const cohort = readCohort();
  const binary = process.env.DDTEST_BINARY;
  assert(binary && isAbsolute(binary), "DDTEST_BINARY must be an absolute installed binary path");
  const result = spawnSync(
    binary,
    [
      "plan",
      "--platform",
      "javascript",
      "--framework",
      "vitest",
      "--command",
      `node ./node_modules/vitest/vitest.mjs run --config ${config}`,
      "--min-parallelism",
      "1",
      "--max-parallelism",
      String(cohort.rows.length),
      "--ci-job-overhead",
      "64s",
      "--strict-discovery",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ...cohort.env,
        NODE_OPTIONS: "--max-old-space-size=8192",
        OPENCLAW_VITEST_MAX_WORKERS: cohort.env.OPENCLAW_VITEST_MAX_WORKERS ?? "2",
        OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
        OPENCLAW_VITEST_RUNTIME: "node",
        OPENCLAW_CI_TEST_RUNTIME_POLICY: "node",
        OPENCLAW_VITEST_INCLUDE_FILE: resolve(directory, "include.json"),
      },
    },
  );
  assert(result.status === 0, `ddtest planning failed (${result.status ?? result.signal})`);
}
function planEvidence() {
  const cohort = readCohort();
  const allowed = new Set(cohort.files);
  const files = (text: string) =>
    distinct(
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((value) => {
          const path = pathWithinCohort(value);
          assert(allowed.has(path), "Plan includes file outside cohort");
          return path;
        }),
      "planned file",
    );
  const discovered = read(resolve(planDirectory, "tests-discovery/tests.json"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const discoveryFiles = [
    ...new Set(
      discovered
        .filter((record) => !record._ddtest_discovery_cache_metadata)
        .map((record) => pathWithinCohort(record.suiteSourceFile)),
    ),
  ].sort();
  assert(hash(discoveryFiles) === hash(cohort.files), "Discovery omitted or added cohort files");
  const runnable = files(read(resolve(planDirectory, "runner/test-files.txt")));
  const configText = read(resolve(planDirectory, "github/config")).trim();
  assert(configText.startsWith("matrix="), "Missing ddtest GitHub matrix");
  const matrix = JSON.parse(configText.slice("matrix=".length));
  assert(
    Array.isArray(matrix.include) &&
      matrix.include.length >= 1 &&
      matrix.include.length <= cohort.rows.length,
    "Invalid dynamic runner count",
  );
  const count = matrix.include.length;
  matrix.include.forEach(
    (entry: { ci_node_index: number; ci_node_total: number }, index: number) => {
      assert(
        entry.ci_node_index === index && entry.ci_node_total === count,
        "Invalid ddtest matrix indices",
      );
    },
  );
  assert(
    Number(read(resolve(planDirectory, "runner/parallel-runners.txt")).trim()) === count,
    "Runner count disagreement",
  );
  const splitDirectory = resolve(planDirectory, "runner/tests-split");
  const names = readdirSync(splitDirectory).sort();
  assert(
    hash(names) === hash(Array.from({ length: count }, (_, index) => `runner-${index}`).sort()),
    "Unexpected split files",
  );
  const splits: string[][] = Array.from({ length: count }, (_, index) =>
    files(read(resolve(splitDirectory, `runner-${index}`))),
  );
  assert(
    hash(distinct(splits.flat(), "split ownership")) === hash(runnable),
    "Split union differs from runnable files",
  );
  const payload = {
    head: cohort.head,
    cohortHash: cohort.hash,
    discoveredTests: discovered.filter((record) => !record._ddtest_discovery_cache_metadata).length,
    discoveredFiles: discoveryFiles.length,
    runnable,
    splits,
    matrix,
  };
  return { ...payload, hash: hash(payload) };
}
function verifyPlan() {
  const evidence = planEvidence();
  save("plan.json", evidence);
  output("matrix", evidence.matrix);
  console.log(
    `Validated ddtest plan: ${evidence.discoveredFiles} discovered files, ${evidence.runnable.length} runnable, ${evidence.splits.length} runners`,
  );
}
function run(arm: "control" | "dynamic", rawIndex: string | undefined) {
  const cohort = readCohort();
  assert(rawIndex && /^\d+$/.test(rawIndex), "Runner index required");
  const index = Number(rawIndex);
  const evidence = planEvidence();
  assert(
    hash(JSON.parse(read(resolve(directory, "plan.json")))) === hash(evidence),
    "Plan changed since verification",
  );
  const row = arm === "control" ? cohort.rows[index] : cohort.rows[0];
  assert(row && (arm === "control" || index < evidence.splits.length), "Runner index outside plan");
  const selected =
    arm === "control"
      ? groups(row)[0].includePatterns.map(pathWithinCohort).sort()
      : evidence.splits[index];
  const start = performance.now();
  let exitCode = 0;
  let signal: string | null = null;
  if (selected.length > 0) {
    const packed =
      arm === "control"
        ? (row.groups_gzip_base64 ?? encodeNodeTestGroups(groups(row)))
        : encodeNodeTestGroups([
            {
              ...groups(row)[0],
              configs: [config],
              env: cohort.env,
              includePatterns: selected,
              shard_name: `ddtest-tooling-${index}`,
            },
          ]);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/ci-run-node-test-shard.mts"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim(),
          OPENCLAW_VITEST_MAX_WORKERS: "2",
          OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
          OPENCLAW_CI_TEST_RUNTIME_POLICY: "node",
          OPENCLAW_VITEST_RUNTIME: "node",
          OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: packed,
          OPENCLAW_NODE_TEST_GROUPS_JSON: "",
          OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(row.configs ?? []),
          OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(row.env ?? {}),
          OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: JSON.stringify(selected),
          OPENCLAW_NODE_TEST_TARGETS_JSON: "[]",
          OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: "[]",
          OPENCLAW_VITEST_SHARD_NAME:
            arm === "control" ? row.shard_name : `ddtest-tooling-${index}`,
          OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "300000",
          OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: String(cohort.concurrency),
          OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: "0",
          OPENCLAW_E2E_USE_PREBUILT_DIST: "",
          OPENCLAW_VITEST_INCLUDE_FILE: "",
        },
      },
    );
    signal = result.signal;
    exitCode = result.status ?? 1;
  }
  save(`result-${arm}-${index}.json`, {
    arm,
    index,
    head: cohort.head,
    cohortHash: cohort.hash,
    planHash: evidence.hash,
    selected,
    selectedCount: selected.length,
    selectedHash: hash(selected),
    elapsedSeconds: (performance.now() - start) / 1000,
    exitCode,
    signal,
    emptyPlan: selected.length === 0,
  });
  process.exitCode = exitCode;
}
assert(availableParallelism() >= 2, "Pilot requires at least two available CPUs");
assert(process.env.GITHUB_ACTIONS === "true", "This comparison helper runs only in hosted CI");
const [mode, index] = process.argv.slice(2);
if (mode === "inventory") inventory();
else if (mode === "plan") planner();
else if (mode === "verify-plan") verifyPlan();
else if (mode === "run-control") run("control", index);
else if (mode === "run-dynamic") run("dynamic", index);
else
  throw new Error("Expected inventory, plan, verify-plan, run-control INDEX, or run-dynamic INDEX");
