import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupOwnedKeychain,
  createOwnedKeychain,
  probeOwnedKeychain,
} from "../../.github/actions/ios-signing-keychain/keychain.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { cleanupTempDirs, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { registerBoundedSignalTests } from "./mobile-release-process.test-support.js";

const testNodeExecPath = resolveTestNodeExecPath();
const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const joinedObservationRoots: string[] = [];
afterEach(() => cleanupTempDirs(joinedObservationRoots));

function writeFile(root: string, file: string, source: string): void {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

function readOutputs(file: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe("mobile release CI tools", () => {
  it("keeps an absent-state iOS keychain post cleanup side-effect free", () => {
    const runnerTemp = tempRoots.make("openclaw-ios-keychain-post-runner-");
    const workspace = tempRoots.make("openclaw-ios-keychain-post-workspace-");
    fs.mkdirSync(path.join(workspace, "apps/ios"), { recursive: true });
    const fakeBin = path.join(runnerTemp, "bin");
    const bundleMarker = path.join(runnerTemp, "bundle-called");
    const environmentFile = path.join(runnerTemp, "environment");
    const stateFile = path.join(runnerTemp, "state");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "bundle"), '#!/bin/sh\n: > "$BUNDLE_MARKER"\nexit 99\n', {
      mode: 0o700,
    });

    const result = spawnSync(process.execPath, [".github/actions/ios-signing-keychain/post.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BUNDLE_MARKER: bundleMarker,
        GITHUB_ENV: environmentFile,
        GITHUB_STATE: stateFile,
        GITHUB_WORKSPACE: workspace,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        RUNNER_TEMP: runnerTemp,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(bundleMarker)).toBe(false);
    expect(fs.existsSync(environmentFile)).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(
      fs
        .readdirSync(runnerTemp)
        .some((entry) => entry.startsWith("openclaw-ios-signing-keychain-")),
    ).toBe(false);
  });

  it("masks and owns both resolved iOS keychain filename forms through post cleanup", async () => {
    const workspace = tempRoots.make("openclaw-ios-keychain-workspace-");
    fs.mkdirSync(path.join(workspace, "apps/ios"), { recursive: true });
    for (const filenameSuffix of ["", "-db"] as const) {
      const runnerTemp = tempRoots.make(
        `openclaw-ios-keychain-${filenameSuffix ? "database" : "requested"}-`,
      );
      const environmentFile = path.join(runnerTemp, "environment");
      const stateFile = path.join(runnerTemp, "state");
      const env = {
        ...process.env,
        GITHUB_ENV: environmentFile,
        GITHUB_STATE: stateFile,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
      };
      let actionOutput = "";
      const output = {
        write(value: string) {
          actionOutput += value;
          return true;
        },
      };
      const commands: Array<{ args: string[]; executable: string }> = [];
      const runCommand = async (
        executable: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        commands.push({ args, executable });
        expect(executable).toBe("bundle");
        if (args.includes("create_keychain")) {
          const requestedPath = args.find((argument) => argument.startsWith("path:"))?.slice(5);
          if (!requestedPath) {
            throw new Error("Missing create_keychain path");
          }
          expect(fs.readFileSync(stateFile, "utf8")).toContain(`requested_path=${requestedPath}\n`);
          const password = options.env?.KEYCHAIN_PASSWORD;
          expect(password).toMatch(/^[a-f0-9]{64}$/u);
          expect(args.join("\n")).not.toContain(password);
          fs.writeFileSync(`${requestedPath}${filenameSuffix}`, "owned keychain\n");
        } else if (args.includes("delete_keychain")) {
          const keychainPath = args
            .find((argument) => argument.startsWith("keychain_path:"))
            ?.slice("keychain_path:".length);
          if (!keychainPath) {
            throw new Error("Missing delete_keychain path");
          }
          fs.unlinkSync(keychainPath);
        } else {
          throw new Error(`Unexpected Fastlane action: ${args.join(" ")}`);
        }
        return { stderr: "", stdout: "" };
      };

      const created = await createOwnedKeychain({ env, output, runCommand });
      expect(created.resolvedPath).toBe(`${created.requestedPath}${filenameSuffix}`);
      expect(fs.statSync(created.ownedRoot).mode & 0o777).toBe(0o700);
      expect(actionOutput).toBe(`::add-mask::${created.password}\n`);
      expect(fs.readFileSync(environmentFile, "utf8")).toBe(
        `MATCH_KEYCHAIN_NAME=${created.resolvedPath}\n` +
          `MATCH_KEYCHAIN_PASSWORD=${created.password}\n`,
      );
      const state = readOutputs(stateFile);
      expect(state.resolved_path).toBe(created.resolvedPath);
      await cleanupOwnedKeychain({
        env: {
          ...env,
          STATE_owned_root: state.owned_root,
          STATE_requested_path: state.requested_path,
          STATE_resolved_path: state.resolved_path,
        },
        runCommand,
      });
      expect(fs.existsSync(created.ownedRoot)).toBe(false);
      expect(commands.map(({ args }) => args[4])).toEqual(["create_keychain", "delete_keychain"]);
      expect(commands.at(-1)?.args).toContain(`keychain_path:${created.resolvedPath}`);
    }

    const source = fs.readFileSync(".github/actions/ios-signing-keychain/keychain.mjs", "utf8");
    expect(source.indexOf("maskSecret(password, output)")).toBeLessThan(
      source.indexOf(
        'appendCommandValue(environmentFile, "MATCH_KEYCHAIN_PASSWORD", password, appendFile)',
      ),
    );
    expect(source).toContain("default_keychain: false");
    expect(source).toContain("lock_after_timeout: true");
    expect(source).toContain("timeout: KEYCHAIN_LIFETIME_SECONDS");
    expect(source).not.toContain("skip_set_partition_list");
  });

  it("cleans a partial iOS keychain create and refuses paths outside its ownership", async () => {
    const workspace = tempRoots.make("openclaw-ios-keychain-partial-workspace-");
    fs.mkdirSync(path.join(workspace, "apps/ios"), { recursive: true });
    for (const filenameSuffix of ["", "-db"] as const) {
      const runnerTemp = tempRoots.make(
        `openclaw-ios-keychain-partial-${filenameSuffix ? "database" : "requested"}-`,
      );
      const environmentFile = path.join(runnerTemp, "environment");
      const stateFile = path.join(runnerTemp, "state");
      const env = {
        ...process.env,
        GITHUB_ENV: environmentFile,
        GITHUB_STATE: stateFile,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
      };
      const createCommand = async (_command: string, args: string[]) => {
        const requestedPath = args.find((argument) => argument.startsWith("path:"))?.slice(5);
        if (!requestedPath) {
          throw new Error("Missing partial create path");
        }
        fs.writeFileSync(`${requestedPath}${filenameSuffix}`, "partial keychain\n");
        throw new Error("partial create");
      };

      await expect(
        createOwnedKeychain({
          env,
          output: { write: () => true },
          runCommand: createCommand,
        }),
      ).rejects.toThrow("partial create");
      expect(fs.existsSync(environmentFile)).toBe(false);
      const state = readOutputs(stateFile);
      const partialPath = `${state.requested_path}${filenameSuffix}`;
      expect(fs.existsSync(partialPath)).toBe(true);
      await cleanupOwnedKeychain({
        env: {
          ...env,
          STATE_owned_root: state.owned_root,
          STATE_requested_path: state.requested_path,
        },
        runCommand: async (_command: string, args: string[]) => {
          const keychainPath = args
            .find((argument) => argument.startsWith("keychain_path:"))
            ?.slice("keychain_path:".length);
          expect(keychainPath).toBe(partialPath);
          fs.unlinkSync(partialPath);
          return { stderr: "", stdout: "" };
        },
      });
      expect(fs.existsSync(expectDefined(state.owned_root, "owned keychain root"))).toBe(false);
    }

    const runnerTemp = tempRoots.make("openclaw-ios-keychain-guard-runner-");
    const env = {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
    };
    const outsidePath = path.join(runnerTemp, "outside.keychain-db");
    fs.writeFileSync(outsidePath, "not owned\n");
    const ownedRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    const requestedPath = path.join(ownedRoot, "signing.keychain");
    let cleanupCalled = false;
    await expect(
      cleanupOwnedKeychain({
        env: {
          ...env,
          STATE_owned_root: ownedRoot,
          STATE_requested_path: requestedPath,
          STATE_resolved_path: outsidePath,
        },
        runCommand: async () => {
          cleanupCalled = true;
          return { stderr: "", stdout: "" };
        },
      }),
    ).rejects.toThrow("Unexpected owned keychain path");
    expect(cleanupCalled).toBe(false);
    expect(fs.existsSync(outsidePath)).toBe(true);

    const ambiguousRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    const ambiguousRequestedPath = path.join(ambiguousRoot, "signing.keychain");
    fs.writeFileSync(ambiguousRequestedPath, "requested keychain\n");
    fs.writeFileSync(`${ambiguousRequestedPath}-db`, "database keychain\n");
    await expect(
      cleanupOwnedKeychain({
        env: {
          ...env,
          STATE_owned_root: ambiguousRoot,
          STATE_requested_path: ambiguousRequestedPath,
        },
        runCommand: async () => {
          cleanupCalled = true;
          return { stderr: "", stdout: "" };
        },
      }),
    ).rejects.toThrow("Refusing ambiguous job-owned keychain cleanup");
    expect(cleanupCalled).toBe(false);
  });

  it("binds both iOS keychain filename forms to the configured signing team", async () => {
    const runnerTemp = tempRoots.make("openclaw-ios-keychain-probe-runner-");
    const workspace = tempRoots.make("openclaw-ios-keychain-probe-workspace-");
    writeFile(
      workspace,
      "apps/ios/Config/AppStoreSigning.json",
      `${JSON.stringify({ teamId: "FWJYW4S8P8" }, null, 2)}\n`,
    );
    const identityHash = "A".repeat(40);
    for (const keychainFilename of ["signing.keychain", "signing.keychain-db"] as const) {
      const ownedRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
      const keychainPath = path.join(ownedRoot, keychainFilename);
      fs.writeFileSync(keychainPath, "owned keychain\n");
      const calls: Array<{ args: string[]; executable: string; timeoutMs?: number }> = [];
      const runCommand = async (
        executable: string,
        args: string[],
        options: { timeoutMs?: number },
      ) => {
        calls.push({ args, executable, timeoutMs: options.timeoutMs });
        if (executable === "/usr/bin/security") {
          expect(args.at(-1)).toBe(keychainPath);
          return {
            stderr: "",
            stdout: `  1) ${identityHash} "Apple Distribution: OpenClaw Foundation (FWJYW4S8P8)"\n`,
          };
        }
        const probePath = args.at(-1);
        expect(executable).toBe("/usr/bin/codesign");
        expect(probePath).toBeTruthy();
        expect(fs.readFileSync(probePath as string)).toEqual(fs.readFileSync("/usr/bin/true"));
        if (args.includes("--force")) {
          expect(args).toContain(keychainPath);
        }
        if (args.includes("--display")) {
          return { stderr: "TeamIdentifier=FWJYW4S8P8\n", stdout: "" };
        }
        return { stderr: "", stdout: "" };
      };

      await expect(
        probeOwnedKeychain({
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            MATCH_KEYCHAIN_NAME: keychainPath,
            RUNNER_TEMP: runnerTemp,
          },
          runCommand,
        }),
      ).resolves.toEqual({
        identity: "Apple Distribution: OpenClaw Foundation (FWJYW4S8P8)",
        teamId: "FWJYW4S8P8",
      });
      expect(calls.map(({ executable }) => executable)).toEqual([
        "/usr/bin/security",
        "/usr/bin/codesign",
        "/usr/bin/codesign",
        "/usr/bin/codesign",
      ]);
      expect(calls.every(({ timeoutMs }) => timeoutMs !== undefined && timeoutMs <= 30_000)).toBe(
        true,
      );
      expect(calls.some(({ executable, args }) => executable === args.at(-1))).toBe(false);
      expect(
        fs
          .readdirSync(runnerTemp)
          .some((entry) => entry.startsWith("openclaw-ios-codesign-probe-")),
      ).toBe(false);
    }

    const wrongTeamRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    const wrongTeamPath = path.join(wrongTeamRoot, "signing.keychain");
    fs.writeFileSync(wrongTeamPath, "owned keychain\n");
    await expect(
      probeOwnedKeychain({
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          MATCH_KEYCHAIN_NAME: wrongTeamPath,
          RUNNER_TEMP: runnerTemp,
        },
        runCommand: async () => ({
          stderr: "",
          stdout: `  1) ${identityHash} "Apple Distribution: Other Team (AAAAAAAAAA)"\n`,
        }),
      }),
    ).rejects.toThrow("Expected one Apple Distribution identity for team FWJYW4S8P8, found 0");

    let unsafeCommandCount = 0;
    const rejectUnsafeCommand = async () => {
      unsafeCommandCount += 1;
      return { stderr: "", stdout: "" };
    };
    const missingRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    await expect(
      probeOwnedKeychain({
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          MATCH_KEYCHAIN_NAME: path.join(missingRoot, "signing.keychain"),
          RUNNER_TEMP: runnerTemp,
        },
        runCommand: rejectUnsafeCommand,
      }),
    ).rejects.toThrow("Owned keychain is missing");
    const symlinkRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    const symlinkTarget = path.join(runnerTemp, "foreign.keychain");
    fs.writeFileSync(symlinkTarget, "foreign keychain\n");
    fs.symlinkSync(symlinkTarget, path.join(symlinkRoot, "signing.keychain"));
    await expect(
      probeOwnedKeychain({
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          MATCH_KEYCHAIN_NAME: path.join(symlinkRoot, "signing.keychain"),
          RUNNER_TEMP: runnerTemp,
        },
        runCommand: rejectUnsafeCommand,
      }),
    ).rejects.toThrow("Owned keychain path is not a regular file");
    expect(unsafeCommandCount).toBe(0);
  });

  registerBoundedSignalTests();

  it("bounds owned child process trees", async () => {
    const runnerTemp = tempRoots.make("openclaw-ios-keychain-process-runner-");
    if (process.platform !== "win32") {
      const exerciseOwnedProcessTree = async ({
        expectedError,
        grandchildSource,
        maxOutputBytes,
        name,
        timeoutMs,
      }: {
        expectedError: string;
        grandchildSource: string;
        maxOutputBytes?: number;
        name: string;
        timeoutMs: number;
      }) => {
        const pidFile = path.join(runnerTemp, `${name}.pid`);
        const parentSource = [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], {`,
          '  stdio: ["ignore", process.stdout, process.stderr],',
          "});",
          "fs.writeFileSync(process.env.PID_FILE, `${process.pid}\\n${child.pid}\\n`);",
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const runnerSource = `
import fs from "node:fs";
import { runBounded } from ${JSON.stringify(pathToFileURL(path.resolve(".github/actions/ios-signing-keychain/keychain.mjs")).href)};
const startedAt = Date.now();
let message = "";
try {
  await runBounded(process.execPath, ["-e", ${JSON.stringify(parentSource)}], {
    env: { ...process.env, PID_FILE: ${JSON.stringify(pidFile)} },
    maxOutputBytes: ${JSON.stringify(maxOutputBytes)},
    terminateGraceMs: 200,
    timeoutMs: ${timeoutMs},
  });
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
const processIds = fs.readFileSync(${JSON.stringify(pidFile)}, "utf8").trim().split("\\n").map(Number);
let processGroupAlive = true;
try { process.kill(-processIds[0], 0); } catch (error) {
  if (error?.code !== "ESRCH") throw error;
  processGroupAlive = false;
}
process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt, message, processGroupAlive, processIds }));
`;
        const result = spawnSync(
          testNodeExecPath,
          ["--input-type=module", "--eval", runnerSource],
          { cwd: process.cwd(), encoding: "utf8", env: process.env },
        );
        expect(result.status, result.stderr).toBe(0);
        const outcome = JSON.parse(result.stdout) as {
          elapsedMs: number;
          message: string;
          processGroupAlive: boolean;
          processIds: number[];
        };
        expect(outcome.message).toContain(expectedError);
        expect(outcome.elapsedMs).toBeLessThan(3_000);
        const processIds = outcome.processIds;
        expect(processIds).toHaveLength(2);
        const processGroupId = processIds[0];
        if (
          typeof processGroupId !== "number" ||
          !Number.isSafeInteger(processGroupId) ||
          processGroupId <= 0
        ) {
          throw new Error(`Invalid owned process-group ID: ${processGroupId}`);
        }
        expect(outcome.processGroupAlive).toBe(false);
      };

      await exerciseOwnedProcessTree({
        expectedError: "timed out after 1000ms",
        grandchildSource: 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 5000);',
        name: "timeout-tree",
        timeoutMs: 1_000,
      });
      await exerciseOwnedProcessTree({
        expectedError: "exceeded the 4096-byte output limit",
        grandchildSource:
          'process.on("SIGTERM", () => {}); setInterval(() => process.stdout.write("x".repeat(2048)), 1);',
        maxOutputBytes: 4096,
        name: "output-cap-tree",
        timeoutMs: 5_000,
      });
    }
  });
});
