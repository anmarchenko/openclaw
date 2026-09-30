// Keep Node's builtin module identities while retaining Datadog's test hooks.
import { isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tracerHome = process.env.OPENCLAW_DD_TRACE_HOME;
if (!tracerHome) {
  throw new Error("Datadog test preload requires OPENCLAW_DD_TRACE_HOME");
}
await import(pathToFileURL(path.join(tracerHome, "register.js")).href);

// dd-trace 6.18.0 proxies ESM builtins. Captured exports break
// syncBuiltinESMExports(), and its ?iitm URLs cannot be reused in uninstrumented
// children. Keep builtins native; package loads retain the stock test hooks.
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
