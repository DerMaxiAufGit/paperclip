import { describe, expect, it } from "vitest";
import {
  createAgentHireSchema,
  createAgentSchema,
  testAdapterEnvironmentSchema,
  updateAgentSchema,
} from "./agent.js";
import { CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE } from "./secret.js";

const base = { name: "Claude Agent", adapterType: "claude_local" };

function claudeTokenIssues(result: { success: boolean; error?: { issues: ReadonlyArray<{ message: string; path: PropertyKey[] }> } }) {
  return (result.error?.issues ?? []).filter(
    (issue) => issue.message === CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE,
  );
}

describe("agent adapterConfig.env Claude subscription token rejection", () => {
  it("rejects the exact CLAUDE_CODE_OAUTH_TOKEN key with the fixed message and key path", () => {
    const result = createAgentSchema.safeParse({
      ...base,
      adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "sk-ant-oat-x" } } },
    });

    expect(result.success).toBe(false);
    const issues = claudeTokenIssues(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN is not supported. Claude subscriptions are used through the claude CLI signed in on this server; use ANTHROPIC_API_KEY for API-key access.",
    );
    expect(issues[0]?.path).toEqual(["adapterConfig", "env", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("rejects lowercase and mixed-case spellings of the key", () => {
    for (const key of ["claude_code_oauth_token", "Claude_Code_OAuth_Token"]) {
      const result = createAgentSchema.safeParse({
        ...base,
        adapterConfig: { env: { [key]: "value" } },
      });

      expect(result.success).toBe(false);
      const issues = claudeTokenIssues(result);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual(["adapterConfig", "env", key]);
    }
  });

  it("rejects the key on update, hire, and adapter environment test payloads", () => {
    const adapterConfig = { env: { CLAUDE_CODE_OAUTH_TOKEN: "value" } };

    expect(claudeTokenIssues(updateAgentSchema.safeParse({ adapterConfig }))).toHaveLength(1);
    expect(claudeTokenIssues(createAgentHireSchema.safeParse({ ...base, adapterConfig }))).toHaveLength(1);
    expect(claudeTokenIssues(testAdapterEnvironmentSchema.safeParse({ adapterConfig }))).toHaveLength(1);
  });

  it("still accepts ANTHROPIC_API_KEY", () => {
    const parsed = createAgentSchema.parse({
      ...base,
      adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api-x" } } },
    });

    expect(parsed.adapterConfig.env).toEqual({
      ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api-x" },
    });
  });

  it("no longer carries the removed stored Claude login fields", () => {
    const parsed = createAgentSchema.parse({
      ...base,
      storedSessionId: "session-claim",
      applyStoredClaudeLogin: true,
    });

    expect(parsed).not.toHaveProperty("storedSessionId");
    expect(parsed).not.toHaveProperty("applyStoredClaudeLogin");
  });
});
