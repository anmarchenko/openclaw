// Tests reset hook fallback behavior inside the get-reply directive pipeline.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNativeResetContext,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyBaselineBypass,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

registerGetReplyBaselineBypass();

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  emitResetCommandHooks: vi.fn(),
  initSessionState: vi.fn(),
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
}));
vi.mock("./commands-core.runtime.js", () => ({
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

function createContinueDirectivesResult(resetHookTriggered: boolean) {
  return createGetReplyContinueDirectivesResult({
    body: "/new",
    abortKey: "telegram:slash:123",
    from: "telegram:123",
    to: "slash:123",
    senderId: "123",
    commandSource: "/new",
    senderIsOwner: true,
    resetHookTriggered,
  });
}

describe("getReplyFromConfig reset-hook fallback", () => {
  beforeAll(async () => {
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildNativeResetContext(),
        sessionKey: "agent:main:telegram:direct:123",
        isNewSession: true,
        resetTriggered: true,
        sessionScope: "per-sender",
        triggerBodyNormalized: "/new",
        bodyStripped: "",
      }),
    );

    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(false));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits reset hooks when inline actions return early without marking resetHookTriggered", async () => {
    const onObservedReplyDelivery = vi.fn();

    await getReplyFromConfig(buildNativeResetContext(), { onObservedReplyDelivery }, {});

    expect(mocks.emitResetCommandHooks).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "new",
        onObservedReplyDelivery,
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });

  it("does not emit fallback hooks when resetHookTriggered is already set", async () => {
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(true));

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });
});
