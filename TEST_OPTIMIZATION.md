# Datadog Test Optimization on the personal fork

The GitHub-hosted baseline is recorded in [PR #1](https://github.com/anmarchenko/openclaw/pull/1), including every test job and its duration: 26h 03m 26s of aggregate runner execution and 1h 47m 58s elapsed. Keep runner selection and the test matrix unchanged when comparing TIA savings.

## Configuration

Set the `DD_API_KEY` Actions secret and the `DD_SITE` repository variable (`datadoghq.com` for US1). External pull requests without the secret run the original uninstrumented tests. A configured key with a missing site fails setup.

All supported Node/Vitest lanes use **one service, `openclaw-tests`**, with `DD_ENV=ci`. There is no E2E classification or service selection in the launcher.

The repository variable **`DD_CIVISIBILITY_ITR_ENABLED`** is the single TIA switch, defaulting to `true`. Set it to the literal `false` to disable suite skipping while retaining test reporting. `true` permits skipping when enabled in the service's Datadog settings. Changes apply to the next run. The former `OPENCLAW_DD_TIA_TESTS` and `OPENCLAW_DD_TIA_E2E` variables are no longer read.

For pinned dd-trace 6.18.0 with Vitest, local `false` prevents fetching and selecting skippable suites, but coverage collection and the `test.itr.tests_skipping.enabled` tag still follow backend settings. That tag alone does not prove skipping occurred. Disabling backend TIA also disables its coverage collection.

## Why the launcher needs a small hook

The CI setup action owns installation and configuration: it installs `dd-trace@6.18.0` in the runner's temporary directory and exports the Datadog settings. Datadog automatically instruments Vitest; no tests are manually wrapped.

The existing `resolveVitestTestCommand` adds the CI and ESM preloads to the final Node/Vitest child's `NODE_OPTIONS`, preserving its memory flags and test arguments. Both direct and batch callers forward that environment. OpenClaw overwrites Node options while constructing shard environments, so an earlier job-wide preload would be lost. Build/preparation and Bun commands remain uninstrumented. Vitest workers inherit the preloads before test setup clears `NODE_OPTIONS` from fixture environments.

The [official Datadog action](https://github.com/DataDog/test-visibility-github-action) can install the tracer, but Vitest still needs explicit Node preload configuration. Changing the installer would not remove this final-child hook or the compatibility fixes below.

## Compatibility fixes retained

- The small ESM preload imports Datadog's stock loader and preserves native Node builtin identities. Stock builtin proxies broke `syncBuiltinESMExports()` and produced resolved builtin URLs unusable in uninstrumented child processes. Package hooks, including Vitest instrumentation, remain enabled.
- `DD_TRACE_OPENAI_ENABLED=false` prevents the pinned OpenAI tracing integration from mutating streamed SDK chunks.
- `DD_TRACE_HTTP_ENABLED=false` preserves Node raw header arrays that the pinned HTTP propagation hook otherwise converts incorrectly.
- `DD_TRACE_OTEL_ENABLED=false` keeps the application's native OpenTelemetry provider and OTLP exporter contract.

These exclusions preserve Vitest reporting and TIA. Datadog early flake detection and automatic retries stay disabled to preserve the comparison workload.

## Coverage and verification

The single TIA switch applies equally to normal and Node-driven E2E tests. Enabling it does not establish complete dependency coverage: Chromium and separately spawned Gateway/CLI processes are not covered by the test worker's V8 coverage. Validate representative application edits before treating skips as safe for those subprocesses. Datadog disables TIA for Vitest browser-mode invocations itself. Non-isolated workers may conservatively accumulate coverage and skip fewer suites.

Bun tests, custom non-Vitest QA flows, native platform jobs, static checks and non-Vitest build verifiers are excluded. Frozen historical targets do not contain this launcher integration. No ddtest scheduling is introduced.

Verify individual worker events for `openclaw-tests`, filtered by CI pipeline ID and PR head (`git.commit.head.sha`). Check actual suite-skip events separately from enabled tags. Historical runs used two services; their results do not prove the unified configuration.

Compare equivalent changes with TIA off and on, recording selected/skipped suites, test-step time, summed assigned runner execution and queue-inclusive elapsed time. Preserve every test-job duration. Calculate monetary savings only from actual billed runner prices; public-repository standard GitHub-hosted runners can have zero direct runner charges.
