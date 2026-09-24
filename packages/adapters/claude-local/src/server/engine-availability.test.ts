import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClaudeExecutionEngineForRun } from "./acp.js";
import { CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE } from "./credential-policy.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const originalVersion = process.version;
afterEach(() => {
  Object.defineProperty(process, "version", { value: originalVersion });
  vi.unstubAllEnvs();
});

const API_KEY_ENV = { ANTHROPIC_API_KEY: "sk-ant-engine-fixture" };

function clearHostApiCredentials() {
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]) {
    vi.stubEnv(key, "");
  }
}

describe("claude engine availability", () => {
  it.each([undefined, "auto", "", "unknown"])("defaults engine=%s to the Claude CLI without ACP prerequisites", async (engine) => {
    clearHostApiCredentials();
    Object.defineProperty(process, "version", { value: "v18.0.0" });
    await expect(resolveClaudeExecutionEngineForRun({ config: { engine } }))
      .resolves.toEqual({ engine: "cli", explicit: false });
  });

  it("defaults an unset engine with an API key in the adapter env to ACP", async () => {
    clearHostApiCredentials();
    Object.defineProperty(process, "version", { value: "v24.11.0" });
    const result = await resolveClaudeExecutionEngineForRun({
      config: { env: API_KEY_ENV, agentCommand: "/nonexistent/paperclip-test/acp" },
    });
    expect(result.engine).toBe("acp");
    expect(result.explicit).toBe(false);
    // An implicit ACP selection still names the explicit CLI escape hatch.
    expect(result.unavailableReason).toContain("explicitly set engine=cli");
  });

  it("defaults an unset engine without a key to the CLI engine", async () => {
    clearHostApiCredentials();
    await expect(resolveClaudeExecutionEngineForRun({ config: {} }))
      .resolves.toEqual({ engine: "cli", explicit: false });
  });

  it("ignores the host key for the default engine when a managed connection is set", async () => {
    clearHostApiCredentials();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-host");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { managedAiConnection: { provider: "anthropic", method: "api_key" } },
      }),
    ).resolves.toEqual({ engine: "cli", explicit: false });
  });

  it("keeps local confinement on the CLI engine when the engine is unset", async () => {
    clearHostApiCredentials();
    await expect(
      resolveClaudeExecutionEngineForRun({ config: { env: API_KEY_ENV, filesystemScope: "workspace" } }),
    ).resolves.toEqual({ engine: "cli", explicit: false });
  });

  it("reports an ACP setup failure without starting a process when an API key is configured", async () => {
    Object.defineProperty(process, "version", { value: "v18.0.0" });
    const config = { engine: "acp", env: API_KEY_ENV };
    const onSpawn = vi.fn();
    const result = await execute({ config, onSpawn } as never);
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "adapter_engine_unavailable",
      errorMessage: expect.stringContaining("Node v18.0.0"),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    expect(result.errorMessage).toContain(process.execPath);
    expect(onSpawn).not.toHaveBeenCalled();
    const diagnostic = await testEnvironment({ config } as never);
    expect(diagnostic.status).toBe("fail");
    expect(diagnostic.checks).toContainEqual(expect.objectContaining({
      code: "adapter_engine_unavailable", level: "error",
    }));
  });

  it("does not apply ACP prerequisites to explicitly selected CLI", async () => {
    Object.defineProperty(process, "version", { value: "v18.0.0" });
    await expect(resolveClaudeExecutionEngineForRun({ config: { engine: "cli" } }))
      .resolves.toEqual({ engine: "cli", explicit: true });
  });

  it("keeps an unavailable ACP command as a failure, not a CLI selection", async () => {
    Object.defineProperty(process, "version", { value: "v24.11.0" });
    const result = await resolveClaudeExecutionEngineForRun({
      config: {
        engine: "acp",
        env: API_KEY_ENV,
        agentCommand: "/nonexistent/paperclip-test/acp",
        command: "/nonexistent/paperclip-test/acp",
      },
    });
    expect(result.engine).toBe("acp");
    expect(result.unavailableReason).toContain("not available");
  });
});

describe("claude ACP API key requirement", () => {
  it("fails explicit ACP without an API key before launch, in execute and in the Test", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", "");
    vi.stubEnv("CLAUDE_CODE_USE_VERTEX", "");
    Object.defineProperty(process, "version", { value: "v24.11.0" });
    const config = { engine: "acp", env: { CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" } };

    await expect(resolveClaudeExecutionEngineForRun({ config })).resolves.toEqual({
      engine: "acp",
      explicit: true,
      unavailableReason: CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE,
    });

    const onSpawn = vi.fn();
    const result = await execute({ config, onSpawn } as never);
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "adapter_engine_unavailable",
      errorMessage:
        "The Claude ACP engine needs an Anthropic API key. Use engine=cli to run with the claude CLI signed in on this server.",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    expect(onSpawn).not.toHaveBeenCalled();

    const diagnostic = await testEnvironment({ config } as never);
    expect(diagnostic.status).toBe("fail");
    expect(diagnostic.checks).toEqual([
      expect.objectContaining({
        code: "adapter_engine_unavailable",
        level: "error",
        message: CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE,
      }),
    ]);
  });

  it("lets a blank adapter API key override a host key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-host");
    await expect(
      resolveClaudeExecutionEngineForRun({ config: { engine: "acp", env: { ANTHROPIC_API_KEY: "" } } }),
    ).resolves.toMatchObject({ unavailableReason: CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE });
  });

  it("accepts a host API key for a local ACP run", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-host");
    const result = await resolveClaudeExecutionEngineForRun({
      config: { engine: "acp", agentCommand: "/nonexistent/paperclip-test/acp" },
    });
    expect(result.unavailableReason ?? "").not.toContain("Anthropic API key");
  });

  it("ignores the host API key for a managed AI connection", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-host");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", managedAiConnection: { provider: "anthropic", method: "subscription" } },
      }),
    ).resolves.toMatchObject({ unavailableReason: CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE });
  });
});
