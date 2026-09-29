import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import { loadSelectedProviderAccountCatalog } from "../src/agents/models-config.providers.catalog-context.js";
import { fetchWithSsrFGuard } from "../src/infra/net/fetch-guard.js";
import { clearLiveCatalogCacheForTests } from "../src/plugin-sdk/provider-catalog-shared.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { createDeferred } from "./helpers/promise.js";

const transport = vi.hoisted(() => ({
  endpoint: "",
  preflight: vi.fn<() => Promise<void>>(),
  resolveAuth: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: transport.resolveAuth,
  resolveProviderAuthProfileMetadata: () => ({ accountId: "synthetic-account" }),
}));

// Only the destination and DNS fixture change. Acquisition, guarded fetch,
// dispatcher preparation, redirects, and the physical HTTP request stay real.
vi.mock("../src/plugin-sdk/ssrf-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugin-sdk/ssrf-runtime.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        url: transport.endpoint,
        capture: false,
        policy: { allowPrivateNetwork: true },
        lookupFn: async () => {
          await transport.preflight();
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }),
  };
});

const profileId =
  "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const credential = { provider: "openai", type: "token", token: "synthetic-account-token" } as const;
const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
let server: Awaited<ReturnType<typeof reserveTestPortListener>>;
let generationCurrent = true;
let principal = "owner";
let authorized = true;

function assertCurrent() {
  if (!authorized || principal !== "owner") {
    throw new Error("Selected personal account authority revoked");
  }
}

function load() {
  return loadSelectedProviderAccountCatalog({
    provider: buildOpenAIProvider(),
    providerId: "openai",
    profileId,
    authStore: { version: 1, profiles: { [profileId]: credential } },
    config: {},
    agentDir: "/unused/catalog-authority-agent",
    workspaceDir: "/unused/catalog-authority-workspace",
    isCurrent: () => generationCurrent,
    assertCurrent,
  });
}

beforeAll(async () => {
  server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requests.push({ path: request.url, authorization: request.headers.authorization });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ models: [{ slug: "gpt-5.4", visibility: "list" }] }));
      }),
  });
  transport.endpoint = "http://catalog-authority.test:" + server.claim.port + "/models";
});
afterAll(async () => {
  await server.releaseListener();
  await server.claim.release();
});
beforeEach(() => {
  clearLiveCatalogCacheForTests();
  requests.length = 0;
  generationCurrent = true;
  principal = "owner";
  authorized = true;
  transport.preflight.mockReset().mockResolvedValue(undefined);
  transport.resolveAuth.mockReset().mockResolvedValue({
    apiKey: credential.token,
    mode: "token",
    profileId,
  });
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("selected account catalog physical dispatch", () => {
  it("sends one authorized credentialed request through the production HTTP owner", async () => {
    const outcomes = await load();
    expect(outcomes).toMatchObject([{ provider: "openai", profileId, status: "ready" }]);
    expect(requests).toEqual([
      { path: "/models", authorization: "Bearer synthetic-account-token" },
    ]);
  });

  it("rejects a foreign principal before resolving auth or sending HTTP", async () => {
    principal = "foreign";
    await expect(load()).rejects.toThrow("authority revoked");
    expect(transport.resolveAuth).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it.each(["auth", "transport"])(
    "sends zero requests when revoked during deferred %s",
    async (boundary) => {
      const entered = createDeferred();
      const release = createDeferred();
      if (boundary === "auth") {
        transport.resolveAuth.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { apiKey: credential.token, mode: "token", profileId };
        });
      } else {
        transport.preflight.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
        });
      }
      const result = load();
      const settled = result.catch((error: unknown) => error);
      await entered.promise;
      authorized = false;
      release.resolve();
      await settled;
      expect(requests).toEqual([]);
      await expect(result).rejects.toThrow("authority revoked");
    },
  );

  it("sends zero requests when the prepared generation closes during DNS", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    transport.preflight.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const result = load();
    const settled = result.catch((error: unknown) => error);
    await entered.promise;
    generationCurrent = false;
    release.resolve();
    await settled;
    expect(requests).toEqual([]);
  });

  it("does not revoke unrelated ambient discovery", async () => {
    authorized = false;
    const result = await fetchWithSsrFGuard({
      url: "http://127.0.0.1:" + server.claim.port + "/ambient",
      policy: { allowPrivateNetwork: true },
      capture: false,
    });
    await result.release();
    expect(requests).toEqual([{ path: "/ambient", authorization: undefined }]);
  });
});
