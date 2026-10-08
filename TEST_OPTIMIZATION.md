# Datadog Test Optimization

CI uses the official `ddtest` CLI to plan and execute supported test suites. The comparison baseline is [PR #2](https://github.com/anmarchenko/openclaw/pull/2). There is no fixed-runner control arm or separate comparison workflow.

## Setup

Set the Actions secret `DD_API_KEY`. The workflow installs the official ddtest release and the official `DataDog/test-visibility-github-action` with the latest tracer. Tests use service `openclaw-tests`, environment `ci`, and the default Datadog site.

`DD_CIVISIBILITY_ITR_ENABLED` is the repository variable controlling TIA, defaulting to `true`. Early flake detection and automatic retries remain disabled. The existing OpenAI, HTTP, and OpenTelemetry instrumentation opt-outs and Node builtin compatibility preload from PR #2 remain in place.

## Execution

For Node/Vitest families and Control UI, a planning job runs `ddtest plan`. Its emitted matrix determines the number of test runners. Workers download `.testoptimization` and execute `ddtest run --ci-node ...`. Checkout is shallow. OpenClaw's preflight still supplies selected files, runtime prerequisites, and resource boundaries; ddtest owns skipping and partitioning within those boundaries. Vitest's old shard argument is not combined with ddtest assignments.

Existing singleton proof, contract, and platform boundaries use a one-runner ddtest plan. Python skills tests use ddtest's pytest integration. Plans sharing a working directory execute serially because ddtest stores its plan in `.testoptimization`.

Bun and dual-runtime routing retain their existing runner because ddtest's JavaScript integration supports Node, not Bun. Swift, Android, custom QA process verifiers, lint, builds, and security audits retain their existing tools. Frozen target fallbacks remain explicit compatibility paths.

The former `scripts/ci-ddtest-tooling.mts` adapter and paired `ddtest-tooling.yml` workflow are removed. Native ddtest invokes Vitest directly. Vitest test/hook deadlines and GitHub job deadlines remain; the former OpenClaw launcher-specific no-output watchdog does not apply to direct execution.

## Results

Report the main CI run against PR #2 only. Include planning jobs and setup time in aggregate runner duration. Separate queue-inclusive wall time from assigned runner time, and compare equivalent completed workloads. Jobs that never acquired runners are not savings. Backend omissions made during ddtest planning and tracer-reported TIA events are distinct measurements.

Workflow test suites, workflow wiring assertions, and their unused mocks are removed at the user’s request. Application and script behavior tests remain. Account for this workload reduction separately from ddtest when comparing with PR #2.

The migration must complete hosted CI before runtime or cost improvements can be claimed. Browser and separately spawned Gateway/CLI subprocess coverage remains incomplete; an enabled TIA tag alone does not establish safe skipping.
