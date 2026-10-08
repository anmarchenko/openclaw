import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, resolveBaselines } from "../../scripts/resolve-upgrade-survivor-baselines.mts";

function withReleaseFixture<T>(releases: unknown[], fn: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-upgrade-baselines-"));
  try {
    const file = path.join(dir, "releases.json");
    writeFileSync(file, `${JSON.stringify(releases)}\n`);
    return fn(file);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function withJsonFixture<T>(name: string, contents: unknown, fn: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-upgrade-baselines-"));
  try {
    const file = path.join(dir, name);
    writeFileSync(file, `${JSON.stringify(contents)}\n`);
    return fn(file);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("scripts/resolve-upgrade-survivor-baselines", () => {
  it("rejects short flag values before resolving baselines", () => {
    expect(() => parseArgs(["--fallback", "-h"])).toThrow("missing value for --fallback");
    expect(() => parseArgs(["--github-output", "-h"])).toThrow("missing value for --github-output");
  });

  it("keeps the single fallback baseline when no expanded request is provided", () => {
    expect(resolveBaselines(new Map([["fallback", "2026.6.1"]]))).toEqual(["openclaw@2026.6.1"]);
  });

  it.each([
    ["requested", "2026.5.31"],
    ["fallback", "openclaw@2026.5.31-beta.1"],
    ["requested", "all-since-2026.5.31"],
  ])("rejects a pre-June %s baseline before scheduling (%s)", (key, value) => {
    expect(() => resolveBaselines(new Map([[key, value]]))).toThrow(
      "Upgrade pre-June installs through OpenClaw 2026.9.5 and run Doctor first",
    );
  });

  it.each([
    { extended: undefined, expected: ["2026.9.2", "2026.9.1", "2026.6.34"] },
    { extended: "2026.6.35", expected: ["2026.9.2", "2026.9.1", "2026.6.35", "2026.6.34"] },
    { extended: "2026.6.34", expected: ["2026.9.2", "2026.9.1", "2026.6.34"] },
  ])(
    "resolves supported npm lines with optional/deduplicated extended-stable ($extended)",
    ({ extended, expected }) => {
      withJsonFixture(
        "tags.json",
        { latest: "2026.9.2", ...(extended ? { "extended-stable": extended } : {}) },
        (tagsFile) => {
          withJsonFixture(
            "versions.json",
            ["2026.6.34", "2026.6.35", "2026.9.1", "2026.9.2", "2026.9.3-beta.1", "2026.9.3"],
            (versionsFile) => {
              expect(
                resolveBaselines(
                  new Map([
                    ["requested", "supported-lines"],
                    ["npm-dist-tags-json", tagsFile],
                    ["npm-versions-json", versionsFile],
                  ]),
                ),
              ).toEqual(expected.map((version) => `openclaw@${version}`));
            },
          );
        },
      );
    },
  );

  it("omits the unpublished candidate version from expanded supported lines", () => {
    withJsonFixture("tags.json", { latest: "2026.9.3" }, (tagsFile) => {
      withJsonFixture("versions.json", ["2026.6.34", "2026.9.2", "2026.9.3"], (versionsFile) => {
        expect(
          resolveBaselines(
            new Map([
              ["requested", "supported-lines"],
              ["candidate-version", "2026.9.3"],
              ["candidate-published", "false"],
              ["npm-dist-tags-json", tagsFile],
              ["npm-versions-json", versionsFile],
            ]),
          ),
        ).toEqual(["openclaw@2026.9.2", "openclaw@2026.6.34"]);
      });
    });
  });

  it.each([
    {
      tags: {},
      versions: ["2026.6.34", "2026.9.2"],
      error: "npm latest must name a published stable version",
    },
    {
      tags: { latest: "2026.9.2", "extended-stable": "2026.6.99" },
      versions: ["2026.6.34", "2026.9.1", "2026.9.2"],
      error: "npm extended-stable must name a published extended-stable version",
    },
    ...["2026.9.1", "2026.6.35-1", "2026.6.35-beta.1"].map((extended) => ({
      tags: { latest: "2026.9.2", "extended-stable": extended },
      versions: ["2026.6.34", "2026.9.1", "2026.9.2", extended],
      error: "npm extended-stable must name a published extended-stable version",
    })),
    {
      tags: { latest: "2026.9.2" },
      versions: ["2026.9.1", "2026.9.2"],
      error: "oldest supported baseline is not published",
    },
  ])("fails closed on unusable supported-line metadata ($error)", ({ tags, versions, error }) => {
    withJsonFixture("tags.json", tags, (tagsFile) => {
      withJsonFixture("versions.json", versions, (versionsFile) => {
        expect(() =>
          resolveBaselines(
            new Map([
              ["requested", "supported-lines"],
              ["npm-dist-tags-json", tagsFile],
              ["npm-versions-json", versionsFile],
            ]),
          ),
        ).toThrow(error);
      });
    });
  });

  it("resolves release-history to the last six supported stable releases", () => {
    const releases = (
      [
        ["v2026.6.6", "2026-06-07T00:00:00Z"],
        ["v2026.6.5", "2026-06-06T00:00:00Z"],
        ["v2026.6.4", "2026-06-05T00:00:00Z"],
        ["v2026.6.3", "2026-06-04T00:00:00Z"],
        ["v2026.6.2", "2026-06-03T00:00:00Z"],
        ["v2026.6.1", "2026-06-02T00:00:00Z"],
        ["v2026.4.23", "2026-04-22T00:00:00Z"],
        ["v2026.3.13-1", "2026-03-14T18:04:00Z"],
        ["v2026.3.12", "2026-03-12T00:00:00Z"],
        ["v2026.6.7-beta.1", "2026-06-08T00:00:00Z", true],
      ] as const
    ).map(([tagName, publishedAt, isPrerelease = false]) => ({
      isPrerelease,
      publishedAt,
      tagName,
    }));

    withReleaseFixture(releases, (file) => {
      expect(
        resolveBaselines(
          new Map([
            ["requested", "release-history 2026.6.6"],
            ["releases-json", file],
          ]),
        ),
      ).toEqual([
        "openclaw@2026.6.6",
        "openclaw@2026.6.5",
        "openclaw@2026.6.4",
        "openclaw@2026.6.3",
        "openclaw@2026.6.2",
        "openclaw@2026.6.1",
      ]);
    });
  });

  it("preserves the release-history count when the unpublished candidate is newest", () => {
    const releases = ["2026.9.4", "2026.9.3", "2026.9.2", "2026.9.1", "2026.8.30"].map(
      (version, index) => ({
        isPrerelease: false,
        publishedAt: `2026-09-${String(5 - index).padStart(2, "0")}T00:00:00Z`,
        tagName: `v${version}`,
      }),
    );

    withReleaseFixture(releases, (file) => {
      expect(
        resolveBaselines(
          new Map([
            ["requested", "release-history"],
            ["candidate-version", "2026.9.4"],
            ["candidate-published", "false"],
            ["releases-json", file],
            ["history-count", "4"],
          ]),
        ),
      ).toEqual([
        "openclaw@2026.9.3",
        "openclaw@2026.9.2",
        "openclaw@2026.9.1",
        "openclaw@2026.8.30",
      ]);
    });
  });

  it("resolves all-since baselines to every stable published release at or after the requested version", () => {
    const releases = (
      [
        ["v2026.6.5", "2026-06-05T00:00:00Z"],
        ["v2026.6.4", "2026-06-04T00:00:00Z"],
        ["v2026.6.3", "2026-06-03T00:00:00Z"],
        ["v2026.6.2", "2026-06-02T00:00:00Z"],
        ["v2026.6.1", "2026-06-01T00:00:00Z"],
        ["v2026.6.6-beta.1", "2026-06-06T00:00:00Z", true],
      ] as const
    ).map(([tagName, publishedAt, isPrerelease = false]) => ({
      isPrerelease,
      publishedAt,
      tagName,
    }));

    withReleaseFixture(releases, (releasesFile) => {
      withJsonFixture(
        "versions.json",
        ["2026.6.5", "2026.6.4", "2026.6.3", "2026.6.2", "2026.6.1"],
        (versionsFile) => {
          expect(
            resolveBaselines(
              new Map([
                ["requested", "all-since-2026.6.2"],
                ["releases-json", releasesFile],
                ["npm-versions-json", versionsFile],
              ]),
            ),
          ).toEqual([
            "openclaw@2026.6.5",
            "openclaw@2026.6.4",
            "openclaw@2026.6.3",
            "openclaw@2026.6.2",
          ]);
        },
      );
    });
  });

  it("resolves last-stable baselines to the latest stable published package versions", () => {
    const releases = (
      [
        ["v2026.7.4-beta.1", "2026-07-05T00:00:00Z", true],
        ["v2026.7.3-1", "2026-07-04T00:00:00Z"],
        ["v2026.7.3", "2026-07-03T00:00:00Z"],
        ["v2026.7.2", "2026-07-02T00:00:00Z"],
        ["v2026.6.29", "2026-06-30T00:00:00Z"],
        ["v2026.6.27", "2026-06-28T00:00:00Z"],
        ["v2026.6.15", "2026-06-16T00:00:00Z"],
      ] as const
    ).map(([tagName, publishedAt, isPrerelease = false]) => ({
      isPrerelease,
      publishedAt,
      tagName,
    }));

    withReleaseFixture(releases, (releasesFile) => {
      withJsonFixture(
        "versions.json",
        ["2026.7.3-1", "2026.7.3", "2026.7.2", "2026.6.29", "2026.6.27", "2026.6.15"],
        (versionsFile) => {
          expect(
            resolveBaselines(
              new Map([
                ["requested", "last-stable-4 2026.6.23 2026.7.2 2026.6.15"],
                ["releases-json", releasesFile],
                ["npm-versions-json", versionsFile],
              ]),
            ),
          ).toEqual([
            "openclaw@2026.7.3-1",
            "openclaw@2026.7.3",
            "openclaw@2026.7.2",
            "openclaw@2026.6.29",
            "openclaw@2026.6.23",
            "openclaw@2026.6.15",
          ]);
        },
      );
    });
  });

  it("excludes extended-stable GitHub releases from regular stable baselines", () => {
    const releases = [
      {
        isPrerelease: false,
        publishedAt: "2026-08-02T00:00:00Z",
        tagName: "v2026.6.34",
      },
      {
        isPrerelease: false,
        publishedAt: "2026-08-01T00:00:00Z",
        tagName: "v2026.7.12",
      },
    ];

    withReleaseFixture(releases, (file) => {
      expect(
        resolveBaselines(
          new Map([
            ["requested", "last-stable-1"],
            ["releases-json", file],
          ]),
        ),
      ).toEqual(["openclaw@2026.7.12"]);
    });
  });

  it("preserves the last-stable count when the unpublished candidate is newest", () => {
    const releases = ["2026.9.4", "2026.9.3", "2026.9.2", "2026.9.1", "2026.8.30"].map(
      (version, index) => ({
        isPrerelease: false,
        publishedAt: `2026-09-${String(5 - index).padStart(2, "0")}T00:00:00Z`,
        tagName: `v${version}`,
      }),
    );

    withReleaseFixture(releases, (releasesFile) => {
      withJsonFixture(
        "versions.json",
        ["2026.8.30", "2026.9.1", "2026.9.2", "2026.9.3", "2026.9.4"],
        (versionsFile) => {
          expect(
            resolveBaselines(
              new Map([
                ["requested", "last-stable-4"],
                ["candidate-version", "2026.9.4"],
                ["candidate-published", "false"],
                ["releases-json", releasesFile],
                ["npm-versions-json", versionsFile],
              ]),
            ),
          ).toEqual([
            "openclaw@2026.9.3",
            "openclaw@2026.9.2",
            "openclaw@2026.9.1",
            "openclaw@2026.8.30",
          ]);
        },
      );
    });
  });

  it("rejects loose release-history count values", () => {
    withReleaseFixture([], (file) => {
      expect(() =>
        resolveBaselines(
          new Map([
            ["requested", "release-history"],
            ["releases-json", file],
            ["history-count", "1e3"],
          ]),
        ),
      ).toThrow("--history-count must be a positive integer");
    });
  });

  it("rejects loose last-stable count tokens", () => {
    withReleaseFixture([], (file) => {
      expect(() =>
        resolveBaselines(
          new Map([
            ["requested", "last-stable-1e3"],
            ["releases-json", file],
          ]),
        ),
      ).toThrow("last-stable baseline count must be a positive integer");
    });
  });

  it("rejects unsafe all-since version tokens", () => {
    withReleaseFixture([], (file) => {
      expect(() =>
        resolveBaselines(
          new Map([
            ["requested", "all-since-2026.6.9007199254740993"],
            ["releases-json", file],
          ]),
        ),
      ).toThrow("invalid all-since baseline token: all-since-2026.6.9007199254740993");
    });
  });

  it("ignores unsafe stable release tags from release history", () => {
    const releases = [
      {
        isPrerelease: false,
        publishedAt: "2026-07-01T00:00:00Z",
        tagName: "v2026.6.9007199254740993",
      },
      { isPrerelease: false, publishedAt: "2026-06-30T00:00:00Z", tagName: "v2026.6.29" },
      { isPrerelease: false, publishedAt: "2026-05-31T00:00:00Z", tagName: "v2026.5.31" },
    ];

    withReleaseFixture(releases, (file) => {
      expect(
        resolveBaselines(
          new Map([
            ["requested", "release-history"],
            ["releases-json", file],
            ["history-count", "2"],
          ]),
        ),
      ).toEqual(["openclaw@2026.6.29"]);
    });
  });

  it("maps release tags with republish suffixes to npm-published package versions", () => {
    const releases = (
      [
        ["v2026.6.3-1", "2026-06-04T00:00:00Z"],
        ["v2026.6.2", "2026-06-03T00:00:00Z"],
      ] as const
    ).map(([tagName, publishedAt]) => ({
      isPrerelease: false,
      publishedAt,
      tagName,
    }));

    withReleaseFixture(releases, (releasesFile) => {
      withJsonFixture("versions.json", ["2026.6.3", "2026.6.2"], (versionsFile) => {
        expect(
          resolveBaselines(
            new Map([
              ["requested", "release-history"],
              ["releases-json", releasesFile],
              ["npm-versions-json", versionsFile],
            ]),
          ),
        ).toEqual(["openclaw@2026.6.3", "openclaw@2026.6.2"]);
      });
    });
  });
});
