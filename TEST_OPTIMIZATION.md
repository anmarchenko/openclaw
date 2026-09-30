# Datadog Test Optimization on the personal fork

The GitHub-hosted baseline is recorded in [PR #1](https://github.com/anmarchenko/openclaw/pull/1), including every test job and its duration. The successful baseline used 26h 03m 26s of aggregate runner time and 1h 47m 58s of elapsed time. Keep runner selection and the test matrix unchanged when comparing TIA savings.

## Configuration

Set the `DD_API_KEY` Actions secret and the `DD_SITE` repository variable (`datadoghq.com` for US1). External pull requests without the secret run the original uninstrumented tests. A configured key with a missing site fails setup instead of silently sending data to the wrong site.

| Service (`DD_SERVICE`) | Coverage                                                                                                                | Repository TIA switch   | Default |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------- |
| `openclaw-tests`       | Existing normal Node, tooling, contract, and Control UI test lanes                                                      | `OPENCLAW_DD_TIA_TESTS` | `true`  |
| `openclaw-e2e`         | Dedicated E2E, real-Gateway UI, browser-extension and QA test-file lanes; dedicated E2E configs invoked by build checks | `OPENCLAW_DD_TIA_E2E`   | `false` |

Set either switch to the literal `true` or `false`. Each Vitest invocation maps its switch to `DD_CIVISIBILITY_ITR_ENABLED`. `false` disables TIA for that service while keeping test reporting. `true` allows TIA when enabled in that service's Datadog Test Optimization settings; it does not override a disabled backend setting. Both services use `DD_ENV=ci`. Service names do not depend on shard, test file, or runner.

For Vitest with dd-trace 6.18.0, the local off switch prevents fetching skippable suites, but the Vitest integration still derives coverage collection and the reported `test.itr.tests_skipping.enabled` tag from backend settings. An enabled tag alone does not prove tests can be skipped. Verify the local configuration and actual selected/skipped suites when validating the switches; use the service settings in Datadog to disable backend TIA and its coverage collection.

For example, set `OPENCLAW_DD_TIA_TESTS=false` and `OPENCLAW_DD_TIA_E2E=true` to disable normal-test TIA and allow E2E TIA independently. Change repository variables for the next run; changing them does not modify an already running process. For a full instrumented training/comparison run, set both to `false`.

## Integration and scope

CI installs `dd-trace@6.18.0` in the runner's temporary directory, outside the application's dependencies. The existing Vitest launch owner adds the Datadog ESM and CI preloads to the final child environment after shard-specific Node options have been resolved. The preload preserves native Node builtin module identities: the stock tracer loader proxies them, which breaks `syncBuiltinESMExports()` and produces tracer-specific URLs that cannot be copied into uninstrumented child processes. Builtin ESM proxy instrumentation is bypassed; package modules retain the stock tracer hooks for Vitest test reporting and TIA. Workers inherit the hooks before test setup clears `NODE_OPTIONS`; build and orchestration processes receive no global preload. Both direct and grouped test invocations use the same owner. Automatic Datadog flaky retries and early flake detection are disabled so they do not alter the comparison workload.

The services follow the existing execution lanes, not filename suffixes: some normal Node shards also contain integration-style or `.e2e.test.ts` files. This PR preserves those shard boundaries. It does not claim complete cross-process dependency coverage for either service. Keep TIA disabled for comparisons requiring complete execution until coverage behavior has been validated against representative source edits.

Vitest browser mode is reported, but dd-trace disables TIA for the whole mixed browser/Node invocation. Node-driven Playwright E2E is different: Chromium and separately spawned Gateway/CLI processes are not covered by the test worker's V8 coverage. E2E TIA therefore defaults off; enabling it is an explicit experiment and is not proof that remote application changes are safely selected. Non-isolated workers may conservatively accumulate coverage and skip fewer tests.

Bun test processes, custom QA flow scenarios that do not invoke Vitest, native platform jobs, static checks, and non-Vitest build verifiers are not instrumented. Frozen historical targets do not contain this launcher integration. No ddtest scheduling is introduced.

## Verification and savings

Verify individual test and suite events in Datadog for both services, filtered by the PR commit and GitHub run. Session creation alone is insufficient proof of worker instrumentation. Verify TIA settings and actual skipped suites separately; a passing training run with zero skipped tests is not a measured savings result.

Compare equivalent source changes with TIA off and on, recording selected/skipped tests, test-step time, summed runner execution, queue-inclusive elapsed time, and instrumentation/setup overhead. Compute monetary savings from the runners actually billed; public-repository standard GitHub-hosted runners can have zero direct runner charges. Preserve the full list of test jobs and durations for each comparison run.
