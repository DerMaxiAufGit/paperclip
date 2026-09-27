import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

// Wrap the shared staging seam in a call-recording spy that still delegates to
// the real implementation (a runner-backed sandbox test exercises it end to
// end against the local sandbox stand-in). This lets a test assert the exact
// `assets` the Claude remote managed-home seam sends it without changing any
// real behavior for the other tests.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual = await importActual<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: vi.fn(actual.prepareAdapterExecutionTargetRuntime),
  };
});
import { prepareAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";
import {
  buildClaudeAcpConfig,
  claudeConfigCredentialWorkspaceExcludes,
  createClaudeAcpExecutor,
  nodeVersionMeetsClaudeAcpMinimum,
  resolveClaudeAcpBillingIdentity,
  resolveClaudeExecutionEngine,
  resolveClaudeExecutionEngineForRun,
  testClaudeAcpEnvironment,
} from "./acp.js";

// A local stand-in for a sandbox runner: runs the managed-runtime staging
// scripts (mkdir/tar/find) as real child processes so the remote ACP lane can
// be exercised end-to-end against the host filesystem.
function createLocalSandboxRunner() {
  let counter = 0;
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    }) => {
      counter += 1;
      const command = input.command === "bash" ? "/bin/bash" : input.command;
      return await runChildProcess(`claude-acp-sandbox-run-${counter}`, command, input.args ?? [], {
        cwd: input.cwd ?? process.cwd(),
        env: input.env ?? {},
        stdin: input.stdin,
        timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
        graceSec: 5,
        onLog: input.onLog ?? (async () => {}),
      });
    },
  };
}

type FakeRuntimeOptions = Record<string, unknown>;
type FakeRuntimeEvent = { type: string; text?: string; stream?: string; tag?: string };
type FakeRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
};
type FakeRuntimeTurnResult = { status: "completed" | "failed" | "cancelled"; stopReason?: string };
type FakeRuntimeTurn = {
  requestId: string;
  events: AsyncIterable<FakeRuntimeEvent>;
  result: Promise<FakeRuntimeTurnResult>;
  cancel: () => Promise<void>;
  closeStream: () => Promise<void>;
};

// The ACP engine never runs on a Claude subscription; it needs an API key.
const ACP_API_KEY_ENV = { ANTHROPIC_API_KEY: "sk-ant-acp-fixture" };

const tempRoots: string[] = [];
const originalNodeVersion = process.version;
const originalEnv: Record<string, string | undefined> = {
  PAPERCLIP_HOME: process.env.PAPERCLIP_HOME,
  PAPERCLIP_INSTANCE_ID: process.env.PAPERCLIP_INSTANCE_ID,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

function setNodeVersion(version: string): void {
  Object.defineProperty(process, "version", {
    configurable: true,
    enumerable: true,
    value: version,
  });
}

afterEach(async () => {
  setNodeVersion(originalNodeVersion);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The sandbox process-session bridge writes event files asynchronously; on slow
  // CI shards a final write can race the recursive rm (ENOTEMPTY on the events
  // dir), so let fs.rm retry until the writer has quiesced.
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  );
});

class FakeRuntime {
  ensureInputs: Array<{
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
  }> = [];
  startInputs: Array<{ handle: FakeRuntimeHandle; text: string; requestId: string; timeoutMs?: number }> = [];
  closeInputs: Array<{ handle: FakeRuntimeHandle; reason: string; discardPersistentState?: boolean }> = [];
  setConfigInputs: Array<{ handle: FakeRuntimeHandle; key: string; value: string }> = [];
  ensureCount = 0;

  constructor(
    readonly options: FakeRuntimeOptions,
    readonly events: FakeRuntimeEvent[] = [
      { type: "text_delta", text: "hello", stream: "output", tag: "agent_message_chunk" },
    ],
    readonly terminal: FakeRuntimeTurnResult = { status: "completed", stopReason: "end_turn" },
  ) {}

  async ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
  }): Promise<FakeRuntimeHandle> {
    this.ensureInputs.push(input);
    this.ensureCount += 1;
    return {
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime-${this.ensureCount}`,
      cwd: input.cwd,
      acpxRecordId: `record-${this.ensureCount}`,
      backendSessionId: `acp-${this.ensureCount}`,
      agentSessionId: `agent-${this.ensureCount}`,
    };
  }

  startTurn(input: {
    handle: FakeRuntimeHandle;
    text: string;
    requestId: string;
    timeoutMs?: number;
  }): FakeRuntimeTurn {
    this.startInputs.push(input);
    const events = this.events;
    const terminal = this.terminal;
    return {
      requestId: input.requestId,
      events: {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) yield event;
        },
      },
      result: Promise.resolve(terminal),
      cancel: async () => {},
      closeStream: async () => {},
    };
  }

  runTurn(): AsyncIterable<FakeRuntimeEvent> {
    throw new Error("not used");
  }

  getCapabilities() {
    return { controls: [] };
  }

  getStatus() {
    return Promise.resolve({});
  }

  async setConfigOption(input: { handle: FakeRuntimeHandle; key: string; value: string }) {
    this.setConfigInputs.push(input);
  }

  async setMode() {}

  async cancel() {}

  async close(input: { handle: FakeRuntimeHandle; reason: string; discardPersistentState?: boolean }) {
    this.closeInputs.push(input);
  }
}

async function makeTempRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function createRuntimeSkill(root: string) {
  const source = path.join(root, "skills", "review");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\n---\nUse the review skill.\n", "utf8");
  return {
    key: "company/review",
    runtimeName: "review",
    source,
  };
}

function buildContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude ACP",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "PAP-1",
    },
    config: {
      engine: "acp",
      env: ACP_API_KEY_ENV,
      cwd: root,
      stateDir: path.join(root, "state"),
      promptTemplate: "Do the assigned work.",
    },
    context: {
      issueId: "issue-1",
      paperclipTaskMarkdown: "Task context",
      paperclipWorkspace: {
        cwd: root,
        source: "project_workspace",
        workspaceId: "workspace-1",
      },
    },
    onLog: async () => {},
    ...overrides,
  };
}

describe("claude_local ACP lane", () => {
  it("uses the same default model in ACP startup and session identity", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-default-");
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });
    const result = await execute(buildContext(root, {
      onMeta: async (payload) => { meta.push(payload); },
    }));
    expect(result.exitCode).toBe(0);
    expect(meta[0]?.env?.ANTHROPIC_MODEL).toBe("claude-opus-5");
  });

  it("keeps ACP model precedence consistent with CLI and provider overrides", () => {
    expect(buildClaudeAcpConfig({ model: "claude-sonnet-4-5", env: { ANTHROPIC_MODEL: "opus" } }))
      .toMatchObject({ model: "claude-sonnet-4-5", env: { ANTHROPIC_MODEL: "claude-sonnet-4-5" } });
    expect(buildClaudeAcpConfig({}, { ANTHROPIC_MODEL: "custom-model" }))
      .toMatchObject({ model: "custom-model", env: { ANTHROPIC_MODEL: "custom-model" } });
    expect(buildClaudeAcpConfig({}, { CLAUDE_CODE_USE_BEDROCK: "1" }).model).toBe("");
    expect(buildClaudeAcpConfig({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }).model).toBe("");
  });

  it("maps Claude config to the ACPX Claude target", () => {
    expect(buildClaudeAcpConfig({
      engine: "acp",
      cwd: "/repo",
      model: "claude-opus-4-7",
      effort: "high",
      agentCommand: "custom-claude-acp",
      warmHandleIdleMs: 25,
    })).toMatchObject({
      agent: "claude",
      cwd: "/repo",
      model: "claude-opus-4-7",
      effort: "high",
      agentCommand: "custom-claude-acp",
      mode: "persistent",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      warmHandleIdleMs: 25,
    });
  });

  it("checks the Node version required by the Claude ACP runtime", () => {
    setNodeVersion("v24.10.0");
    expect(nodeVersionMeetsClaudeAcpMinimum()).toBe(false);
    setNodeVersion("v24.11.0");
    expect(nodeVersionMeetsClaudeAcpMinimum()).toBe(true);
  });

  it("defaults to the CLI engine and reports unavailable prerequisites for explicit ACP", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-default-");
    const commandPath = path.join(root, "bin", "claude-agent-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v24.11.0");

    expect(resolveClaudeExecutionEngine({})).toEqual({ engine: "cli", explicit: false });
    expect(resolveClaudeExecutionEngine({ engine: "auto" })).toEqual({ engine: "cli", explicit: false });
    expect(resolveClaudeExecutionEngine({ engine: " ACP " })).toEqual({ engine: "acp", explicit: true });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: false });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "cli", agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: true });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", agentCommand: commandPath, env: ACP_API_KEY_ENV },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: true });

    setNodeVersion("v24.10.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: false });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", agentCommand: "/missing/claude-agent-acp", env: ACP_API_KEY_ENV },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({ engine: "acp", explicit: true, unavailableReason: expect.stringContaining("Node") });
  });

  it("keeps local filesystem or network scope on the default CLI engine and rejects it for explicit ACP", async () => {
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { filesystemScope: "workspace" },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: false });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { networkScope: "deny" },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: false });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", filesystemScope: "workspace", env: ACP_API_KEY_ENV },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({ engine: "acp", unavailableReason: expect.stringContaining("ACP confinement is not supported") });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", networkScope: "deny", env: ACP_API_KEY_ENV },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "acp",
      explicit: true,
      unavailableReason: expect.stringContaining("confinement"),
    });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", networkScope: "public", env: ACP_API_KEY_ENV },
        executionTarget: null,
      }),
    ).rejects.toThrow('networkScope must be "deny" or "allowlist"');
  });

  it("uses ACP for bridged sandbox runs with an API key when the ACP command is configured as a shell command", async () => {
    setNodeVersion("v24.11.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", agentCommand: "claude-agent-acp", env: ACP_API_KEY_ENV },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd: "/work",
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
        },
      }),
    ).resolves.toEqual({ engine: "acp", explicit: true });
  });

  it("reports unavailable ACP for one-shot sandbox runs", async () => {
    setNodeVersion("v24.11.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", env: ACP_API_KEY_ENV },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd: "/work",
        },
      }),
    ).resolves.toMatchObject({
      engine: "acp",
      explicit: true,
      unavailableReason: expect.stringContaining("bidirectional remote process"),
    });
  });

  it("reports unavailable ACP for non-sandbox remote runs", async () => {
    setNodeVersion("v24.11.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", env: ACP_API_KEY_ENV },
        executionTarget: {
          kind: "remote",
          transport: "ssh",
          remoteCwd: "/work",
          spec: {
            host: "127.0.0.1",
            port: 22,
            username: "fixture",
            remoteCwd: "/work",
            remoteWorkspacePath: "/work",
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          },
        },
      }),
    ).resolves.toMatchObject({
      engine: "acp",
      explicit: true,
      unavailableReason: expect.stringContaining("sandbox remote targets only"),
    });
  });

  it("requires an API key for ACP before any other prerequisite, locally and on remote targets", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      setNodeVersion("v24.10.0");
      await expect(
        resolveClaudeExecutionEngineForRun({
          config: { engine: "acp", env: { CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" } },
          executionTarget: null,
        }),
      ).resolves.toEqual({
        engine: "acp",
        explicit: true,
        unavailableReason:
          "The Claude ACP engine needs an Anthropic API key. Use engine=cli to run with the claude CLI signed in on this server.",
      });
      await expect(
        resolveClaudeExecutionEngineForRun({
          config: { engine: "acp" },
          executionTarget: { kind: "remote", transport: "sandbox", providerKey: "fake-plugin", remoteCwd: "/work" },
        }),
      ).resolves.toMatchObject({
        unavailableReason:
          "Claude on remote targets needs an Anthropic API key; subscription use is limited to the claude CLI signed in on this server.",
      });
      await expect(
        resolveClaudeExecutionEngineForRun({
          config: { engine: "acp", env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
          executionTarget: null,
        }),
      ).resolves.toMatchObject({ unavailableReason: expect.stringContaining("Node") });
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("refuses to launch the ACP executor without an API key, even when called directly", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const root = await makeTempRoot("paperclip-claude-acp-nokey-");
      const createRuntime = vi.fn((options: FakeRuntimeOptions) => new FakeRuntime(options) as never);
      const execute = createClaudeAcpExecutor({ createRuntime });
      const logs: string[] = [];
      const base = buildContext(root);
      const result = await execute({
        ...base,
        config: { ...base.config, env: { CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" } },
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });
      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "adapter_engine_unavailable",
        errorMessage:
          "The Claude ACP engine needs an Anthropic API key. Use engine=cli to run with the claude CLI signed in on this server.",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      });
      expect(createRuntime).not.toHaveBeenCalled();
      expect(logs.join("")).toContain("needs an Anthropic API key");
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("never forwards a subscription token into the ACP config", () => {
    const acpConfig = buildClaudeAcpConfig({
      env: { ANTHROPIC_API_KEY: "sk-ant-acp", CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" },
    });
    expect(acpConfig.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-acp" });
    expect(acpConfig.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    const bedrockConfig = buildClaudeAcpConfig({
      env: { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" },
    });
    expect(bedrockConfig.model).toBe("");
    expect(bedrockConfig.env).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  it.each([undefined, "/sandbox/configured-workspace"])("checks sandbox directories on the sandbox (configured cwd=%s)", async (configuredCwd) => {
    const remoteCwd = "/sandbox/workspace";
    const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("Host filesystem must not be used"));
    const execute = vi.fn(async () => ({
      exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
      pid: null, startedAt: new Date().toISOString(),
    }));
    try {
      const result = await testClaudeAcpEnvironment({
        companyId: "company-1", adapterType: "claude_local",
        config: { cwd: configuredCwd, agentCommand: "claude-agent-acp", env: { ANTHROPIC_API_KEY: "fixture" } },
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd, runner: { execute } },
      });
      expect(result.status, JSON.stringify(result.checks)).toBe("pass");
      expect(result.checks).toContainEqual(expect.objectContaining({
        code: "claude_acp_cwd_valid", message: `Working directory is valid: ${configuredCwd ?? remoteCwd}`,
      }));
      expect(mkdir).not.toHaveBeenCalled();
      expect(JSON.stringify(execute.mock.calls)).toContain(`mkdir -p '${configuredCwd ?? remoteCwd}'`);
    } finally { mkdir.mockRestore(); }
  });

  it("reports ACP prerequisites for the ACP lane", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-env-");
    const commandPath = path.join(root, "bin", "claude-agent-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v24.11.0");

    // The ACP lane needs an API credential. Give the config a Bedrock credential
    // so the result reflects only the ACP prerequisites and the lane reports a
    // pass.
    const result = await testClaudeAcpEnvironment({
      adapterType: "claude_local",
      companyId: "company-1",
      config: {
        engine: "acp",
        cwd: root,
        agentCommand: commandPath,
        env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_engine_selected",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_acp_command_resolvable",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_acp_bedrock_auth",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_acp_runtime_scaffold",
        level: "info",
      }),
    );
  });

  it("executes through ACPX with Claude model env, settings.local.json, and ephemeral skills", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-exec-");
    const skill = await createRuntimeSkill(root);
    const runtimes: FakeRuntime[] = [];
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(buildContext(root, {
      config: {
        engine: "acp",
        env: ACP_API_KEY_ENV,
        cwd: root,
        stateDir: path.join(root, "state"),
        model: "claude-opus-4-7",
        effort: "high",
        promptTemplate: "Do the assigned work.",
        paperclipRuntimeSkills: [skill],
        paperclipSkillSync: { desiredSkills: [skill.key] },
      },
      onMeta: async (payload: AdapterInvocationMeta) => {
        meta.push(payload);
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toMatchObject({
      agent: "claude",
      mode: "persistent",
      acpSessionId: "acp-1",
      workspaceId: "workspace-1",
    });
    expect(result.sessionParams?.skills).toMatchObject({
      mode: "claude",
      selectedSkills: ["review"],
    });
    const skillRoot = (result.sessionParams?.skills as { skillRoot?: string }).skillRoot;
    expect(skillRoot).toBeTruthy();
    await expect(fs.readFile(path.join(skillRoot!, "review", "SKILL.md"), "utf8")).resolves.toContain("review skill");
    expect(runtimes[0]?.setConfigInputs.map((input) => [input.key, input.value])).toEqual([["effort", "high"]]);
    expect(meta[0]?.commandNotes?.join("\n")).toContain("set via ANTHROPIC_MODEL");
    expect(meta[0]?.env?.ANTHROPIC_MODEL).toBe("claude-opus-4-7");
    const settings = JSON.parse(await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"));
    expect(settings.permissions.defaultMode).toBe("default");
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(["Bash(curl:*)", "Bash(env)"]));
  });

  it("stages the skill bundle as a no-follow-symlinks asset for a remote ACP run, and points the prompt at the in-sandbox skill root", async () => {
    vi.mocked(prepareAdapterExecutionTargetRuntime).mockClear();
    const root = await makeTempRoot("paperclip-claude-acp-skills-remote-");
    const skill = await createRuntimeSkill(root);
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });

    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          env: ACP_API_KEY_ENV,
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          paperclipRuntimeSkills: [skill],
          paperclipSkillSync: { desiredSkills: [skill.key] },
        },
        context: {
          issueId: "issue-1",
          paperclipTaskMarkdown: "Task context",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
      }),
    );

    expect(result.exitCode).toBe(0);

    // The real seam sent the bundle to the shared staging call with
    // `followSymlinks: false`: the bundle holds a plain copy of each skill's
    // files, so staging never needs to carry a symbolic link's target
    // content, and a link planted in the bundle after materialization must
    // not cross into the sandbox.
    const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
    const skillsAsset = stageArgs.assets?.find((asset) => asset.key === "skills");
    expect(skillsAsset).toMatchObject({ followSymlinks: false });

    // The prompt names the in-sandbox skill root, not the host bundle dir...
    const prompt = String(runtimes[0]?.startInputs[0]?.text ?? "");
    const skillRootMatch = prompt.match(/Skill root: (\S+)/);
    expect(skillRootMatch).toBeTruthy();
    const inSandboxSkillRoot = skillRootMatch![1]!;
    expect(inSandboxSkillRoot).not.toBe(skillsAsset!.localDir);
    expect(prompt).not.toContain(String(skillsAsset!.localDir));
    // ...and it really landed there (local runner extracts to the asset dir).
    await expect(
      fs.readFile(path.join(inSandboxSkillRoot, "review", "SKILL.md"), "utf8"),
    ).resolves.toContain("review skill");
  });

  it("stages no skills asset for a remote ACP run with no selected skill", async () => {
    vi.mocked(prepareAdapterExecutionTargetRuntime).mockClear();
    const root = await makeTempRoot("paperclip-claude-acp-skills-remote-empty-");
    // An available-but-undesired skill, so the run resolves a real (empty)
    // selection instead of falling back to the package's own default skill
    // set (that fallback only fires when `paperclipRuntimeSkills` is absent).
    const skill = await createRuntimeSkill(root);
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });

    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          env: ACP_API_KEY_ENV,
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          paperclipRuntimeSkills: [skill],
          paperclipSkillSync: { desiredSkills: [] },
        },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
      }),
    );

    expect(result.exitCode).toBe(0);
    const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
    expect((stageArgs.assets ?? []).some((asset) => asset.key === "skills")).toBe(false);
    expect(String(runtimes[0]?.startInputs[0]?.text ?? "")).not.toContain("Skill root:");
  });

  it("stages the skill bundle inside the sandbox but never syncs it back into the host workspace", async () => {
    // The staged skill bundle lives under `.paperclip-runtime/claude/skills`,
    // inside the same in-sandbox directory the workspace restore reads. The
    // restore excludes the whole `.paperclip-runtime` tree
    // (`sandbox-managed-runtime.ts`'s `restoreExclude` list) for every asset
    // key alike, so this proves it for the new "skills" asset specifically.
    const root = await makeTempRoot("paperclip-claude-acp-skills-no-syncback-");
    const skill = await createRuntimeSkill(root);
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");

    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          env: ACP_API_KEY_ENV,
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          paperclipRuntimeSkills: [skill],
          paperclipSkillSync: { desiredSkills: [skill.key] },
        },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
      }),
    );

    expect(result.exitCode).toBe(0);
    // Positive control: the bundle really did land in the sandbox stand-in
    // during the run, under the in-sandbox skill root the prompt names.
    const prompt = String(runtimes[0]?.startInputs[0]?.text ?? "");
    const inSandboxSkillRoot = prompt.match(/Skill root: (\S+)/)![1]!;
    expect(inSandboxSkillRoot).toContain(path.join(remoteCwd, ".paperclip-runtime"));
    await expect(
      fs.readFile(path.join(inSandboxSkillRoot, "review", "SKILL.md"), "utf8"),
    ).resolves.toContain("review skill");
    // After the run's workspace restore, the host worktree carries the file the
    // run wrote inside the workspace proper...
    await expect(fs.readFile(path.join(localCwd, "hello.txt"), "utf8")).resolves.toBe("hi");
    // ...but not the staged runtime directory the skill bundle staged into.
    await expect(fs.access(path.join(localCwd, ".paperclip-runtime"))).rejects.toThrow();
  });

  it("passes the exact configured Fable 5.1 ID through ANTHROPIC_MODEL on the ACP lane", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-fable51-");
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });

    const result = await execute(buildContext(root, {
      config: {
        engine: "acp",
        env: ACP_API_KEY_ENV,
        cwd: root,
        stateDir: path.join(root, "state"),
        model: "claude-fable-5-1",
        promptTemplate: "Do the assigned work.",
      },
      onMeta: async (payload: AdapterInvocationMeta) => {
        meta.push(payload);
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(meta[0]?.env?.ANTHROPIC_MODEL).toBe("claude-fable-5-1");
  });

  it("creates the ACP session on the in-sandbox workspace cwd for runner-backed remote runs", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-remote-cwd-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");

    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          env: ACP_API_KEY_ENV,
          cwd: localCwd,
          // Throwaway ACP command so the process-session bridge does not require
          // a real claude-agent-acp binary in the local sandbox stand-in.
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
        },
        context: {
          issueId: "issue-1",
          paperclipTaskMarkdown: "Task context",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
      }),
    );

    expect(result.exitCode).toBe(0);
    await expect(fs.readFile(path.join(remoteCwd, "hello.txt"), "utf8")).resolves.toBe("hi");
    expect(runtimes[0]?.ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(runtimes[0]?.ensureInputs[0]?.cwd).not.toBe(localCwd);
  });

  it("seeds the managed Claude config into the sandbox and repoints CLAUDE_CONFIG_DIR to the in-sandbox path", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-home-seed-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sharedClaudeConfig = path.join(root, "shared-claude-config");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sharedClaudeConfig, { recursive: true });
    // Host shared Claude config the seed is built from.
    await fs.writeFile(
      path.join(sharedClaudeConfig, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
      "utf8",
    );
    await fs.writeFile(path.join(sharedClaudeConfig, "CLAUDE.md"), "# shared guidance\n", "utf8");
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    process.env.CLAUDE_CONFIG_DIR = sharedClaudeConfig;

    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });
    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          env: ACP_API_KEY_ENV,
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
        },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
        onMeta: async (payload: AdapterInvocationMeta) => {
          meta.push(payload);
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    const remappedConfigDir = String(meta[0]?.env?.CLAUDE_CONFIG_DIR ?? "");
    // C2 — CLAUDE_CONFIG_DIR repointed onto an in-sandbox path, distinct from the
    // host shared config dir.
    expect(remappedConfigDir).not.toBe(sharedClaudeConfig);
    expect(remappedConfigDir).toContain(".paperclip-runtime");
    expect(remappedConfigDir.endsWith("/config")).toBe(true);
    // Seeded: settings.json was materialized into the in-sandbox config dir (the
    // local runner uses the host FS, so this is a real host path).
    await expect(fs.readFile(path.join(remappedConfigDir, "settings.json"), "utf8")).resolves.toContain(
      "permissions",
    );
    // C4 — no XDG_* variable is introduced for in-sandbox credential discovery.
    expect(Object.keys(meta[0]?.env ?? {}).filter((key) => key.startsWith("XDG_"))).toEqual([]);
  });

  it("test_claude_acp_seam_registers_workspace_sync_back", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-syncback-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sharedClaudeConfig = path.join(root, "shared-claude-config");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sharedClaudeConfig, { recursive: true });
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
    await fs.writeFile(
      path.join(sharedClaudeConfig, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
      "utf8",
    );
    await fs.writeFile(path.join(sharedClaudeConfig, "CLAUDE.md"), "# shared guidance\n", "utf8");
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    process.env.CLAUDE_CONFIG_DIR = sharedClaudeConfig;

    // The runtime writes a NEW file into the in-sandbox workspace during the turn.
    // The seam must register a workspace sync-back teardown, so the file lands in
    // the host worktree after the run.
    const runtime = new FakeRuntime({});
    const startTurn = runtime.startTurn.bind(runtime);
    runtime.startTurn = (input) => {
      const turn = startTurn(input);
      const remoteWorkspaceCwd = input.handle.cwd ?? remoteCwd;
      return {
        ...turn,
        result: (async () => {
          await fs.writeFile(path.join(remoteWorkspaceCwd, "from-sandbox.txt"), "synced", "utf8");
          return await turn.result;
        })(),
      };
    };

    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        Object.assign(runtime.options, options);
        return runtime as never;
      },
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          env: ACP_API_KEY_ENV,
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
        },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
      }),
    );

    expect(result.exitCode).toBe(0);
    // The teardown fired `restoreWorkspace`, so the sandbox-authored file is now
    // in the host worktree.
    await expect(fs.readFile(path.join(localCwd, "from-sandbox.txt"), "utf8")).resolves.toBe("synced");
  });

  it("test_claude_acp_teardown_restore_failure_sanitizes_the_run_log", async () => {
    // Security regression for a workspace-restore write failure: the run log
    // is readable by any same-company actor, so the teardown must never write
    // the caught error's own message there — that message can carry the host
    // workspace path. Force a real EACCES by making the workspace read-only,
    // and name it with a sentinel marker so any leak is easy to spot.
    const root = await makeTempRoot("paperclip-claude-acp-restore-failure-");
    const localCwd = path.join(root, "SENTINEL-HOST-PATH-marker", "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";

    // The runtime writes a new file into the in-sandbox workspace during the
    // turn, so the teardown's restore has something to copy back — and a new
    // file is exactly what a read-only workspace directory rejects. The
    // workspace turns read-only only after the turn's own writes (settings
    // seeded at startup, the sandbox-authored file) — the teardown restore
    // that runs after the turn is the write this test forces to fail.
    const runtime = new FakeRuntime({});
    const startTurn = runtime.startTurn.bind(runtime);
    runtime.startTurn = (input) => {
      const turn = startTurn(input);
      const remoteWorkspaceCwd = input.handle.cwd ?? remoteCwd;
      return {
        ...turn,
        result: (async () => {
          await fs.writeFile(path.join(remoteWorkspaceCwd, "from-sandbox.txt"), "synced", "utf8");
          await fs.chmod(localCwd, 0o500);
          return await turn.result;
        })(),
      };
    };

    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        Object.assign(runtime.options, options);
        return runtime as never;
      },
    });

    const loggedLines: string[] = [];
    try {
      const result = await execute(
        buildContext(localCwd, {
          config: {
            engine: "acp",
            env: ACP_API_KEY_ENV,
            cwd: localCwd,
            agentCommand: "node ./fake-acp.js",
            stateDir: path.join(root, "state"),
            promptTemplate: "Do the assigned work.",
          },
          context: {
            issueId: "issue-1",
            paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
          },
          executionTarget: {
            kind: "remote",
            transport: "sandbox",
            providerKey: "fake-plugin",
            remoteCwd,
            runner: createLocalSandboxRunner(),
          } as never,
          authToken: "real-run-jwt",
          onLog: async (_stream, chunk) => {
            loggedLines.push(chunk);
          },
        }),
      );

      // Preserve the execution's exit code while reporting the restore failure.
      // Only a fixed diagnostic may contain the errno, never the raw error.
      expect(result.exitCode).toBe(0);
      expect(result.resultJson?.workspaceRestoreFailure).toBe("restore_permission_denied");
      const allLogs = loggedLines.join("");
      expect(allLogs).not.toContain("SENTINEL-HOST-PATH-marker");
      expect(allLogs).not.toContain(localCwd);
      const diagnostic = '[paperclip] Workspace restore diagnostic: {"phase":"workspace","errorCode":"EACCES"}\n';
      expect(loggedLines.filter((line) => line.includes("Workspace restore diagnostic:"))).toEqual([diagnostic]);
      expect(loggedLines.filter((line) => line !== diagnostic).join("")).not.toContain("EACCES");
      expect(allLogs).toContain("permission denied");
    } finally {
      await fs.chmod(localCwd, 0o700).catch(() => undefined);
    }
  });

  it("ignores an explicit CLAUDE_CONFIG_DIR inside the workspace and never stages or syncs back its sign-in files", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-explicit-inworkspace-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    // Operator pins a config dir that lives INSIDE the workspace cwd and holds a
    // Claude sign-in. The remote lane runs only on an API key: the dir is not
    // used as the remote config dir, and its sign-in files never enter the
    // sandbox or come back from it.
    const operatorConfigDir = path.join(localCwd, ".claude-config");
    await fs.mkdir(operatorConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(operatorConfigDir, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
      "utf8",
    );
    await fs.writeFile(path.join(operatorConfigDir, ".credentials.json"), "host-sign-in", "utf8");
    await fs.writeFile(path.join(operatorConfigDir, "credentials.json"), "host-sign-in-2", "utf8");
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";

    const stagedCredentialFiles: string[] = [];
    const runtime = new FakeRuntime({});
    const startTurn = runtime.startTurn.bind(runtime);
    runtime.startTurn = (input) => {
      const turn = startTurn(input);
      const remoteWorkspaceCwd = input.handle.cwd ?? remoteCwd;
      return {
        ...turn,
        result: (async () => {
          for (const name of [".credentials.json", "credentials.json"]) {
            const staged = path.join(remoteWorkspaceCwd, ".claude-config", name);
            if (await fs.stat(staged).then(() => true, () => false)) stagedCredentialFiles.push(name);
          }
          // A sign-in written in the sandbox never syncs back to the host.
          await fs.mkdir(path.join(remoteWorkspaceCwd, ".claude-config"), { recursive: true });
          await fs.writeFile(path.join(remoteWorkspaceCwd, ".claude-config", ".credentials.json"), "sandbox-sign-in", "utf8");
          await fs.writeFile(path.join(remoteWorkspaceCwd, ".claude-config", "credentials.json"), "sandbox-sign-in", "utf8");
          await fs.writeFile(path.join(remoteWorkspaceCwd, "from-sandbox.txt"), "synced", "utf8");
          return await turn.result;
        })(),
      };
    };

    const meta: AdapterInvocationMeta[] = [];
    const logs: string[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        Object.assign(runtime.options, options);
        return runtime as never;
      },
    });
    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          env: { ...ACP_API_KEY_ENV, CLAUDE_CONFIG_DIR: operatorConfigDir },
        },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
          logs.push(chunk);
        },
        onMeta: async (payload: AdapterInvocationMeta) => {
          meta.push(payload);
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    // Not remapped onto the in-sandbox workspace: the managed config is seeded instead.
    const remoteConfigDir = String(meta[0]?.env?.CLAUDE_CONFIG_DIR ?? "");
    expect(remoteConfigDir).not.toBe(operatorConfigDir);
    expect(remoteConfigDir).not.toBe(path.posix.join(remoteCwd, ".claude-config"));
    expect(remoteConfigDir).toContain(".paperclip-runtime");
    expect(logs.join("")).toContain("is inside the staged workspace; ignoring it on the remote target");
    expect(logs.join("")).not.toContain("Remapped operator CLAUDE_CONFIG_DIR");
    // Never staged into the sandbox.
    expect(stagedCredentialFiles).toEqual([]);
    // Never synced back: the host sign-in files are untouched, other changes land.
    await expect(fs.readFile(path.join(operatorConfigDir, ".credentials.json"), "utf8")).resolves.toBe("host-sign-in");
    await expect(fs.readFile(path.join(operatorConfigDir, "credentials.json"), "utf8")).resolves.toBe("host-sign-in-2");
    await expect(fs.readFile(path.join(localCwd, "from-sandbox.txt"), "utf8")).resolves.toBe("synced");
  });

  it("ignores a host-only explicit CLAUDE_CONFIG_DIR that cannot reach the sandbox and seeds the managed config instead", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-explicit-hostonly-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sharedClaudeConfig = path.join(root, "shared-claude-config");
    // An operator-pinned config dir OUTSIDE the workspace cwd: a host-only path the
    // sandbox cannot reach, so it must not be forwarded verbatim.
    const operatorConfigDir = path.join(root, "operator-claude-config");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sharedClaudeConfig, { recursive: true });
    // Host shared Claude config the managed seed is built from.
    await fs.writeFile(
      path.join(sharedClaudeConfig, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
      "utf8",
    );
    await fs.writeFile(path.join(sharedClaudeConfig, "CLAUDE.md"), "# shared guidance\n", "utf8");
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    process.env.CLAUDE_CONFIG_DIR = sharedClaudeConfig;

    const meta: AdapterInvocationMeta[] = [];
    const logs: string[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });
    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          // Explicit user-managed CLAUDE_CONFIG_DIR (adapter config env, not a host
          // env leak) pointing at a host-only path.
          env: { ...ACP_API_KEY_ENV, CLAUDE_CONFIG_DIR: operatorConfigDir },
        },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
          logs.push(chunk);
        },
        onMeta: async (payload: AdapterInvocationMeta) => {
          meta.push(payload);
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    const remappedConfigDir = String(meta[0]?.env?.CLAUDE_CONFIG_DIR ?? "");
    // The un-portable host path is dropped; managed config is seeded in-sandbox.
    expect(remappedConfigDir).not.toBe(operatorConfigDir);
    expect(remappedConfigDir).toContain(".paperclip-runtime");
    expect(remappedConfigDir.endsWith("/config")).toBe(true);
    await expect(fs.readFile(path.join(remappedConfigDir, "settings.json"), "utf8")).resolves.toContain(
      "permissions",
    );
    // Observability: the un-portable override is flagged so the substitution is diagnosable.
    expect(logs.join("")).toContain(
      `operator-provided CLAUDE_CONFIG_DIR=${operatorConfigDir} is outside the staged workspace`,
    );
  });

  it("reports unavailable ACP for a runner-less sandbox even when the ACP command is set", async () => {
    setNodeVersion("v24.11.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", agentCommand: "claude-agent-acp", env: ACP_API_KEY_ENV },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd: "/work",
        },
      }),
    ).resolves.toMatchObject({
      engine: "acp",
      explicit: true,
      unavailableReason: expect.stringContaining("bidirectional remote process"),
    });
  });

  it("delivers the issue description exactly once per prompt and compacts non-assignment resume deltas", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-brief-");
    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const description = "Update launch-card.svg and change the CTA to Try Team free.";
    const fullTaskMarkdown = [
      "Paperclip task context:",
      "- Issue: \"PAP-15271\"",
      "- Title: \"Preserve the task brief\"",
      "",
      "Issue description:",
      "```text",
      description,
      "```",
    ].join("\n");
    const compactTaskMarkdown = [
      "Paperclip task context:",
      "- Issue: \"PAP-15271\"",
      "- Title: \"Preserve the task brief\"",
    ].join("\n");
    const wakeContext = (reason: string) => ({
      issueId: "issue-1",
      paperclipTaskMarkdown: fullTaskMarkdown,
      paperclipTaskMarkdownCompact: compactTaskMarkdown,
      paperclipWake: {
        reason,
        issue: {
          id: "issue-1",
          identifier: "PAP-15271",
          title: "Preserve the task brief",
          description,
          descriptionTruncated: false,
          status: "in_progress",
        },
        commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
        comments: [],
        fallbackFetchNeeded: false,
      },
      paperclipWorkspace: {
        cwd: root,
        source: "project_workspace",
        workspaceId: "workspace-1",
      },
    });

    const first = await execute(buildContext(root, { context: wakeContext("issue_assigned") }));
    const freshPrompt = runtimes[0]?.startInputs[0]?.text ?? "";
    expect(freshPrompt.split(description)).toHaveLength(2);
    expect(freshPrompt).toContain("Paperclip task context:");

    const second = await execute(buildContext(root, {
      runtime: {
        sessionId: first.sessionId ?? null,
        sessionParams: first.sessionParams ?? null,
        sessionDisplayId: first.sessionDisplayId ?? null,
        taskKey: "PAP-1",
      },
      context: wakeContext("issue_commented"),
    }));
    expect(second.exitCode).toBe(0);
    const resumePrompt = runtimes[1]?.startInputs[0]?.text ?? "";
    expect(resumePrompt).not.toContain(description);
    expect(resumePrompt).toContain("Paperclip task context:");
    expect(resumePrompt).toContain(
      "- issue description: omitted from this resume delta; fetch the issue if you need the latest brief",
    );
  });

  it("resumes compatible ACP sessions on later Claude ACP runs", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-resume-");
    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const first = await execute(buildContext(root));
    const second = await execute(buildContext(root, {
      runtime: {
        sessionId: first.sessionId ?? null,
        sessionParams: first.sessionParams ?? null,
        sessionDisplayId: first.sessionDisplayId ?? null,
        taskKey: "PAP-1",
      },
    }));

    expect(second.exitCode).toBe(0);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1]?.ensureInputs[0]?.resumeSessionId).toBe("acp-1");
  });
});

describe("resolveClaudeAcpBillingIdentity", () => {
  const HOST_KEYS = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ] as const;
  const originalHostEnv = Object.fromEntries(HOST_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    for (const key of HOST_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of HOST_KEYS) {
      const original = originalHostEnv[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it("classifies an adapter-config API key as api billing", () => {
    expect(
      resolveClaudeAcpBillingIdentity({ config: { env: { ANTHROPIC_API_KEY: "sk-ant-test" } } }),
    ).toEqual({ provider: "anthropic", biller: "anthropic", billingType: "api" });
  });

  it("classifies Bedrock auth as metered_api billed to aws_bedrock", () => {
    expect(
      resolveClaudeAcpBillingIdentity({ config: { env: { CLAUDE_CODE_USE_BEDROCK: "1" } } }),
    ).toEqual({ provider: "anthropic", biller: "aws_bedrock", billingType: "metered_api" });
  });

  it.each([
    ["a gateway ANTHROPIC_AUTH_TOKEN with no base URL", { ANTHROPIC_AUTH_TOKEN: "gateway-token" }, "anthropic"],
    [
      "an OpenRouter gateway token",
      { ANTHROPIC_AUTH_TOKEN: "sk-or-token", ANTHROPIC_BASE_URL: "https://openrouter.ai/api" },
      "openrouter",
    ],
    [
      "a LiteLLM gateway token",
      { ANTHROPIC_AUTH_TOKEN: "litellm-token", ANTHROPIC_BASE_URL: "https://litellm.internal.example:4000" },
      "unknown",
    ],
    ["Vertex", { CLAUDE_CODE_USE_VERTEX: "1" }, "google"],
    ["Foundry", { CLAUDE_CODE_USE_FOUNDRY: "true" }, "azure"],
  ])("classifies %s as metered_api, never subscription, and bills the right biller", (_label, env, biller) => {
    expect(resolveClaudeAcpBillingIdentity({ config: { env } })).toEqual({
      provider: "anthropic",
      biller,
      billingType: "metered_api",
    });
  });

  it("does not treat ANTHROPIC_BEDROCK_BASE_URL alone as Bedrock", () => {
    expect(
      resolveClaudeAcpBillingIdentity({
        config: {
          env: {
            ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com",
            ANTHROPIC_API_KEY: "sk-ant-test",
          },
        },
      }),
    ).toEqual({ provider: "anthropic", biller: "anthropic", billingType: "api" });
    process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://bedrock-runtime.us-east-1.amazonaws.com";
    expect(
      resolveClaudeAcpBillingIdentity({ config: { env: { ANTHROPIC_API_KEY: "sk-ant-test" } } }),
    ).toEqual({ provider: "anthropic", biller: "anthropic", billingType: "api" });
  });

  it("ignores a host-only Vertex or Foundry flag, which the ACP child never inherits", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    expect(
      resolveClaudeAcpBillingIdentity({ config: { env: { ANTHROPIC_API_KEY: "sk-ant-test" } } }),
    ).toEqual({ provider: "anthropic", biller: "anthropic", billingType: "api" });
  });

  it("reads a gateway ANTHROPIC_AUTH_TOKEN from the host env for a local target", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token";
    expect(resolveClaudeAcpBillingIdentity({ config: {} }).billingType).toBe("metered_api");
  });

  it("does not count a subscription OAuth token in ANTHROPIC_AUTH_TOKEN as a gateway credential", () => {
    expect(
      resolveClaudeAcpBillingIdentity({ config: { env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-subscription" } } })
        .billingType,
    ).toBe("unknown");
  });

  it("labels a run without a detectable credential unknown, never subscription", () => {
    expect(resolveClaudeAcpBillingIdentity({ config: {} })).toEqual({
      provider: "anthropic",
      biller: "anthropic",
      billingType: "unknown",
    });
  });

  it("ignores host env for remote execution targets", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-only";
    process.env.ANTHROPIC_AUTH_TOKEN = "gateway-host-only";
    expect(
      resolveClaudeAcpBillingIdentity({
        config: {},
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/work" },
      } as never).billingType,
    ).toBe("unknown");
  });
});

describe("claudeConfigCredentialWorkspaceExcludes", () => {
  it("excludes the sign-in files of each Claude config dir inside the workspace", () => {
    const workspace = path.join(os.tmpdir(), "ws");
    expect(
      claudeConfigCredentialWorkspaceExcludes({
        workspaceLocalDir: workspace,
        configDirs: [
          path.join(workspace, ".claude-config"),
          path.join(workspace, "nested", "claude"),
          path.join(os.tmpdir(), "outside"),
          "relative/path",
          "",
          null,
          undefined,
        ],
      }),
    ).toEqual([
      ".claude-config/.credentials.json",
      ".claude-config/credentials.json",
      "nested/claude/.credentials.json",
      "nested/claude/credentials.json",
    ]);
  });

  it("excludes top-level sign-in files when the config dir is the workspace itself", () => {
    const workspace = path.join(os.tmpdir(), "ws");
    expect(
      claudeConfigCredentialWorkspaceExcludes({ workspaceLocalDir: workspace, configDirs: [workspace] }),
    ).toEqual([".credentials.json", "credentials.json"]);
  });
});
