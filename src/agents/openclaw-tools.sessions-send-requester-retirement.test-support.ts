import { expect, it, vi, type MockInstance } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { mergeAcceptedSessionSpawnsForRun } from "./accepted-session-spawn.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "./embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "./embedded-agent-runner/runs.test-support.js";
import { announceTesting } from "./subagents/announce/subagent-announce-overrides.test-support.js";
import * as registryPersistence from "./subagents/registry/subagent-registry-persistence.js";
import { onSubagentRegistryPersisted } from "./subagents/registry/subagent-registry-state.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./tools/in-process-gateway.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

export type GatewayCall = {
  method?: string;
  params?: Record<string, unknown>;
  onAccepted?: (payload: unknown) => void;
};

/** Reuse the coordination suite's transport and state fixture for post-commit retirement. */
export function registerSessionsSendRequesterRetirementTests({
  config,
  callGatewayMock,
  calls,
  writeEntry,
  settleSessionWork,
}: {
  config: OpenClawConfig;
  callGatewayMock: AgentToolGatewayRequestCaller &
    MockInstance<(request: GatewayCall) => Promise<unknown>>;
  calls: GatewayCall[];
  writeEntry: (sessionKey: string, entry: SessionEntry, storePath?: string) => Promise<void>;
  settleSessionWork: () => Promise<void>;
}) {
  it.each([
    { mode: "followup", retirement: "before publication" },
    { mode: "followup", retirement: "after publication" },
    { mode: "steer", retirement: "before publication" },
    { mode: "steer", retirement: "after publication" },
  ] as const)(
    "delivers a watched $mode once when the requester retires $retirement",
    async ({ mode, retirement }) => {
      const requesterSessionKey = "agent:main:dashboard:retiring-requester";
      const childSessionKey = "agent:main:dashboard:retiring-child";
      const requesterTurnRunId = "retiring-requester-turn";
      const childSessionId = "retiring-child";
      const runId = "retired-requester-child-run";
      await writeEntry(requesterSessionKey, { sessionId: "retiring-requester", updatedAt: 1 });
      await writeEntry(childSessionKey, {
        sessionId: childSessionId,
        updatedAt: 1,
        spawnedBy: requesterSessionKey,
        spawnDepth: 1,
      });
      resetSubagentRegistryForTests();
      const childPending = createDeferredCore();
      const terminalReply = { disposition: "visible", text: "Result after requester retirement" };
      callGatewayMock.mockImplementation(async (request: GatewayCall) => {
        calls.push(request);
        if (request.method === "agent" && request.params?.sessionKey === childSessionKey) {
          return { runId, status: "accepted", targetDisposition: "queued" };
        }
        if (request.method === "agent.wait" && request.params?.runId === runId) {
          await childPending.promise;
          return { runId, status: "ok", startedAt: 1, endedAt: Date.now(), terminalReply };
        }
        if (request.method === "agent") {
          return {
            result: {
              payloads: [{ text: "Retired requester's child result delivered" }],
              deliveryStatus: { status: "sent", resultCount: 1 },
            },
          };
        }
        return {};
      });
      const queueMessage = vi.fn(async () => {});
      const handle = createEmbeddedRunHandle({ runId, queueMessage });
      if (mode === "steer") {
        await registerSubagentRun({
          runId,
          childSessionKey,
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          requesterAgentId: "main",
          task: "Existing child work",
          cleanup: "keep",
          spawnMode: "session",
          expectsCompletionMessage: true,
        });
        setActiveEmbeddedRun(childSessionId, handle, childSessionKey);
      } else {
        addSubagentRunForTests({
          runId: "retiring-original-child-run",
          childSessionKey,
          requesterSessionKey,
          requesterAgentId: "main",
          expectsCompletionMessage: true,
          createdAt: 1,
          execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
          completion: { required: true, resultText: "Original result" },
          delivery: { status: "delivered" },
          cleanupCompletedAt: 3,
        });
      }
      const admission = prepareSystemAgentRunAdmission(
        config,
        requesterTurnRunId,
        "main",
        "watched-followup-retirement",
      );
      const admittedRunContext = await admission.admit("embedded");
      const context = createContext();
      // This fixture uses the mocked transport; it does not boot a hosted recovery runtime.
      context.localEmbedded = true;
      context.getRuntimeConfig = () => config;
      context.resolveGatewayContext = () => context;
      let retiredAfterCommit = false;
      const retireRequester = () => {
        expect(mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance)).toEqual([]);
        retiredAfterCommit = true;
        admission.close();
      };
      const publish = registryPersistence.publishSubagentRunPostimages;
      const retireBeforePublication = vi
        .spyOn(registryPersistence, "publishSubagentRunPostimages")
        .mockImplementation((params) =>
          publish({
            ...params,
            persist: (owner, options, ...runIds) =>
              params.persist(
                owner,
                {
                  ...options,
                  onCommitted: () => {
                    if (
                      retirement === "before publication" &&
                      !retiredAfterCommit &&
                      runIds.includes(runId)
                    ) {
                      retireRequester();
                    }
                    options.onCommitted?.();
                  },
                },
                ...runIds,
              ),
          }),
        );
      const execute = stateWorker.runOpenClawStateWorkerOperation;
      const retire = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation(async (owner, run, options) => {
          const result = await execute(owner, run, options);
          if (
            retirement === "after publication" &&
            !retiredAfterCommit &&
            getSubagentRunByRunId(runId)?.requesterTurnRunId === requesterTurnRunId
          ) {
            retireRequester();
          }
          return result;
        });
      announceTesting.setDepsForTest({ callGateway: callGatewayMock });
      let stopObserving = () => {};
      try {
        const result = await withPluginRuntimeGatewayRequestScope(
          { context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
          () =>
            withGatewayToolCallerIdentity(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext,
                agentId: "main",
                sessionKey: requesterSessionKey,
              }),
              () =>
                createSessionsSendTool({
                  agentSessionKey: requesterSessionKey,
                  requesterTurnRunId,
                  config,
                  callGateway: callGatewayMock,
                }).execute("retiring-watched-send", {
                  sessionKey: childSessionKey,
                  mode,
                  watch: true,
                  timeoutSeconds: 0,
                  message: "Return the follow-up result",
                }),
            ),
        );
        expect(retiredAfterCommit).toBe(true);
        expect(result.details).toMatchObject({ status: "error", sentBeforeError: true });
        expect(getSubagentRunByRunId(runId)?.requesterTurnRunId).toBeUndefined();
        if (mode === "steer") {
          expect(queueMessage).toHaveBeenCalledOnce();
        }
        const requesterCalls = () =>
          calls.filter(
            (call) => call.method === "agent" && call.params?.sessionKey === requesterSessionKey,
          );
        expect(requesterCalls()).toHaveLength(0);
        const delivered = createDeferredCore();
        stopObserving = onSubagentRegistryPersisted(() => {
          const child = getSubagentRunByRunId(runId);
          if (child?.delivery?.status === "delivered" && !child.requesterSettleWake) {
            delivered.resolve();
          }
        });
        clearActiveEmbeddedRun(childSessionId, handle, childSessionKey);
        childPending.resolve();
        await delivered.promise;
        await settleSessionWork();
        expect(requesterCalls()).toHaveLength(1);
        expect(requesterCalls()[0]?.params).toMatchObject({
          message: expect.stringContaining(terminalReply.text),
          inputProvenance: { sourceTool: "subagent_announce" },
        });
        emitAgentEvent({
          runId,
          sessionKey: childSessionKey,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now(), terminalReply },
        });
        await settleSessionWork();
        expect(requesterCalls()).toHaveLength(1);
      } finally {
        retire.mockRestore();
        retireBeforePublication.mockRestore();
        admission.close();
        clearActiveEmbeddedRun(childSessionId, handle, childSessionKey);
        childPending.resolve();
        stopObserving();
        resetSubagentRegistryForTests();
        await settleSessionWork();
        announceTesting.setDepsForTest();
      }
    },
  );
}
