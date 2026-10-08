import { describe, expect, it, vi } from "vitest";
import { addLabelsWithinCap } from "../../scripts/github/labeler-label-cap.mjs";

describe("label cap tolerance", () => {
  it("reports whether the label landed so callers keep their bookkeeping accurate", async () => {
    const capError = Object.assign(
      new Error("Validation Failed: Issues cannot have more than 100 labels"),
      { status: 422 },
    );
    const core = { warning: vi.fn() };
    const addLabels = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(capError);
    const github = { rest: { issues: { addLabels } } };
    const request = { github, core, owner: "openclaw", repo: "openclaw", issueNumber: 7 };

    await expect(addLabelsWithinCap({ ...request, labels: ["maintainer"] })).resolves.toBe(true);
    expect(core.warning).not.toHaveBeenCalled();
    await expect(addLabelsWithinCap({ ...request, labels: ["beta-blocker"] })).resolves.toBe(false);
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/"beta-blocker" on #7/));
  });
});
