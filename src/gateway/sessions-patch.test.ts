import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import { projectCanonicalSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { withAgentSessionModelPatchOrigin } from "./session-model-patch-origin.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

const acpSessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionMetaForEntry: vi.fn(),
}));
const providerThinkingMocks = vi.hoisted(() => ({
  resolveProviderThinkingProfile:
    vi.fn<typeof import("../plugins/provider-thinking.js").resolveEffectiveThinkingProfile>(),
}));
vi.mock("../acp/runtime/session-meta-readonly.js", () => ({
  readAcpSessionMetaForEntry: acpSessionMetaMocks.readAcpSessionMetaForEntry,
}));
// Provider policy artifacts have their own contract coverage.
vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerThinkingMocks.resolveProviderThinkingProfile,
}));

const KEY = "agent:main:main";
const SONNET = "anthropic/claude-sonnet-4-6";
const OPUS = "anthropic/claude-opus-4-6";
const GPT = "openai/gpt-5.4";
type Projection = Parameters<typeof projectSessionsPatchEntry>[0];
type Patch = Omit<Projection["patch"], "key">;
type FixtureOptions = Omit<
  Projection,
  "patch" | "existingEntry" | "isLabelInUse" | "storeKey" | "cfg"
> & {
  key?: string;
  cfg?: OpenClawConfig;
  entry?: Partial<SessionEntry>;
  catalog?: ModelCatalogEntry[];
};

function catalogEntry(ref: string): ModelCatalogEntry {
  const separator = ref.indexOf("/");
  const id = ref.slice(separator + 1);
  return { provider: ref.slice(0, separator), id, name: id };
}

function catalog(...refs: string[]): ModelCatalogEntry[] {
  return refs.map(catalogEntry);
}

function fixture(options: FixtureOptions = {}) {
  const { key = KEY, cfg = {}, entry, catalog: entries, ...projection } = options;
  const store: Record<string, SessionEntry> =
    entry === undefined ? {} : { [key]: { sessionId: "sess", updatedAt: 1, ...entry } };
  async function patch(fields: Patch) {
    const result = await projectSessionsPatchEntry({
      ...projection,
      cfg,
      storeKey: key,
      existingEntry: store[key],
      patch: { key, ...fields },
      isLabelInUse: (label) =>
        Object.entries(store).some(([other, row]) => other !== key && row.label === label),
      loadGatewayModelCatalogSnapshot:
        projection.loadGatewayModelCatalogSnapshot ??
        (entries ? async () => ({ entries, routeVariants: entries }) : undefined),
    });
    if (result.ok) {
      store[key] = result.entry;
    }
    return result;
  }
  async function ok(fields: Patch) {
    const result = await patch(fields);
    expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.entry;
  }
  async function rejects(fields: Patch, message: string) {
    const before = structuredClone(store);
    const result = await patch(fields);
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(message) },
    });
    expect(store).toEqual(before);
  }
  return { key, store, patch, ok, rejects };
}

function modelConfig(): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: GPT }, models: { [SONNET]: { alias: "sonnet" } } } },
  };
}

function modelFixture(options: FixtureOptions = {}) {
  return fixture({
    cfg: modelConfig(),
    catalog: catalog(GPT, SONNET, OPUS),
    providerAuthMetadataSnapshot: { plugins: [] },
    ...options,
  });
}

function unavailableCatalog() {
  return vi.fn(async (): Promise<never> => {
    throw new Error("Catalog must not be needed");
  });
}

describe("gateway sessions patch", () => {
  beforeEach(() => {
    providerThinkingMocks.resolveProviderThinkingProfile.mockReset();
    providerThinkingMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) => {
        if (provider !== "openai") {
          return undefined;
        }
        if (context.modelId === "gpt-5.5") {
          return {
            levels: (["off", "minimal", "low", "medium", "high", "xhigh"] as const).map((id) => ({
              id,
            })),
          };
        }
        if (context.modelId === "gpt-5.6-luna") {
          const levels =
            context.agentRuntime === "openclaw"
              ? (["off", "minimal", "low", "medium", "high", "max", "ultra"] as const)
              : (["off", "minimal", "low", "medium", "high", "max"] as const);
          return { levels: levels.map((id) => ({ id })) };
        }
        return undefined;
      },
    );
  });
  afterEach(() => {
    acpSessionMetaMocks.readAcpSessionMetaForEntry.mockReset();
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
  });

  test("keeps SVG icons through normalization and unrelated patches, then clears them", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
    const icon = "data:image/svg+xml," + encodeURIComponent(svg);
    const f = fixture({ entry: { label: "Night watch", color: "purple" } });
    const entry = await f.ok({ icon: svg });
    expect(entry).toMatchObject({ icon, color: "purple" });
    f.store[KEY] = projectCanonicalSessionEntryShape({ ...entry });
    expect(await f.ok({ label: "Updated night watch" })).toMatchObject({ icon });
    await f.rejects({ icon: "https://example.com/icon.svg" }, "icon must be");
    expect(f.store[KEY].icon).toBe(icon);
    expect((await f.ok({ icon: null })).icon).toBeUndefined();
    expect(f.store[KEY].color).toBe("purple");
  });

  test("keeps manual labels independent of automatic device labels", async () => {
    const f = fixture({ key: "agent:main:node-1234567890ab" });
    const autoLabel = "OpenClaw App · Pixel · 1234567890ab";
    const label = "OpenClaw App · Release planning · 1234567890ab";
    expect(await f.ok({ autoLabel })).toMatchObject({ autoLabel });
    await f.ok({ label });
    expect(await f.ok({ autoLabel: "Updated device" })).toMatchObject({
      label,
      autoLabel: "Updated device",
    });
    const cleared = await f.ok({ label: null });
    expect(cleared.label).toBeUndefined();
    expect(cleared.autoLabel).toBe("Updated device");
    expect((await f.ok({ autoLabel: null })).autoLabel).toBeUndefined();
    f.store.other = { sessionId: "other", updatedAt: 1, label: autoLabel, autoLabel };
    expect(await f.ok({ autoLabel })).toMatchObject({ autoLabel });
  });

  test("rejects creating a missing harness session through patch", async () => {
    const f = fixture({ key: "agent:main:harness:codex:supervision:missing" });
    await f.rejects({ label: "squat" }, AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
    expect(f.store[f.key]).toBeUndefined();
  });

  test("allows metadata edits on an existing model-locked harness session", async () => {
    const f = fixture({
      key: "agent:main:harness:codex:supervision:existing",
      entry: { sessionId: "harness-session", agentHarnessId: "codex", modelSelectionLocked: true },
    });
    expect(await f.ok({ label: "kept" })).toMatchObject({
      sessionId: "harness-session",
      label: "kept",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });
  });

  test("attributes archive transitions idempotently and clears attribution on restore", async () => {
    const archivedBy = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const f = fixture({ entry: { pinnedAt: 10 }, archivedBy });
    const archived = await f.ok({ archived: true, expectedSessionId: "sess" });
    expect(archived).toMatchObject({
      archivedAt: expect.any(Number),
      archivedBy,
      archiveReason: "manual",
    });
    expect(archived.pinnedAt).toBeUndefined();
    const repeat = fixture({
      entry: archived,
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
    });
    expect(await repeat.ok({ archived: true, expectedSessionId: "sess" })).toMatchObject({
      archivedAt: archived.archivedAt,
      archivedBy,
      archiveReason: "manual",
    });
    const restored = await f.ok({ archived: false, expectedSessionId: "sess" });
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.archivedBy).toBeUndefined();
    expect(restored.archiveReason).toBeUndefined();
  });

  test("rejects archive for a provisional identity", async () => {
    const f = fixture({ entry: { sessionId: undefined } });
    await f.rejects({ archived: true }, "session not found: " + KEY);
  });

  test("requires the caller-observed durable identity for lifecycle patches", async () => {
    await fixture({ entry: {} }).rejects({ archived: true }, "expectedSessionId required");
  });

  test("does not fabricate archive attribution without an actor", async () => {
    const entry = await fixture({ entry: {} }).ok({ archived: true, expectedSessionId: "sess" });
    expect(entry.archivedAt).toEqual(expect.any(Number));
    expect(entry.archivedBy).toBeUndefined();
  });

  test("pins and unpins roots, rejecting archived sessions", async () => {
    const f = fixture({
      key: "agent:main:dashboard:root",
      entry: { spawnedBy: "  ", parentSessionKey: "  " },
    });
    expect((await f.ok({ pinned: true })).pinnedAt).toEqual(expect.any(Number));
    expect((await f.ok({ pinned: false })).pinnedAt).toBeUndefined();
    await fixture({ entry: { archivedAt: 10 } }).rejects({ pinned: true }, "restore it first");
  });

  test("rejects child pins and removes stale pins on metadata edits", async () => {
    const f = fixture({
      key: "agent:main:dashboard:child",
      entry: { pinnedAt: 10, spawnedBy: KEY },
    });
    await f.rejects({ pinned: true }, "cannot pin a child session; pin its parent session instead");
    expect((await f.ok({ label: "Child task" })).pinnedAt).toBeUndefined();
  });

  test("preserves Home-parented pins through metadata edits", async () => {
    const f = fixture({
      key: "agent:other:dashboard:work",
      entry: { parentSessionKey: "agent:other:main", pinnedAt: 10 },
    });
    const pinned = await f.ok({ pinned: true });
    expect(pinned.pinnedAt).toBe(10);
    expect((await f.ok({ label: "Work session" })).pinnedAt).toBe(pinned.pinnedAt);
  });

  test("marks archived sessions unread and clears the marker and agent status when read", async () => {
    const f = fixture({
      entry: {
        archivedAt: 10,
        lastReadAt: 20,
        agentStatus: { note: "Waiting", attention: "hand", expiresAt: Date.now() + 60_000 },
      },
    });
    const unread = await f.ok({ unread: true });
    expect(unread).toMatchObject({
      archivedAt: 10,
      lastReadAt: 20,
      markedUnreadAt: expect.any(Number),
    });
    const read = await f.ok({ unread: false });
    expect(read.archivedAt).toBe(10);
    expect(read.lastReadAt).toBeGreaterThanOrEqual(unread.markedUnreadAt ?? 0);
    expect(read.markedUnreadAt).toBeUndefined();
    expect(read.agentStatus).toBeUndefined();
  });

  test("sanitizes agent status, bounds its TTL, and clears it explicitly", async () => {
    const f = fixture({ entry: {} });
    const before = Date.now();
    const entry = await f.ok({
      statusNote: "  Blocked:\n need the staging password  ",
      attention: "key",
    });
    expect(entry.agentStatus).toMatchObject({
      note: "Blocked: need the staging password",
      attention: "key",
    });
    expect(entry.agentStatus?.expiresAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(entry.agentStatus?.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    await f.rejects({ statusNote: "Waiting", ttlMinutes: 121 }, "use 1-120");
    expect((await f.ok({ attention: null })).agentStatus).toBeUndefined();
  });

  test.each([
    { field: "responseUsage", value: "off" },
    { field: "reasoningLevel", value: "off" },
    { field: "fastMode", value: false },
    {
      field: "verboseLevel",
      value: "full",
      invalid: 'invalid verboseLevel (use "on"|"off"|"full")',
    },
    { field: "elevatedLevel", value: "off", invalid: "invalid elevatedLevel" },
  ] as const)("persists and clears $field overrides", async (row) => {
    const f = fixture();
    expect((await f.ok({ [row.field]: row.value }))[row.field]).toBe(row.value);
    if ("invalid" in row) {
      await f.rejects({ [row.field]: "maybe" }, row.invalid);
    }
    expect((await f.ok({ [row.field]: null }))[row.field]).toBeUndefined();
  });

  test("recreates partial rows without dropping session settings", async () => {
    const entry = await fixture({
      entry: {
        sessionId: undefined,
        sessionFile: "stale.jsonl",
        label: "Stale Session",
        sendPolicy: "deny",
        modelOverride: "gpt-5.4",
        liveModelSwitchPending: true,
        responseUsage: "tokens",
        parentSessionKey: KEY,
      },
    }).ok({ fastMode: true });
    expect(entry.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(entry.sessionFile).toBeUndefined();
    expect(entry.label).toBeUndefined();
    expect(entry.liveModelSwitchPending).toBeUndefined();
    expect(entry).toMatchObject({
      sendPolicy: "deny",
      modelOverride: "gpt-5.4",
      responseUsage: "tokens",
      parentSessionKey: KEY,
      fastMode: true,
    });
  });

  test("trims shared categories and clears them", async () => {
    const f = fixture({ entry: {} });
    f.store.other = { sessionId: "other", updatedAt: 1, category: "Research" };
    expect((await f.ok({ category: "  Research  " })).category).toBe("Research");
    expect((await f.ok({ category: null })).category).toBeUndefined();
  });

  test("normalizes colors, rejects unknown names, and clears the selection", async () => {
    const f = fixture({ entry: {} });
    expect((await f.ok({ color: "  Blue " })).color).toBe("blue");
    await f.rejects(
      { color: "crimson" },
      "color must be one of: red, blue, green, yellow, purple, orange, pink, cyan",
    );
    expect((await f.ok({ color: null })).color).toBeUndefined();
  });

  test("replaces sparse tool overlays rather than merging old policy", async () => {
    const f = fixture({ entry: {} });
    expect(
      (
        await f.ok({
          toolOverrides: {
            mcpServers: { zeta: false, alpha: true },
            mcpToolsDeny: { zeta: [], alpha: ["write", "read", "write"] },
            skills: {},
            webSearch: true,
          },
        })
      ).toolOverrides,
    ).toEqual({
      mcpServers: { alpha: true, zeta: false },
      mcpToolsDeny: { alpha: ["read", "write"] },
    });
    expect((await f.ok({ toolOverrides: { skills: { release: false } } })).toolOverrides).toEqual({
      skills: { release: false },
    });
    expect(
      (await f.ok({ toolOverrides: { mcpToolsDeny: { docs: [] } } })).toolOverrides,
    ).toBeUndefined();
    f.store[KEY].toolOverrides = { webSearch: false };
    expect((await f.ok({ toolOverrides: null })).toolOverrides).toBeUndefined();
  });

  test("retains an unprefixed auth pin within its provider and clears it on a provider switch", async () => {
    const f = modelFixture({
      cfg: { agents: { defaults: { model: OPUS } } },
      entry: {
        authProfileOverride: "work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 4,
      },
    });
    expect(await f.ok({ model: SONNET })).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      authProfileOverride: "work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 4,
    });
    const changed = await f.ok({ model: GPT });
    expect(changed).toMatchObject({ providerOverride: "openai", modelOverride: "gpt-5.4" });
    expect(changed.authProfileOverride).toBeUndefined();
    expect(changed.authProfileOverrideSource).toBeUndefined();
    expect(changed.authProfileOverrideCompactionCount).toBeUndefined();
  });

  test("preserves auth pins across provider-auth aliases", async () => {
    const f = modelFixture({
      cfg: {},
      entry: {
        providerOverride: "byteplus",
        modelOverride: "seedance-1-0-lite-t2v-250428",
        authProfileOverride: "byteplus:work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      },
      catalog: catalog("byteplus-plan/ark-code-latest"),
      providerAuthMetadataSnapshot: {
        plugins: [
          {
            id: "byteplus",
            channels: [],
            providers: ["byteplus", "byteplus-plan"],
            cliBackends: [],
            skills: [],
            hooks: [],
            origin: "bundled",
            rootDir: "/plugins/byteplus",
            source: "test",
            manifestPath: "/plugins/byteplus/openclaw.plugin.json",
            providerAuthAliases: { "byteplus-plan": "byteplus" },
          },
        ],
      },
    });
    expect(await f.ok({ model: "byteplus-plan/ark-code-latest" })).toMatchObject({
      providerOverride: "byteplus-plan",
      modelOverride: "ark-code-latest",
      authProfileOverride: "byteplus:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
  });

  test.each([{ model: SONNET }, { agentRuntime: null }] as const)(
    "rejects locked model/runtime changes before loading the catalog: %j",
    async (patch) => {
      const load = unavailableCatalog();
      const f = modelFixture({
        entry: {
          modelSelectionLocked: true,
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
          agentRuntimeOverride: "codex",
        },
        loadGatewayModelCatalogSnapshot: load,
      });
      await f.rejects(patch, MODEL_SELECTION_LOCKED_MESSAGE);
      expect(load).not.toHaveBeenCalled();
    },
  );

  test("does not queue a live model switch when materializing a placeholder", async () => {
    const entry = await modelFixture({
      entry: { sessionId: undefined, providerOverride: "openai", modelOverride: "gpt-5.4" },
    }).ok({ model: SONNET });
    expect(entry).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    });
    expect(entry.liveModelSwitchPending).toBeUndefined();
  });

  test("keeps the last validated selection across agent patches until an explicit selection", async () => {
    const cfg = modelConfig();
    cfg.agents!.defaults!.models![OPUS] = { alias: "opus" };
    const f = modelFixture({
      cfg,
      entry: {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-primary",
        authProfileOverride: "openai:good",
        authProfileOverrideSource: "user",
        thinkingLevel: "high",
      },
    });
    const first = await withAgentSessionModelPatchOrigin(() => f.ok({ model: SONNET }));
    const previous = {
      prevModel: "gpt-5.4",
      prevProvider: "openai",
      prevModelOverrideSource: "auto",
      prevModelOverrideFallbackOriginProvider: "openai",
      prevModelOverrideFallbackOriginModel: "gpt-primary",
      prevAuthProfileOverride: "openai:good",
      prevThinkingLevel: "high",
      source: "agent-patch",
    };
    expect(first.modelFallback).toMatchObject(previous);
    const second = await withAgentSessionModelPatchOrigin(() => f.ok({ model: OPUS }));
    expect(second.modelFallback).toMatchObject(previous);
    expect(second.modelFallback?.ts).toBeGreaterThan(first.modelFallback?.ts ?? 0);
    expect((await f.ok({ model: SONNET })).modelFallback).toBeUndefined();
  });

  test("realigns rollback thinking with independent explicit-off and clear patches without mutating input", async () => {
    const f = fixture({
      entry: {
        thinkingLevel: "high",
        modelOverride: "claude-sonnet-4-6",
        providerOverride: "anthropic",
        modelFallback: {
          prevModel: "gpt-5.4",
          prevProvider: "openai",
          prevThinkingLevel: "high",
          ts: 1,
          source: "agent-patch",
        },
      },
    });
    const input = f.store[KEY];
    const before = structuredClone(input);
    const changed = await f.ok({ thinkingLevel: "off" });
    expect(changed.thinkingLevel).toBe("off");
    expect(changed.modelFallback).toMatchObject({
      prevModel: "gpt-5.4",
      prevProvider: "openai",
      prevThinkingLevel: "off",
      ts: 1,
      source: "agent-patch",
    });
    expect(input).toEqual(before);
    const load = unavailableCatalog();
    const clear = fixture({ entry: changed, loadGatewayModelCatalogSnapshot: load });
    const clearInput = clear.store[KEY];
    const beforeClear = structuredClone(clearInput);
    const cleared = await clear.ok({ thinkingLevel: null });
    expect(cleared.thinkingLevel).toBeUndefined();
    expect(cleared.modelFallback?.prevThinkingLevel).toBeUndefined();
    expect(cleared.modelFallback?.prevModel).toBe("gpt-5.4");
    expect(clearInput).toEqual(beforeClear);
    expect(load).not.toHaveBeenCalled();
  });

  test("clears context rollback metadata without loading a catalog or mutating the input", async () => {
    const load = unavailableCatalog();
    const f = fixture({
      entry: {
        thinkingLevel: "high",
        contextWindow: "extended",
        modelFallback: {
          prevModel: "gpt-5.4",
          prevProvider: "openai",
          prevThinkingLevel: "high",
          prevContextWindow: "extended",
          ts: 1,
          source: "agent-patch",
        },
      },
      loadGatewayModelCatalogSnapshot: load,
    });
    const input = f.store[KEY];
    const before = structuredClone(input);
    const entry = await f.ok({ contextWindow: null });
    expect(entry.contextWindow).toBeUndefined();
    expect(entry.modelFallback?.prevContextWindow).toBeUndefined();
    expect(entry.modelFallback?.prevThinkingLevel).toBe("high");
    expect(input).toEqual(before);
    expect(load).not.toHaveBeenCalled();
  });

  test("pins a concrete model even when it equals the configured default", async () => {
    const entry = await fixture({
      cfg: { agents: { defaults: { model: { primary: GPT } } } },
      catalog: catalog(GPT),
    }).ok({ model: GPT });
    expect(entry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    expect(entry.authProfileOverride).toBeUndefined();
  });

  test("resets pending live model switches without loading the catalog", async () => {
    const load = unavailableCatalog();
    const entry = await modelFixture({
      entry: {
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        modelOverrideSource: "user",
        liveModelSwitchPending: true,
      },
      loadGatewayModelCatalogSnapshot: load,
    }).ok({ model: null });
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.modelOverrideSource).toBe("default");
    expect(entry.liveModelSwitchPending).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    "revalidates retained context on model reset (supported=%s)",
    async (supported) => {
      const entries = [
        {
          ...catalogEntry(SONNET),
          reasoning: true,
          contextWindows: supported
            ? [{ id: "extended", label: "Extended", contextWindow: 200_000 }]
            : [],
        },
      ];
      const load = vi.fn(async () => ({ entries, routeVariants: entries }));
      const entry = await fixture({
        cfg: { agents: { defaults: { model: SONNET } } },
        entry: {
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          thinkingLevel: "high",
          contextWindow: "extended",
        },
        loadGatewayModelCatalogSnapshot: load,
      }).ok({ model: null });
      expect(entry.providerOverride).toBeUndefined();
      expect(entry.modelOverride).toBeUndefined();
      expect(entry.thinkingLevel).toBe("high");
      expect(entry.contextWindow).toBe(supported ? "extended" : undefined);
      expect(load).toHaveBeenCalledOnce();
    },
  );

  test("uses one catalog for a combined model, thinking, and context patch", async () => {
    const entries = [
      {
        ...catalogEntry(SONNET),
        reasoning: true,
        contextWindows: [{ id: "extended", label: "Extended", contextWindow: 200_000 }],
      },
    ];
    const load = vi.fn(async () => ({ entries, routeVariants: entries }));
    const entry = await modelFixture({ entry: {}, loadGatewayModelCatalogSnapshot: load }).ok({
      model: SONNET,
      thinkingLevel: "high",
      contextWindow: "extended",
    });
    expect(entry).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      thinkingLevel: "high",
      contextWindow: "extended",
    });
    expect(load).toHaveBeenCalledOnce();
  });

  test.each([
    { patch: { category: "" }, message: "invalid category" },
    { patch: { model: "" }, message: "invalid model: empty" },
  ])("validates before catalog preparation: $message", async ({ patch, message }) => {
    const load = unavailableCatalog();
    await fixture({ entry: { label: "Original" }, loadGatewayModelCatalogSnapshot: load }).rejects(
      { contextWindow: "extended", ...patch },
      message,
    );
    expect(load).not.toHaveBeenCalled();
  });

  test("allows uncataloged models when the selected agent has an unrestricted policy", async () => {
    const entry = await fixture({
      key: "global",
      catalog: [],
      cfg: {
        agents: {
          defaults: { model: "synthetic/primary", modelPolicy: { allow: ["synthetic/primary"] } },
          entries: { main: { modelPolicy: { allow: [] } } },
        },
      },
    }).ok({ model: "synthetic/uncataloged" });
    expect(entry).toMatchObject({
      providerOverride: "synthetic",
      modelOverride: "uncataloged",
      modelOverrideSource: "user",
    });
  });

  test("enforces default-agent policy for an unqualified key", async () => {
    await fixture({
      key: "global",
      entry: { label: "Original" },
      cfg: {
        agents: {
          defaults: { model: "synthetic/primary", modelPolicy: { allow: [] } },
          entries: { main: { modelPolicy: { allow: ["synthetic/allowed"] } } },
        },
      },
      catalog: catalog("synthetic/allowed", "synthetic/outside"),
    }).rejects(
      { model: "synthetic/outside", label: "Changed" },
      "model not allowed: synthetic/outside",
    );
  });

  test.each(["placeholder", "existing"] as const)(
    "validates context-window initialization and switch state for %s sessions",
    async (state) => {
      const f = fixture({
        cfg: { agents: { defaults: { model: "claude-cli/claude-fable-5" } } },
        entry: {
          sessionId: state === "existing" ? "sess" : undefined,
          contextBudgetStatus: contextBudgetStatusFixture(),
        },
        catalog: [
          {
            ...catalogEntry("claude-cli/claude-fable-5"),
            contextWindow: 1_000_000,
            contextWindows: [
              { id: "200k", label: "200K", contextWindow: 200_000 },
              { id: "1m", label: "1M", contextWindow: 1_000_000 },
            ],
            contextWindowDefault: "1m",
          },
        ],
      });
      const entry = await f.ok({ contextWindow: "200k" });
      expect(entry.contextWindow).toBe("200k");
      expect(entry.contextBudgetStatus).toBeUndefined();
      expect(entry.liveModelSwitchPending).toBe(state === "existing" ? true : undefined);
      await f.rejects({ contextWindow: "2m" }, 'contextWindow "2m" is not supported');
    },
  );

  test("rejects thinking allowed by the host but forbidden by the selected runtime", async () => {
    const host: ModelCatalogEntry = {
      provider: "runtime-fixture",
      id: "reasoner",
      name: "Reasoner",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["max"] },
    };
    const native: ModelCatalogEntry = {
      ...host,
      nativeRuntime: "fixture-native",
      compat: { supportedReasoningEfforts: ["high"] },
    };
    const f = fixture({
      cfg: { agents: { defaults: { model: "runtime-fixture/reasoner" } } },
      entry: {},
      preparedAgentRuntime: "fixture-native",
      loadGatewayModelCatalogSnapshot: async () => ({
        entries: [host],
        routeVariants: [host, native],
      }),
    });
    await f.rejects({ thinkingLevel: "max" }, 'thinkingLevel "max" is not supported');
  });

  test("uses the explicitly selected agent's thinking policy for global patches without a catalog", async () => {
    const entry = await fixture({
      key: "global",
      agentId: "work",
      catalog: [],
      cfg: {
        agents: {
          defaults: { model: "gmn/gpt-5.4" },
          entries: { work: { model: "openai/gpt-5.5" } },
        },
      },
    }).ok({ thinkingLevel: "xhigh" });
    expect(entry.thinkingLevel).toBe("xhigh");
  });

  test("preserves stored Ultra when a model patch selects Codex Luna", async () => {
    const entry = await fixture({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.6-sol",
            models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } },
          },
        },
      },
      entry: { thinkingLevel: "ultra" },
      catalog: catalog("openai/gpt-5.6-sol", "openai/gpt-5.6-luna"),
    }).ok({ model: "openai/gpt-5.6-luna" });
    expect(entry.thinkingLevel).toBe("ultra");
  });

  test("honors an explicit OpenClaw runtime pin for Luna Ultra", async () => {
    const entry = await fixture({
      cfg: { agents: { defaults: { model: "openai/gpt-5.6-luna" } } },
      entry: { agentRuntimeOverride: "openclaw", agentHarnessId: "codex" },
      catalog: [],
    }).ok({ thinkingLevel: "ultra" });
    expect(entry.thinkingLevel).toBe("ultra");
  });

  test("clears runtime pins without losing supported thinking and invalidates derived context", async () => {
    const entry = await fixture({
      cfg: { agents: { defaults: { model: "openai/gpt-5.6-luna" } } },
      entry: { agentRuntimeOverride: "openclaw", thinkingLevel: "ultra", contextTokens: 1000 },
      catalog: catalog("openai/gpt-5.6-luna"),
    }).ok({ agentRuntime: null });
    expect(entry).toMatchObject({ thinkingLevel: "ultra", liveModelSwitchPending: true });
    expect(entry).not.toHaveProperty("agentRuntimeOverride");
    expect(entry).not.toHaveProperty("contextTokens");
  });

  test("rejects runtime pins on ACP-owned sessions", async () => {
    acpSessionMetaMocks.readAcpSessionMetaForEntry.mockReturnValue({
      backend: "codex",
      agent: "main",
      state: "idle",
    });
    await fixture({ entry: {} }).rejects({ agentRuntime: null }, "owned by this ACP session");
  });

  test("uses ACP backend metadata on canonical agent keys for thinking validation", async () => {
    acpSessionMetaMocks.readAcpSessionMetaForEntry.mockReturnValue({
      backend: "codex",
      agent: "main",
      runtimeSessionName: KEY,
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    });
    const f = fixture({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.6-luna",
            models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      entry: {},
      catalog: [],
    });
    await f.rejects({ thinkingLevel: "xhigh" }, 'thinkingLevel "xhigh" is not supported');
    expect(acpSessionMetaMocks.readAcpSessionMetaForEntry).toHaveBeenCalledWith({
      sessionKey: KEY,
      agentId: "main",
      entry: expect.objectContaining({ sessionId: "sess" }),
    });
  });

  test("preserves incompatible stored thinking without loading a catalog for unrelated edits", async () => {
    const entries = [{ ...catalogEntry("synthetic/plain"), reasoning: false }];
    const load = vi.fn(async () => ({ entries, routeVariants: entries }));
    const entry = await fixture({
      cfg: { agents: { defaults: { model: "synthetic/plain" } } },
      entry: { thinkingLevel: "max" },
      loadGatewayModelCatalogSnapshot: load,
    }).ok({ label: "new label" });
    expect(entry).toMatchObject({ label: "new label", thinkingLevel: "max" });
    expect(load).not.toHaveBeenCalled();
  });

  test("sets an immutable completion owner for ACP sessions", async () => {
    const f = fixture({ key: "agent:main:acp:child" });
    expect((await f.ok({ completionOwnerSessionKey: KEY })).completionOwnerSessionKey).toBe(KEY);
    await f.rejects(
      { completionOwnerSessionKey: "agent:main:discord:direct:bob" },
      "completionOwnerSessionKey cannot be changed once set",
    );
  });

  test("sets an immutable requester policy version only for child sessions", async () => {
    const f = fixture({ key: "agent:main:acp:child" });
    expect((await f.ok({ inheritedToolPolicyVersion: 1 })).inheritedToolPolicyVersion).toBe(1);
    await f.rejects(
      { inheritedToolPolicyVersion: null },
      "inheritedToolPolicyVersion cannot be cleared once set",
    );
    await fixture().rejects(
      { inheritedToolPolicyVersion: 1 },
      "inheritedToolPolicyVersion is only supported",
    );
  });

  test("normalizes inherited denies without truncating large policy lists, only for child sessions", async () => {
    const configured = Array.from({ length: 150 }, (_, i) => "custom_" + i);
    const entry = await fixture({ key: "agent:main:subagent:child" }).ok({
      inheritedToolDeny: [...configured, "bash", "bash"],
    });
    expect(entry.inheritedToolDeny).toEqual([...configured, "exec"]);
    expect(entry.inheritedToolDeny).toHaveLength(151);
    expect(entry.inheritedToolDeny?.at(-1)).toBe("exec");
    await fixture().rejects({ inheritedToolDeny: ["exec"] }, "inheritedToolDeny is only supported");
  });

  test("normalizes inherited allowlists only for child sessions", async () => {
    const entry = await fixture({ key: "agent:main:acp:child" }).ok({
      inheritedToolAllow: ["sessions_spawn", "read", "sessions_spawn"],
    });
    expect(entry.inheritedToolAllow).toEqual(["sessions_spawn", "read"]);
    await fixture().rejects(
      { inheritedToolAllow: ["read"] },
      "inheritedToolAllow is only supported",
    );
  });

  test("normalizes exec/send/group patches", async () => {
    const entry = await fixture().ok({
      execHost: " AUTO ",
      execNode: " worker-1 ",
      sendPolicy: "DENY" as unknown as "allow",
      groupActivation: "Always" as unknown as "mention",
    });
    expect(entry).toMatchObject({
      execHost: "auto",
      execNode: "worker-1",
      sendPolicy: "deny",
      groupActivation: "always",
    });
  });

  test("stores and clears permission mode without losing the recorded root", async () => {
    const f = fixture({ entry: { sessionRoot: "/workspace/project" } });
    expect(await f.ok({ permissionMode: "workspace" })).toMatchObject({
      permissionMode: "workspace",
      sessionRoot: "/workspace/project",
    });
    const cleared = await f.ok({ permissionMode: null });
    expect(cleared.permissionMode).toBeUndefined();
    expect(cleared.sessionRoot).toBe("/workspace/project");
  });

  test.each([{ execSecurity: null }, { execAsk: "always" }])(
    "rejects retired policy fields without writing: %j",
    async (retiredPatch) => {
      for (const entry of [
        undefined,
        { label: "Original", permissionMode: "read-only" as const },
      ]) {
        const f = fixture({ entry });
        const before = structuredClone(f.store);
        expect(
          await f.patch({ label: "Changed", permissionMode: "guarded", ...retiredPatch }),
        ).toMatchObject({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message:
              "execSecurity/execAsk are retired; set permissionMode (read-only|guarded|workspace|full) instead, or use /exec for this run only.",
          },
        });
        expect(f.store).toEqual(before);
      }
    },
  );

  test("clears node cwd when changing or clearing the node binding", async () => {
    const f = fixture({
      entry: { execHost: "node", execNode: "worker-1", execCwd: "/workspace/on-worker-1" },
    });
    const changed = await f.ok({ execNode: "worker-2" });
    expect(changed).toMatchObject({ execNode: "worker-2", execHost: "node" });
    expect(changed.execCwd).toBeUndefined();
    f.store[KEY].execCwd = "/workspace/on-worker-2";
    const cleared = await f.ok({ execNode: null });
    expect(cleared.execNode).toBeUndefined();
    expect(cleared.execCwd).toBeUndefined();
    expect(cleared.execHost).toBeUndefined();
  });

  test("preserves gateway hosting when clearing a stale node binding", async () => {
    const cleared = await fixture({
      entry: { execHost: "gateway", execNode: "worker-1", execCwd: "/workspace/on-worker-1" },
    }).ok({ execNode: null });
    expect(cleared.execHost).toBe("gateway");
    expect(cleared.execNode).toBeUndefined();
    expect(cleared.execCwd).toBeUndefined();
  });

  test.each([
    { patch: { execHost: "edge" }, message: "invalid execHost" },
    { patch: { sendPolicy: "ask" as unknown as "allow" }, message: "invalid sendPolicy" },
    {
      patch: { groupActivation: "never" as unknown as "mention" },
      message: "invalid groupActivation",
    },
  ])("rejects invalid execution preferences: $message", async ({ patch, message }) => {
    await fixture().rejects(patch, message);
  });

  test.each([false, true])(
    "requires manual permission for configured subagent models (allowed=%s)",
    async (allowed) => {
      const model = "synthetic/hf:moonshotai/Kimi-K2.7-Code";
      const f = fixture({
        key: "agent:kimi:subagent:child",
        entry: { delivery: { kind: "none" } },
        cfg: {
          agents: {
            defaults: { model: SONNET, modelPolicy: { allow: [SONNET] } },
            entries: { kimi: { model, ...(allowed ? { modelPolicy: { allow: [model] } } : {}) } },
          },
        },
        catalog: catalog(SONNET, model),
      });
      if (allowed) {
        expect(await f.ok({ model })).toMatchObject({
          providerOverride: "synthetic",
          modelOverride: "hf:moonshotai/Kimi-K2.7-Code",
          modelOverrideSource: "user",
        });
      } else {
        await f.rejects({ model }, "model not allowed");
      }
    },
  );

  test("marks same-model profile changes as pending live switches", async () => {
    const entry = await modelFixture({
      entry: {
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        authProfileOverride: "oldprofile",
        authProfileOverrideSource: "user",
      },
    }).ok({ model: SONNET + "@newprofile" });
    expect(entry).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      authProfileOverride: "newprofile",
      authProfileOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  test("resolves bare model ids before persisting profile suffixes on fresh sessions", async () => {
    const entry = await fixture({
      cfg: { agents: { defaults: { model: GPT, models: { "opencode-go/kimi-k2.6": {} } } } },
      catalog: catalog(GPT, "opencode-go/kimi-k2.6"),
    }).ok({ model: "kimi-k2.6@work" });
    expect(entry).toMatchObject({
      providerOverride: "opencode-go",
      modelOverride: "kimi-k2.6",
      authProfileOverride: "work",
    });
    expect(entry.liveModelSwitchPending).toBeUndefined();
  });
});
