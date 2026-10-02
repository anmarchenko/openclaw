// Keep Node's builtin module identities while retaining Datadog's test hooks.
import { isBuiltin, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

if (process.env.OPENCLAW_DD_TIA_DIAGNOSTICS === "1") {
  await import("./datadog-tia-coverage-diagnostics.mjs");
}

const tracerRegister = process.env.DD_TRACE_ESM_IMPORT;
if (!tracerRegister) {
  throw new Error("Datadog test preload requires DD_TRACE_ESM_IMPORT");
}
await import(pathToFileURL(tracerRegister).href);

// Preserve native builtin bindings so syncBuiltinESMExports() updates them.
// Preserve native builtin URLs so import.meta.resolve() results remain usable
// in child processes without Datadog. Keep stock hooks for package modules,
// including Vitest.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) {
      return {
        url: specifier.startsWith("node:") ? specifier : `node:${specifier}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (isBuiltin(url)) {
      return { format: "builtin", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
