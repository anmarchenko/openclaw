// Keep Node's builtin module identities while retaining Datadog's test hooks.
import { isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tracerHome = process.env.OPENCLAW_DD_TRACE_HOME;
if (!tracerHome) {
  throw new Error("Datadog test preload requires OPENCLAW_DD_TRACE_HOME");
}
await import(pathToFileURL(path.join(tracerHome, "register.js")).href);

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
