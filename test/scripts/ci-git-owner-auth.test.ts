import { expect, it } from "vitest";
import { runAuthFixture } from "./ci-checkout-auth.test-support.js";

it.skipIf(process.platform === "win32").each(["fetch-only", "checkout"])(
  "keeps checkout HTTP authentication transient and scoped (%s)",
  async (mode) => {
    expect(await runAuthFixture(mode)).toMatchObject({
      mode,
      fetchAuthenticated: true,
      missingBlobBeforeCheckout: true,
      lazyCheckoutSucceeded: mode === "checkout",
      credentialPersisted: false,
    });
  },
  50_000,
);
