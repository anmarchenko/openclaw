import { inspectSourceUpdateArtifacts } from "../../../scripts/lib/source-update-artifact-preflight.mts";
import { formatErrorMessage } from "../../infra/errors.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { isFailedUpdateStep } from "../../infra/update-run-step.js";
import { recordUpdateRunPhaseAsync } from "../../infra/update-run-write.async.js";
import type { UpdateRunnerOptions, UpdateRunResult } from "../../infra/update-runner-types.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import type { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";

type BeforeGitMutation = NonNullable<UpdateRunnerOptions["beforeGitMutation"]>;

export function assertGitCandidateSteps(steps: UpdateRunResult["steps"]): void {
  const failed = steps.find(isFailedUpdateStep);
  if (failed) {
    throw new UpdatePreMutationError(failed.name, failed.stderrTail ?? "Update checks failed.", {
      failureFacts: failed.failureFacts,
    });
  }
}

export async function admitSourceUpdateArtifacts(
  root: string,
  run: UpdateCommandOptions["run"],
): Promise<boolean> {
  try {
    const prepared = await inspectSourceUpdateArtifacts(root);
    if (prepared.lock && !run) {
      await prepared.lock.release();
      throw new Error("Source artifact admission requires an active update run.");
    }
    if (run) {
      run.sourceArtifactLock = prepared.lock;
    }
    return prepared.sourceRuntimePrepared;
  } catch (cause) {
    throw new UpdatePreMutationError("source-artifact-ownership", formatErrorMessage(cause), {
      cause,
    });
  }
}

export async function recordInspectedGitTarget(
  run: UpdateCommandOptions["run"],
  target: Parameters<BeforeGitMutation>[0],
  assertCurrent: () => void,
  captureWriteOptions: ReturnType<typeof createUpdateCommandExecutionGuards>["captureWriteOptions"],
): Promise<void> {
  assertCurrent();
  if (run) {
    await recordUpdateRunPhaseAsync(
      run.runId,
      "staging",
      {
        target: { kind: "git", sha: target.sha, version: target.version },
      },
      captureWriteOptions(),
    );
  }
  assertCurrent();
  assertReadableGitTarget(target);
}

export function assertReadableGitTarget(target: Parameters<BeforeGitMutation>[0]): void {
  if (target.metadataUnreadable) {
    const failure = createUpdatePreflightFailure("target-git-metadata", target.metadataUnreadable);
    throw new UpdatePreMutationError("target-metadata-preflight", failure.message, {
      failureFacts: failure.failureFacts,
    });
  }
}
