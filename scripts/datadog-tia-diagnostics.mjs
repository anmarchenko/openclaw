// Read the backend decision after tests, using the official action's existing identity.
// This request does not change settings, upload coverage, or select tests.
import os from "node:os";

const { DD_API_KEY, DD_SERVICE, DD_ENV, GITHUB_SHA, GITHUB_REPOSITORY } = process.env;
if (!DD_API_KEY || !DD_SERVICE || !DD_ENV || !GITHUB_SHA || !GITHUB_REPOSITORY) {
  console.log("[datadog-tia-decision] required action identity unavailable");
} else {
  const identity = {
    test_level: "suite",
    service: DD_SERVICE,
    env: DD_ENV,
    repository_url: `https://github.com/${GITHUB_REPOSITORY}.git`,
    sha: GITHUB_SHA,
    configurations: {
      "os.platform": process.platform,
      "os.version": os.release(),
      "os.architecture": process.arch,
      "runtime.name": "node",
      "runtime.version": process.version,
    },
  };
  try {
    const response = await fetch("https://api.datadoghq.com/api/v2/ci/tests/skippable", {
      method: "POST",
      headers: { "content-type": "application/json", "dd-api-key": DD_API_KEY },
      body: JSON.stringify({ data: { type: "test_params", attributes: identity } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      console.log(`[datadog-tia-decision] HTTP ${response.status}`);
    } else {
      const payload = await response.json();
      const suites = (payload.data ?? []).filter((item) => item.type === "suite");
      const source = suites.filter((item) => item.attributes?.suite?.startsWith("src/"));
      const ui = suites.filter((item) => item.attributes?.suite?.startsWith("ui/"));
      console.log(
        `[datadog-tia-decision] ${JSON.stringify({
          identity,
          receivedSuites: suites.length,
          sourceSuites: source.length,
          uiSuites: ui.length,
          missingLineCoverage: suites.filter(
            (item) => item.attributes?._is_missing_line_code_coverage,
          ).length,
          sourceSample: source.slice(0, 5).map((item) => item.attributes.suite),
          uiSample: ui.slice(0, 5).map((item) => item.attributes.suite),
        })}`,
      );
    }
  } catch {
    // Never print request objects, headers, credentials, or arbitrary API error bodies.
    console.log("[datadog-tia-decision] diagnostic request failed");
  }
}
