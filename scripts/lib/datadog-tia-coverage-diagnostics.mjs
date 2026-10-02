// Passive, bounded coverage evidence for the TIA experiment. Never mutate tracer events.
import { channel } from "node:diagnostics_channel";
import path from "node:path";

const root = process.cwd();
const write = process.stderr.write.bind(process.stderr);
let observed = 0;
const counts = new Map();

channel("ci:vitest:test-suite:finish").subscribe((event) => {
  try {
    if (!Array.isArray(event.coverageFiles)) {
      return;
    }
    observed++;
    const files = [...new Set(event.coverageFiles.map((file) => path.relative(root, file)))];
    for (const file of files) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    if (observed <= 3) {
      write(
        `[datadog-tia-coverage] ${JSON.stringify({
          suite: path.relative(root, event.testSuiteAbsolutePath),
          coveredFiles: files.length,
          sourceFiles: files.filter((file) => file.startsWith("src/")).length,
          sample: files.slice(0, 10),
        })}\n`,
      );
    }
  } catch {
    // Diagnostics cannot fail or alter a test or a tracer publication.
  }
});

process.once("exit", () => {
  try {
    if (observed > 0) {
      write(
        `[datadog-tia-coverage-summary] ${JSON.stringify({
          suites: observed,
          distinctFiles: counts.size,
          commonFiles: [...counts].filter(([, count]) => count === observed).slice(0, 30),
        })}\n`,
      );
    }
  } catch {
    // A diagnostic output failure cannot replace the test exit status.
  }
});
