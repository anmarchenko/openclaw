import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { getSubagentRunsForRequesterSession, subagentRuns } from "./subagent-registry-memory.js";
import { settleRequesterAfterSessionSpawns } from "./subagent-registry.js";

/** A failed caller cannot retain a committed child claim after its tool returns. */
export async function releaseRequesterTurnClaimForRun(params: {
  runId: string;
  requesterSessionKey: string;
  requesterAgentId: string;
  requesterTurnRunId: string;
}): Promise<boolean> {
  const ownedEntries = () =>
    [...getSubagentRunsForRequesterSession(params.requesterSessionKey)].filter(
      (entry) =>
        entry.requesterAgentId === params.requesterAgentId &&
        entry.requesterTurnRunId === params.requesterTurnRunId &&
        entry.expectsCompletionMessage === true,
    );
  const entries = ownedEntries();
  const acceptedEntry = entries.find((entry) => entry.runId === params.runId);
  if (!acceptedEntry) {
    return false;
  }
  return subagentRuns.runWithCompletionBatchAuthority(entries, async () => {
    const custody = await captureOperatorToolGatewayContinuationContext();
    if (!custody) {
      throw new Error("Committed requester claim has no retained completion custody");
    }
    try {
      const current = ownedEntries();
      if (!current.includes(acceptedEntry)) {
        return false;
      }
      // The transfer owns row retirement; retain source custody independently of those rows.
      return await subagentRuns.runWithCompletionBatchAuthority(current, () =>
        custody.run(() =>
          settleRequesterAfterSessionSpawns({
            ...params,
            requesterYielded: false,
            acceptedSessionSpawns: current.map((entry) => ({
              runId: entry.taskRunId ?? entry.runId,
              childSessionKey: entry.childSessionKey,
              expectsCompletionMessage: true,
            })),
            assertCurrent: custody.assertCurrent,
          }),
        ),
      );
    } finally {
      custody.release();
    }
  });
}
