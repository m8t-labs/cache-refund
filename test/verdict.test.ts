import { describe, expect, it } from "vitest";
import { detectBranch, type EnvHints } from "../src/verdict.js";

const baseHints: EnvHints = {
  enable1h: false,
  force5m: false,
  useBedrock: false,
  useVertex: false,
  hasApiKey: false,
  settingsFound: true,
};

describe("detectBranch subscription precedence", () => {
  it("recognized subscription metadata wins over a stray provider-less 1h flag", () => {
    const result = detectBranch(
      {
        ...baseHints,
        enable1h: true,
        accountSubscription: true,
        accountEvidence: ["recognized Max subscription"],
      },
      "1h",
      false,
    );

    expect(result.branch).toBe("subscription");
    expect(result.evidence).toContain("=> subscription (recognized local account metadata; ignoring provider-less 1h flag)");
  });

  it("an explicit API provider signal still wins over subscription metadata", () => {
    const result = detectBranch(
      { ...baseHints, enable1h: true, hasApiKey: true, accountSubscription: true },
      "1h",
      false,
    );

    expect(result.branch).toBe("api-1h");
  });

  it("configured 1h stays api-1h when recent transcripts are still receiving 5m", () => {
    const result = detectBranch(
      { ...baseHints, enable1h: true, hasApiKey: true },
      "5m",
      false,
    );

    expect(result.branch).toBe("api-1h");
    expect(result.evidence).toContain("=> API-billed, configured for 1h but receiving 5m");
  });
});
