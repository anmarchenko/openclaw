import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTestBunSourceArgs } from "../../src/test-utils/bun-process.ts";
import { resolveRepoRoot } from "./repo-root.mjs";
import { resolveVitestNodeArgs } from "./vitest-process-env.mts";

/** Select only the Vitest process; orchestration and preparation retain Node. */
export function resolveVitestTestCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
  const runtime = env.OPENCLAW_VITEST_RUNTIME?.trim() || "node";
  if (runtime === "node") {
    const tracerHome = env.OPENCLAW_DD_TRACE_HOME;
    const cliIndex = args.findIndex((arg) => path.basename(arg) === "vitest.mjs");
    if (!tracerHome || cliIndex < 0) {
      return { command: process.execPath, args };
    }
    // Add hooks only at the final spawn, after shard-specific V8 options.
    // Workers inherit them before test-env removes NODE_OPTIONS from fixtures.
    const configArg = args.find((arg) => arg.startsWith("--config="));
    const configIndex = args.findIndex((arg) => arg === "--config" || arg === "-c");
    const config =
      configArg?.slice("--config=".length) ??
      (configIndex >= 0 ? args[configIndex + 1] : undefined);
    const e2e =
      env.OPENCLAW_DD_TEST_KIND === "e2e" ||
      env.OPENCLAW_BROWSER_EXTENSION_E2E === "1" ||
      /(?:^|[/\\])vitest\.(?:e2e|ui-e2e(?:-prebuilt)?|extension-qa)\.config\.ts$/.test(
        config ?? "",
      );
    const tia = e2e ? env.OPENCLAW_DD_TIA_E2E : env.OPENCLAW_DD_TIA_TESTS;
    if (tia && tia !== "true" && tia !== "false") {
      throw new Error("Datadog TIA switches must be true or false");
    }
    return {
      command: process.execPath,
      args,
      env: {
        ...env,
        NODE_OPTIONS: [
          env.NODE_OPTIONS,
          `--import=${JSON.stringify(pathToFileURL(path.join(tracerHome, "register.js")).href)}`,
          `--require=${JSON.stringify(path.join(tracerHome, "ci/init.js"))}`,
        ]
          .filter(Boolean)
          .join(" "),
        DD_SERVICE: e2e ? "openclaw-e2e" : "openclaw-tests",
        DD_CIVISIBILITY_ITR_ENABLED: tia || (e2e ? "false" : "true"),
      },
    };
  }
  if (runtime !== "bun") {
    throw new Error(`Invalid OPENCLAW_VITEST_RUNTIME: ${runtime}; expected node or bun`);
  }
  const cliIndex = args.findIndex((arg) => path.basename(arg) === "vitest.mjs");
  if (cliIndex < 0) {
    return { command: process.execPath, args };
  }
  const nodeFlags = new Set(resolveVitestNodeArgs({}));
  return {
    command: "bun",
    // Strip V8 flags only before the CLI; test names and filters stay byte-for-byte.
    args: [
      // Workers inherit this resolver without adding aliases to child-process environments.
      ...resolveTestBunSourceArgs(resolveRepoRoot(import.meta.url)),
      ...args.slice(0, cliIndex).filter((arg) => !nodeFlags.has(arg)),
      ...args.slice(cliIndex),
    ],
  };
}
