import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  probeResult,
} = vi.hoisted(() => {
  const probeResult: { value: { exitCode: number; stdout: string; stderr: string } } = {
    value: { exitCode: 1, stdout: "", stderr: "" },
  };
  return {
    probeResult,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: probeResult.value.exitCode,
      signal: null,
      timedOut: false,
      stdout: probeResult.value.stdout,
      stderr: probeResult.value.stderr,
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    describeAdapterExecutionTarget: vi.fn(() => "Daytona"),
    resolveAdapterExecutionTargetCwd: vi.fn(() => "/home/daytona/paperclip-workspace"),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
  };
});

import { testEnvironment } from "./test.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

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

const sshTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "ssh",
  remoteCwd: "/home/agent/paperclip-workspace",
  spec: {
    host: "ssh.example.test",
    port: 22,
    username: "agent",
    remoteCwd: "/home/agent/paperclip-workspace",
    remoteWorkspacePath: "/home/agent/paperclip-workspace",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
  },
};

// Remote targets need an Anthropic API key; the Claude subscription is limited
// to the claude CLI signed in on the Paperclip host.
const REMOTE_API_KEY_ENV = { ANTHROPIC_API_KEY: "sk-ant-remote-fixture" };

const initLine =
  '{"type":"system","subtype":"init","cwd":"/home/daytona/paperclip-workspace","session_id":"abc","tools":["Bash","Read"]}';

const loginRequiredStdout = [
  initLine,
  '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run `claude login` to authenticate.","session_id":"abc"}',
].join("\n");

afterEach(() => {
  vi.clearAllMocks();
  resetClaudeCliCapabilitiesCacheForTests();
});

describe("claude remote auth-required check", () => {
  it.each([
    ["sandbox", sandboxTarget],
    ["SSH", sshTarget],
  ])("reports a rejected credential on a %s target without offering an in-environment login", async (_label, target) => {
    // A remote target authenticates with an API key. When the hello probe
    // reports that login is required, the key was rejected. Claude offers no
    // in-environment login, so the Test never emits the adapter_auth_missing
    // login gate and points the operator at ANTHROPIC_API_KEY instead.
    probeResult.value = { exitCode: 1, stdout: loginRequiredStdout, stderr: "" };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude", env: REMOTE_API_KEY_ENV },
      executionTarget: target,
      environmentName: "Remote",
    });

    expect(result.status).toBe("warn");
    const authRequired = result.checks.find((check) => check.code === "claude_hello_probe_auth_required");
    expect(authRequired?.hint).toContain("ANTHROPIC_API_KEY");
    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(false);
  });
});

describe("claude CLI model compatibility check", () => {
  it("fails before the hello probe when Fable 5.1 is configured with an older CLI", async () => {
    probeResult.value = {
      exitCode: 0,
      stdout: "2.1.247 (Claude Code)\n",
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "cli",
        command: "claude",
        model: "claude-fable-5-1",
        env: REMOTE_API_KEY_ENV,
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_cli_version_incompatible",
      level: "error",
      detail: "Detected Claude Code 2.1.247.",
    }));
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const versionCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string,
      AdapterExecutionTarget,
      string,
      string[],
    ];
    expect(versionCall[3]).toEqual(["--version"]);
  });
});

describe("claude remote API key requirement", () => {
  const REMOTE_MESSAGE =
    "Claude on remote targets needs an Anthropic API key; subscription use is limited to the claude CLI signed in on this server.";

  it.each([
    ["SSH", sshTarget],
    ["sandbox", sandboxTarget],
  ])("fails the %s Test before any probe when no API key is configured", async (_label, target) => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: target,
      environmentName: "Remote",
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([
      expect.objectContaining({ code: "adapter_engine_unavailable", level: "error", message: REMOTE_MESSAGE }),
    ]);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    expect(ensureAdapterExecutionTargetDirectory).not.toHaveBeenCalled();
  });

  it("fails an unset engine on a remote target the same way", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { command: "claude" },
      executionTarget: sshTarget,
      environmentName: "Remote",
    });

    expect(result.status).toBe("fail");
    expect(result.checks[0]).toMatchObject({ code: "adapter_engine_unavailable", message: REMOTE_MESSAGE });
  });

  it("accepts Bedrock provider auth on a remote target", async () => {
    probeResult.value = {
      exitCode: 0,
      stdout: [initLine, '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}'].join("\n"),
      stderr: "",
    };
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude", env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
      executionTarget: sshTarget,
      environmentName: "Remote",
    });

    expect(result.checks.some((check) => check.code === "adapter_engine_unavailable")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_bedrock_auth")).toBe(true);
  });
});
