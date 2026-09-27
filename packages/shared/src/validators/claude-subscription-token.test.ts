import { describe, expect, it } from "vitest";
import { createAgentSchema } from "./agent.js";
import { createProjectSchema } from "./project.js";
import {
  CLAUDE_SUBSCRIPTION_TOKEN_ENV_KEYS,
  CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
  createSecretSchema,
  createUserSecretValueSchema,
  envConfigWithoutClaudeSubscriptionTokenSchema,
  isClaudeSubscriptionTokenEnvEntry,
  isClaudeSubscriptionTokenEnvKey,
  isClaudeSubscriptionTokenValue,
  rotateSecretSchema,
  rotateUserSecretValueSchema,
  updateUserSecretValueSchema,
} from "./secret.js";

type ParseResult = {
  success: boolean;
  error?: { issues: ReadonlyArray<{ message: string; path: PropertyKey[] }> };
};

function tokenIssues(result: ParseResult) {
  return (result.error?.issues ?? []).filter(
    (issue) => issue.message === CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
  );
}

describe("Claude subscription token detection", () => {
  it("blocks every subscription token env key in any letter case", () => {
    expect(CLAUDE_SUBSCRIPTION_TOKEN_ENV_KEYS).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_TOKEN",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CCR_OAUTH_TOKEN_FILE",
      "CLAUDE_CODE_HOST_CREDS_FILE",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    ]);
    for (const key of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "anthropic_oauth_token",
      " Anthropic_Token ",
      "claude_code_oauth_refresh_token",
      "CLAUDE_CODE_HOST_CREDS_FILE",
    ]) {
      expect(isClaudeSubscriptionTokenEnvKey(key)).toBe(true);
    }
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_TOKEN_URL"]) {
      expect(isClaudeSubscriptionTokenEnvKey(key)).toBe(false);
    }
  });

  it("detects a subscription token by value, trimmed", () => {
    expect(isClaudeSubscriptionTokenValue("sk-ant-oat01-abc")).toBe(true);
    expect(isClaudeSubscriptionTokenValue("  sk-ant-oat01-abc\n")).toBe(true);
    // The OAuth refresh token and the Claude.ai session key are Claude.ai credentials too.
    expect(isClaudeSubscriptionTokenValue("sk-ant-ort01-abc")).toBe(true);
    expect(isClaudeSubscriptionTokenValue(" SK-ANT-SID01-abc")).toBe(true);
    expect(isClaudeSubscriptionTokenValue("sk-ant-api03-abc")).toBe(false);
    expect(isClaudeSubscriptionTokenValue("sk-ant-admin01-abc")).toBe(false);
    expect(isClaudeSubscriptionTokenValue("prefix sk-ant-oat01-abc")).toBe(false);
    expect(isClaudeSubscriptionTokenValue(null)).toBe(false);
    expect(isClaudeSubscriptionTokenValue({ type: "plain", value: "sk-ant-oat01" })).toBe(false);
  });

  it("checks env entries by key and by literal value", () => {
    expect(isClaudeSubscriptionTokenEnvEntry("ANTHROPIC_API_KEY", "sk-ant-oat01-x")).toBe(true);
    expect(isClaudeSubscriptionTokenEnvEntry("ANTHROPIC_API_KEY", { type: "plain", value: " sk-ant-oat01-x" })).toBe(true);
    expect(isClaudeSubscriptionTokenEnvEntry("ANTHROPIC_TOKEN", { type: "secret_ref", secretId: "x" })).toBe(true);
    expect(isClaudeSubscriptionTokenEnvEntry("ANTHROPIC_API_KEY", { type: "secret_ref", secretId: "x" })).toBe(false);
    expect(isClaudeSubscriptionTokenEnvEntry("ANTHROPIC_API_KEY", "sk-ant-api03-x")).toBe(false);
  });
});

describe("env maps reject subscription tokens by key and value", () => {
  it("rejects a subscription token value under any key", () => {
    for (const binding of ["sk-ant-oat01-a", { type: "plain", value: "sk-ant-oat01-b" }]) {
      const result = envConfigWithoutClaudeSubscriptionTokenSchema.safeParse({
        ANTHROPIC_API_KEY: binding,
        OTHER: "fine",
      });
      expect(result.success).toBe(false);
      const issues = tokenIssues(result);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual(["ANTHROPIC_API_KEY"]);
    }
  });

  it("rejects the widened token keys in agent and project env maps", () => {
    for (const key of ["ANTHROPIC_OAUTH_TOKEN", "anthropic_token"]) {
      const agent = createAgentSchema.safeParse({
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: { env: { [key]: { type: "plain", value: "x" } } },
      });
      expect(tokenIssues(agent)).toHaveLength(1);
      const project = createProjectSchema.safeParse({ name: "Project", env: { [key]: "x" } });
      expect(tokenIssues(project)).toHaveLength(1);
    }
    const agentValue = createAgentSchema.safeParse({
      name: "Claude",
      adapterType: "claude_local",
      adapterConfig: { env: { ANTHROPIC_AUTH_TOKEN: { type: "plain", value: "sk-ant-oat01-x" } } },
    });
    expect(tokenIssues(agentValue)).toHaveLength(1);
  });

  it("accepts API credentials and secret references", () => {
    const result = envConfigWithoutClaudeSubscriptionTokenSchema.safeParse({
      ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api03-x" },
      ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(result.success).toBe(true);
  });
});

describe("secrets reject subscription token values", () => {
  it("rejects creating or rotating a company secret whose value is a subscription token", () => {
    const create = createSecretSchema.safeParse({ name: "anthropic", value: "sk-ant-oat01-x" });
    expect(tokenIssues(create)).toHaveLength(1);
    expect(tokenIssues(create)[0]?.path).toEqual(["value"]);
    const rotate = rotateSecretSchema.safeParse({ value: " sk-ant-oat01-x" });
    expect(tokenIssues(rotate)).toHaveLength(1);
    expect(createSecretSchema.safeParse({ name: "anthropic", value: "sk-ant-api03-x" }).success).toBe(true);
    expect(rotateSecretSchema.safeParse({ value: "sk-ant-api03-x" }).success).toBe(true);
  });

  it("rejects creating, updating or rotating a user secret whose value is a subscription token", () => {
    expect(
      tokenIssues(createUserSecretValueSchema.safeParse({ definitionKey: "claude", value: "sk-ant-oat01-x" })),
    ).toHaveLength(1);
    expect(tokenIssues(updateUserSecretValueSchema.safeParse({ value: "sk-ant-oat01-x" }))).toHaveLength(1);
    expect(tokenIssues(rotateUserSecretValueSchema.safeParse({ value: "sk-ant-oat01-x" }))).toHaveLength(1);
    expect(updateUserSecretValueSchema.safeParse({ status: "active" }).success).toBe(true);
    expect(rotateUserSecretValueSchema.safeParse({ value: "sk-ant-api03-x" }).success).toBe(true);
  });
});
