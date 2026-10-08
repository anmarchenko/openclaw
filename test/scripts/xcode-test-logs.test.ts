import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/lib/swift-toolchain.sh");

describe.skipIf(process.platform === "win32")("Apple command log spool", () => {
  it.each([0, 65])(
    "retains complete file output and exit %s with a bounded console tail",
    (code) => {
      const root = tempDirs.make("openclaw-xcode-test-logs-");
      const bin = path.join(root, "tools with spaces");
      const log = path.join(root, "results with spaces", "test.log");
      const trace = path.join(root, "trace.json");
      const args = ["test", "-scheme", "Scheme With Spaces", "-only-testing:Tests/cleanup"];
      mkdirSync(bin);
      const executable = path.join(bin, "apple-command-fixture");
      writeFileSync(
        executable,
        `#!/usr/bin/env node
const fs = require("node:fs");
const regularFiles = [1, 2].every((fd) => fs.fstatSync(fd).isFile());
fs.writeFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ regularFiles, args: process.argv.slice(2) }));
if (!regularFiles) process.exit(99);
fs.writeSync(1, "STDOUT_START\\n" + "o".repeat(200000) + "\\nSTDOUT_END\\n");
fs.writeSync(2, "STDERR_START\\n" + "e".repeat(200000) + "\\nSTDERR_END\\n");
process.exit(${code});
`,
      );
      chmodSync(executable, 0o755);

      const result = spawnSync(
        "/bin/bash",
        [
          "-euo",
          "pipefail",
          "-c",
          'source "$1"; shift; run_apple_command_logged "$@"',
          "fixture",
          helper,
          log,
          executable,
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 20_000,
          env: {
            ...process.env,
            FIXTURE_TRACE: trace,
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(code);
      expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual({ regularFiles: true, args });
      expect(readFileSync(log, "utf8")).toBe(
        `STDOUT_START\n${"o".repeat(200000)}\nSTDOUT_END\nSTDERR_START\n${"e".repeat(200000)}\nSTDERR_END\n`,
      );
      expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThan(9000);
      expect(result.stdout).toContain("STDERR_END");
      expect(result.stdout).toContain(`[apple-command] Exit ${code}; full log: ${log}`);
    },
  );
});
