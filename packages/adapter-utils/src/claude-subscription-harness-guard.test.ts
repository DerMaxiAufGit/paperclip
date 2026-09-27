import { describe, expect, it } from "vitest";
import {
  buildClaudeSubscriptionHarnessRefusal,
  CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE,
  envHasAnthropicApiCredential,
  isAnthropicApiCredentialValue,
  readHarnessCliFlagValues,
  resolveClaudeSubscriptionHarnessViolation,
} from "./claude-subscription-harness-guard.js";

describe("third-party harness Claude subscription guard", () => {
  it("uses the agreed refusal message", () => {
    expect(CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE).toBe(
      "Only the official claude binary may use a Claude subscription. Give this agent an Anthropic API key, or use the Claude (claude_local) adapter.",
    );
  });

  it("counts a real API key, but never a blank value or a Claude subscription token", () => {
    expect(isAnthropicApiCredentialValue("sk-ant-api03-fixture")).toBe(true);
    expect(isAnthropicApiCredentialValue("gateway-virtual-key")).toBe(true);
    expect(isAnthropicApiCredentialValue("")).toBe(false);
    expect(isAnthropicApiCredentialValue("   ")).toBe(false);
    expect(isAnthropicApiCredentialValue(undefined)).toBe(false);
    expect(isAnthropicApiCredentialValue("sk-ant-oat01-fixture")).toBe(false);
    expect(isAnthropicApiCredentialValue("  SK-ANT-OAT01-fixture")).toBe(false);
  });

  it("reads only the env keys the harness uses as an API key", () => {
    const env = { ANTHROPIC_AUTH_TOKEN: "gateway-token", CLAUDE_CODE_USE_BEDROCK: "1" };
    expect(envHasAnthropicApiCredential(env)).toBe(false);
    expect(envHasAnthropicApiCredential(env, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])).toBe(true);
    expect(envHasAnthropicApiCredential({ ANTHROPIC_API_KEY: "sk-ant-api03-fixture" })).toBe(true);
    expect(envHasAnthropicApiCredential({ ANTHROPIC_API_KEY: "sk-ant-oat01-fixture" })).toBe(false);
  });

  it("refuses only an Anthropic route without an API key", () => {
    expect(resolveClaudeSubscriptionHarnessViolation({ anthropicRoute: false, env: {} })).toBeNull();
    expect(resolveClaudeSubscriptionHarnessViolation({ anthropicRoute: true, env: {} })).toBe(
      CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE,
    );
    expect(
      resolveClaudeSubscriptionHarnessViolation({
        anthropicRoute: true,
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" },
      }),
    ).toBeNull();
    expect(
      resolveClaudeSubscriptionHarnessViolation({
        anthropicRoute: true,
        env: { ANTHROPIC_API_KEY: "sk-ant-oat01-fixture", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fixture" },
      }),
    ).toBe(CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE);
  });

  it("builds a non-retryable result that proves the harness never started", () => {
    expect(buildClaudeSubscriptionHarnessRefusal(undefined, { provider: "anthropic", model: "claude-x" })).toEqual({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_engine_unavailable",
      errorMessage: CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE,
      provider: "anthropic",
      model: "claude-x",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
  });

  it("reads provider and model flags from extra args in every form", () => {
    const args = ["--provider", "openrouter", "--provider=anthropic", "-m", "a", "-mb", "-m=c", "--model", "d", "--", "--model", "e"];
    expect(readHarnessCliFlagValues(args, ["--provider"])).toEqual(["openrouter", "anthropic"]);
    expect(readHarnessCliFlagValues(args, ["-m", "--model"])).toEqual(["a", "b", "c", "d"]);
    expect(readHarnessCliFlagValues(["--prov", "anthropic"], ["--provider"])).toEqual([]);
    expect(readHarnessCliFlagValues(["--prov", "anthropic"], ["--provider"], { abbreviations: true })).toEqual(["anthropic"]);
    expect(readHarnessCliFlagValues(["-v", "--max-turns", "3"], ["-m", "--model"])).toEqual([]);
    expect(readHarnessCliFlagValues(undefined, ["--model"])).toEqual([]);
  });
});
