import { describe, expect, it } from "vitest";
import {
  createEnvironmentSchema,
  probeEnvironmentConfigSchema,
  updateEnvironmentSchema,
} from "./environment.js";
import { CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE } from "./secret.js";

const base = { name: "Local", driver: "local" };

function claudeTokenIssues(result: { success: boolean; error?: { issues: ReadonlyArray<{ message: string; path: PropertyKey[] }> } }) {
  return (result.error?.issues ?? []).filter(
    (issue) => issue.message === CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE,
  );
}

describe("environment envVars Claude subscription token rejection", () => {
  it("rejects the exact CLAUDE_CODE_OAUTH_TOKEN key with the fixed message and key path", () => {
    const result = createEnvironmentSchema.safeParse({
      ...base,
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "sk-ant-oat-x" } },
    });

    expect(result.success).toBe(false);
    const issues = claudeTokenIssues(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN is not supported. Claude subscriptions are used through the claude CLI signed in on this server; use ANTHROPIC_API_KEY for API-key access.",
    );
    expect(issues[0]?.path).toEqual(["envVars", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("rejects lowercase and mixed-case spellings of the key", () => {
    for (const key of ["claude_code_oauth_token", "Claude_Code_OAuth_Token"]) {
      const result = createEnvironmentSchema.safeParse({ ...base, envVars: { [key]: "value" } });

      expect(result.success).toBe(false);
      const issues = claudeTokenIssues(result);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual(["envVars", key]);
    }
  });

  it("rejects the key on update and probe payloads", () => {
    const envVars = { CLAUDE_CODE_OAUTH_TOKEN: "value" };

    expect(claudeTokenIssues(updateEnvironmentSchema.safeParse({ envVars }))).toHaveLength(1);
    expect(claudeTokenIssues(probeEnvironmentConfigSchema.safeParse({ driver: "local", envVars }))).toHaveLength(1);
  });

  it("still accepts ANTHROPIC_API_KEY", () => {
    const parsed = createEnvironmentSchema.parse({
      ...base,
      envVars: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api-x" } },
    });

    expect(parsed.envVars).toEqual({
      ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api-x" },
    });
  });
});
