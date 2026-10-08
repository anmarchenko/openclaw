import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateBundledPackageDependencyAlignment } from "../../scripts/package-source-dependencies.mjs";
import {
  validatePackageSource,
  validatePackageSourceDir,
  validatePackageSourceRef,
} from "../../scripts/package-source-preflight.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const changelog = `# Changelog

## Unreleased

- Package source preflight notes with enough detail.
`;

function rootManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "openclaw",
    version: "2026.8.1",
    dependencies: {
      "@openclaw/ai": "workspace:*",
      openai: "6.49.0",
    },
    ...overrides,
  });
}

function aiManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "@openclaw/ai",
    version: "2026.8.1",
    dependencies: {
      openai: "6.49.0",
    },
    ...overrides,
  });
}

describe("package source preflight", () => {
  it("validates selected split notes instead of accepting an index as package contents", () => {
    const root = tempDirs.make("openclaw-package-source-split-");
    mkdirSync(path.join(root, "CHANGELOG"));
    writeFileSync(path.join(root, "package.json"), rootManifest({ dependencies: {} }));
    writeFileSync(
      path.join(root, "CHANGELOG.md"),
      "# Changelog\n\n- [Release](CHANGELOG/2026.8.1.md)\n",
    );
    writeFileSync(
      path.join(root, "CHANGELOG", "2026.8.1.md"),
      changelog.replace("Unreleased", "2026.8.1"),
    );
    expect(validatePackageSourceDir(root)).toBe("2026.8.1");
    writeFileSync(path.join(root, "CHANGELOG", "2026.8.1.md"), "## 2026.8.1\n- Tiny.\n");
    expect(() => validatePackageSourceDir(root)).toThrow("only 7 body bytes");
  });

  it.each([
    ["2026.8.1", "Unreleased"],
    ["2026.8.1-beta.4", "Unreleased"],
    ["2026.9.1", "2026.8.3 (Unreleased)"],
  ])("accepts aligned %s source manifests with %s notes", (version, heading) => {
    expect(
      validatePackageSource({
        aiManifestContent: aiManifest({ version }),
        allowUnreleasedChangelog: true,
        changelogContent: changelog.replace("## Unreleased", `## ${heading}`),
        rootManifestContent: rootManifest({ version }),
      }),
    ).toBe(version);
  });

  it("uses canonical package changelog validation", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest(),
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow("CHANGELOG.md does not contain a release section for 2026.8.1.");
  });

  it("accepts complete oversized contribution records through the package renderer", () => {
    expect(
      validatePackageSource({
        aiManifestContent: aiManifest(),
        rootManifestContent: rootManifest(),
        changelogContent: `# Changelog\n\n## 2026.8.1\n\n- A complete release note with its original credit. Thanks @contributor.\n\n### Complete contribution record\n\n${"- **PR #123** Thanks @contributor.\n".repeat(20_000)}`,
      }),
    ).toBe("2026.8.1");
  });

  it("rejects source package version drift", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest({ version: "2026.8.2" }),
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow("packages/ai/package.json version must match package.json");
  });

  it("rejects @openclaw/ai dependency drift before packing", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest({
          dependencies: {
            openai: "6.50.0",
          },
        }),
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow(
      "package.json must declare openai@6.50.0 to bundle packages/ai/package.json without duplicate dependencies",
    );
  });

  it("shares exact, workspace, private, and value-type dependency semantics with packaging", () => {
    expect(
      validateBundledPackageDependencyAlignment({
        bundledDependencies: {
          exact: "1.2.3",
          private: "0.0.0-private",
          workspace: "4.5.6",
        },
        bundledPackageLabel: "packed @openclaw/ai",
        rootDependencies: {
          exact: "1.2.3",
          workspace: "workspace:4.5.6",
        },
      }),
    ).toEqual([
      ["exact", "1.2.3"],
      ["workspace", "4.5.6"],
    ]);

    expect(() =>
      validateBundledPackageDependencyAlignment({
        bundledDependencies: { invalid: 123 },
        bundledPackageLabel: "packed @openclaw/ai",
        rootDependencies: { invalid: "123" },
      }),
    ).toThrow("packed @openclaw/ai dependency invalid must declare a string version");
    expect(() =>
      validateBundledPackageDependencyAlignment({
        bundledDependencies: { invalid: "1.2.3" },
        bundledPackageLabel: "packed @openclaw/ai",
        rootDependencies: { invalid: 123 },
      }),
    ).toThrow("root package.json dependency invalid must declare a string version");
  });

  it("preserves historical sources from before the @openclaw/ai workspace split", () => {
    expect(
      validatePackageSource({
        aiManifestContent: null,
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest({ dependencies: {} }),
      }),
    ).toBe("2026.8.1");
  });

  it("validates the current source ref without modifying the checkout", () => {
    const committedManifest = JSON.parse(
      execFileSync("git", ["show", "HEAD:package.json"], { encoding: "utf8" }),
    ) as { version: string };
    const workingManifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(
      validatePackageSourceRef("HEAD", {
        allowUnreleasedChangelog: true,
      }),
    ).toBe(committedManifest.version);
    expect(
      validatePackageSourceDir(process.cwd(), {
        allowUnreleasedChangelog: true,
      }),
    ).toBe(workingManifest.version);
  });
});
