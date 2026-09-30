// Keep Node's live filesystem bindings while retaining Datadog's test hooks.
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tracerHome = process.env.OPENCLAW_DD_TRACE_HOME;
if (!tracerHome) {
  throw new Error("Datadog test preload requires OPENCLAW_DD_TRACE_HOME");
}
await import(pathToFileURL(path.join(tracerHome, "register.js")).href);

// dd-trace 6.18.0 wraps ESM node:fs even though ci/init disables fs tracing.
// Its proxy captures named exports, breaking syncBuiltinESMExports() and the
// permission-failure tests. Keep fs native; all other loads retain stock hooks.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "fs" || specifier === "node:fs") {
      return { url: "node:fs", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "node:fs") {
      return { format: "builtin", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
