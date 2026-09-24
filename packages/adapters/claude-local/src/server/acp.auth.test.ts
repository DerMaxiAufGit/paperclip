import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// The ACP Test lane runs no Claude process: the ACP engine always needs an API
// credential, so there is no Claude sign-in to probe. The spy proves it.
const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
  };
});

import { mapClaudeAcpAuthErrorCode, testClaudeAcpEnvironment } from "./acp.js";

const sandboxTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "daytona",
  remoteCwd: "/home/daytona/paperclip-workspace",
  runner: {
    execute: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    }),
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("mapClaudeAcpAuthErrorCode", () => {
  it("translates the generic acpx_auth_required code into claude_auth_required", () => {
    const engineResult: AdapterExecutionResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Claude requires login.",
      errorCode: "acpx_auth_required",
      errorMeta: { category: "auth", errorName: "Error" },
    };

    const mapped = mapClaudeAcpAuthErrorCode(engineResult);

    // The user interface run gate reads claude_auth_required to show the login
    // affordance on the default ACP path.
    expect(mapped.errorCode).toBe("claude_auth_required");
    // The mapping keeps every other field so diagnostics stay intact.
    expect(mapped.errorMessage).toBe("Claude requires login.");
    expect(mapped.errorMeta).toEqual({ category: "auth", errorName: "Error" });
  });

  it("leaves a different error code unchanged", () => {
    const engineResult: AdapterExecutionResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "acpx_runtime_error",
    };

    expect(mapClaudeAcpAuthErrorCode(engineResult).errorCode).toBe("acpx_runtime_error");
  });

  it("leaves a null error code unchanged", () => {
    const engineResult: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorCode: null,
    };

    expect(mapClaudeAcpAuthErrorCode(engineResult).errorCode).toBeNull();
  });
});

describe("Claude ACP Test lane credentials", () => {
  // Clear the host auth variables so the Test reads a deterministic env
  // regardless of the machine that runs the suite.
  const CLEARED_HOST_ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_BEDROCK_BASE_URL",
  ];
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of CLEARED_HOST_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("requires an API key on the ACP lane and never uses a configured CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-secret" } },
      executionTarget: null,
      environmentName: null,
    });
    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_acp_api_key_required",
      level: "error",
      message:
        "The Claude ACP engine needs an Anthropic API key. Use engine=cli to run with the claude CLI signed in on this server.",
    }));
    // Every result names the target it probed, including the host case.
    expect(result.checks.some((check) => check.code === "claude_environment_target")).toBe(true);
    // The token value never enters a check, and no Claude process runs.
    expect(JSON.stringify(result.checks)).not.toContain("oauth-token-secret");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("reports an explicitly selected API key as normal authentication on the ACP lane", async () => {
    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", agentCommand: process.execPath, env: { ANTHROPIC_API_KEY: "selected-test-key" } },
      executionTarget: null,
      environmentName: null,
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_acp_anthropic_api_key_detected",
      level: "info",
      message: "Using the selected Claude API connection.",
      hint: undefined,
    }));
    expect(JSON.stringify(result.checks)).not.toContain("selected-test-key");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("accepts the host ANTHROPIC_API_KEY on a local target without a login probe", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-key";

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", agentCommand: process.execPath },
      executionTarget: null,
      environmentName: null,
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_acp_anthropic_api_key_detected", level: "info",
    }));
    expect(result.checks.some((check) => check.code === "claude_acp_api_key_required")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    // The host key value never enters a check.
    expect(JSON.stringify(result.checks)).not.toContain("sk-ant-host-key");
  });

  it("never counts the host CLAUDE_CODE_OAUTH_TOKEN as an ACP credential", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-host-token";

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp" },
      executionTarget: null,
      environmentName: null,
    });

    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_acp_api_key_required",
      level: "error",
    }));
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    // The host token value never enters a check.
    expect(JSON.stringify(result.checks)).not.toContain("oauth-host-token");
  });

  it("offers no in-environment login on a sandbox target", async () => {
    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", env: { ANTHROPIC_API_KEY: "sandbox-api-key" } },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_acp_anthropic_api_key_detected", level: "info",
    }));
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    expect(JSON.stringify(result.checks)).not.toContain("sandbox-api-key");
  });
});
