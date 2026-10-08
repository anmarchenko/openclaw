import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSummary,
  filterIgnoredFindings,
  formatAnnotation,
  intersectFindings,
  parseRepoLocation,
  validateFindings,
} from "../../scripts/periphery-intersection.mjs";
const FINDING_SOURCE = "../shared/OpenClawKit/Sources/OpenClawKit/Example.swift";

function finding(overrides: Record<string, unknown> = {}) {
  return {
    ids: ["s:11OpenClawKit7ExampleV"],
    kind: "struct",
    location: `${FINDING_SOURCE}:12:8`,
    name: "Example",
    ...overrides,
  };
}

function withSharedSource(source: string, test: (repoRoot: string) => void) {
  const repoRoot = mkdtempSync(join(tmpdir(), "openclaw-periphery-intersection-"));
  const sourceFile = join(repoRoot, "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift");
  mkdirSync(dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, source);
  try {
    test(repoRoot);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
}

describe("Periphery intersection", () => {
  it("matches exact Swift USRs instead of declaration names", () => {
    const sameNameDifferentUsr = finding({ ids: ["s:11OpenClawKit7ExampleV_other"] });
    expect(intersectFindings([finding()], [sameNameDifferentUsr])).toEqual([]);
    expect(intersectFindings([finding()], [finding()])).toEqual([finding()]);
  });

  it("matches any USR emitted for a declaration compiled into multiple iOS modules", () => {
    const ios = finding({ ids: ["s:16OpenClawWatchApp7ExampleV", "s:11OpenClawKit7ExampleV"] });
    expect(intersectFindings([ios], [finding()])).toEqual([ios]);
  });

  it("sorts findings deterministically", () => {
    const later = finding({
      ids: ["s:11OpenClawKit5LaterV"],
      location: "../shared/OpenClawKit/Sources/OpenClawKit/Later.swift:2:1",
      name: "Later",
    });
    expect(intersectFindings([later, finding()], [finding(), later])).toEqual([finding(), later]);
  });

  it("honors bare Periphery ignore comments on or above declarations", () => {
    withSharedSource(
      [
        "// periphery:ignore - exported package surface",
        "public struct Example {}",
        "",
        'public init(value: String = "value") {} // periphery:ignore - exported initializer',
      ].join("\n"),
      (repoRoot) => {
        const declaration = finding({ location: `${FINDING_SOURCE}:2:8` });
        const inline = finding({ location: `${FINDING_SOURCE}:4:8` });
        expect(filterIgnoredFindings([declaration, inline], repoRoot)).toEqual([]);
      },
    );
  });

  it("does not treat scoped Periphery commands as bare ignores", () => {
    withSharedSource(
      ["// periphery:ignore:parameters value", "public struct Example {}"].join("\n"),
      (repoRoot) => {
        const command = finding({ location: `${FINDING_SOURCE}:2:8` });
        expect(filterIgnoredFindings([command], repoRoot)).toEqual([command]);
      },
    );
  });

  it("fails closed when a finding has no USR", () => {
    expect(() => validateFindings([finding({ ids: [] })], "iOS")).toThrow(
      "iOS finding 0 has no usable Swift USR",
    );
  });

  it("rejects findings outside shared OpenClawKit", () => {
    expect(() =>
      validateFindings([finding({ location: "Sources/App.swift:1:1" })], "macOS"),
    ).toThrow("macOS finding 0 is outside shared OpenClawKit sources");
  });

  it("maps relative scan locations to repository annotations", () => {
    expect(parseRepoLocation(finding().location)).toEqual({
      column: "8",
      file: "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift",
      line: "12",
    });
    expect(formatAnnotation(finding())).toBe(
      "::error file=apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift,line=12,col=8,title=Dead shared Swift code::struct Example",
    );
  });

  it("reports the zero-findings policy in the summary", () => {
    expect(buildSummary([])).toContain("No declarations were reported dead by both");
    expect(buildSummary([finding()])).toContain("Found 1 shared Swift declaration");
  });
});
