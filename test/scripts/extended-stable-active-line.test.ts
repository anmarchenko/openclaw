import { describe, expect, it } from "vitest";
import { validateActiveExtendedStableLine } from "../../scripts/openclaw-npm-extended-stable-release.mjs";

describe("extended-stable live publication eligibility", () => {
  it("keeps both trailing months eligible across the year boundary", () => {
    expect(() => validateActiveExtendedStableLine("2026.12.34", "2027.1.1")).not.toThrow();
    expect(() => validateActiveExtendedStableLine("2026.12.34", "2027.2.1")).not.toThrow();
    expect(() => validateActiveExtendedStableLine("2026.12.34", "2027.3.1")).toThrow(
      "only the two trailing completed months",
    );
  });
});
