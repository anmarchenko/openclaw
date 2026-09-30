# CI baseline before Datadog Test Parallelization

This personal fork records the existing CI runtime before onboarding JavaScript
tests with ddtest and dd-trace-js.

## Baseline configuration

- Repository: `anmarchenko/openclaw`
- Source commit: `d9afe2cfa2359471c99de51adc15f075b1431bdb`
- Workflow: `.github/workflows/ci.yml`, unchanged from upstream
- Runner setting: `OPENCLAW_CI_RUNNER_BACKEND=github`
- Trigger: pull request into the fork's `main`
- Workflow changes: comments only; test commands and dependencies are unchanged
- Node.js: `24.21.0`; pnpm: `12.5.1`; Vitest: `5.0.1`
- Datadog instrumentation and ddtest: not installed

Upstream's existing fork gates skip native macOS, iOS, Android, and Windows
jobs. The PR run measures the fork's selected JavaScript and supporting checks,
not every upstream platform. This is a fresh-fork run, so caches may be cold.

## Measurement

PR baseline results are pending.

The initial [manual attempt](https://github.com/anmarchenko/openclaw/actions/runs/36684217619)
ran from `2026-09-30T07:31:50Z` to `2026-09-30T07:33:44Z` (1 minute 54 seconds).
Preflight failed after 45 seconds because `validation_tier=main` requires the
canonical upstream repository. Tests did not run; this is not a test-suite timing.

Measure wall-clock time from workflow creation to the final job completion,
including queue time. Record the outcome, slowest jobs, and total job execution
time separately. A failed or incomplete run is not a successful full-suite
baseline. Future comparisons must use the same source, runner configuration,
test scope, and cache conditions, or disclose the differences.
