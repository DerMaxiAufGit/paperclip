/**
 * Only the official claude binary may use a Claude subscription. Pi falls back
 * to a stored Claude login when it has no key, so an Anthropic run needs an
 * Anthropic API key and runs with an agent config dir without auth.json. Runs
 * on other providers are unchanged.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE } from "@paperclipai/adapter-utils/claude-subscription-harness-guard";

const mocks = vi.hoisted(() => ({
  spawns: [] as Array<{ args: string[]; env: Record<string, string>; agentDirEntries: string[] | null }>,
  runSshCommand: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  const { readdir } = await import("node:fs/promises");
  return {
    ...actual,
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "/usr/bin/pi"),
    runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[], opts: { env: Record<string, string> }) => {
      const agentDir = opts.env.PI_CODING_AGENT_DIR;
      const agentDirEntries = agentDir ? (await readdir(agentDir).catch(() => null))?.sort() ?? null : null;
      mocks.spawns.push({ args: [...args], env: { ...opts.env }, agentDirEntries });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "done" }, toolResults: [] }),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    }),
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>();
  return { ...actual, runSshCommand: mocks.runSshCommand };
});

vi.mock("./models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.js")>();
  return { ...actual, ensurePiModelConfiguredAndAvailable: vi.fn(async () => []) };
});

import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const cleanup: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

async function run(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const workspace = await tempDir("paperclip-pi-guard-ws-");
  const logs: Array<[string, string]> = [];
  const result = await execute({
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Pi", adapterType: "pi_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "pi", cwd: workspace, ...config },
    context: {},
    onLog: async (stream: string, chunk: string) => {
      logs.push([stream, chunk]);
    },
    ...extra,
  } as never);
  return { result, logs };
}

beforeEach(async () => {
  mocks.spawns.length = 0;
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("PAPERCLIP_PI_PROVIDERS", "");
  const hostAgentDir = await tempDir("paperclip-pi-guard-host-agent-");
  await fs.writeFile(path.join(hostAgentDir, "auth.json"), '{"anthropic":{"type":"oauth"}}');
  await fs.writeFile(path.join(hostAgentDir, "settings.json"), "{}");
  vi.stubEnv("PI_CODING_AGENT_DIR", hostAgentDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  while (cleanup.length > 0) {
    await fs.rm(cleanup.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("pi_local Claude subscription guard", () => {
  it("refuses an Anthropic model without an API key before starting Pi", async () => {
    const { result, logs } = await run({ model: "anthropic/claude-sonnet-4-5" });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "adapter_engine_unavailable",
      errorMessage: CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE,
      provider: "anthropic",
    });
    expect(mocks.spawns).toEqual([]);
    expect(logs).toContainEqual(["stderr", `[paperclip] ${CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE}\n`]);
  });

  it("refuses when the only Anthropic credential is a subscription token", async () => {
    const { result } = await run({
      model: "anthropic/claude-sonnet-4-5",
      env: { ANTHROPIC_API_KEY: "sk-ant-oat01-fixture", ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-fixture" },
    });

    expect(result.errorMessage).toBe(CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE);
    expect(mocks.spawns).toEqual([]);
  });

  it("runs an Anthropic model with an API key and hides Pi's stored logins", async () => {
    const { result } = await run({
      model: "anthropic/claude-sonnet-4-5",
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" },
    });

    expect(result.errorMessage ?? null).toBeNull();
    expect(mocks.spawns).toHaveLength(1);
    const { env, agentDirEntries } = mocks.spawns[0]!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-fixture");
    expect(env.PI_CODING_AGENT_DIR).not.toBe(process.env.PI_CODING_AGENT_DIR);
    expect(agentDirEntries).toEqual(["settings.json"]);
  });

  it("accepts a gateway ANTHROPIC_AUTH_TOKEN, which Pi sends as a bearer token", async () => {
    const { result } = await run({
      model: "anthropic/claude-sonnet-4-5",
      env: { ANTHROPIC_AUTH_TOKEN: "gateway-token" },
    });

    expect(result.errorMessage ?? null).toBeNull();
    expect(mocks.spawns).toHaveLength(1);
  });

  it("does not change a run on another provider", async () => {
    const { result } = await run({ model: "openai/gpt-5.4-mini" });

    expect(result.errorMessage ?? null).toBeNull();
    expect(mocks.spawns).toHaveLength(1);
    expect(mocks.spawns[0]!.env.PI_CODING_AGENT_DIR).toBe(process.env.PI_CODING_AGENT_DIR);
  });

  it("does not count a host API key for a remote target", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-host");
    const { result } = await run(
      { model: "anthropic/claude-sonnet-4-5" },
      {
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace",
            privateKey: "PRIVATE KEY",
            knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
            strictHostKeyChecking: true,
          },
        },
      },
    );

    expect(result.errorMessage).toBe(CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE);
    expect(mocks.spawns).toEqual([]);
    expect(mocks.runSshCommand).not.toHaveBeenCalled();
  });
});

describe("pi_local environment test Claude subscription guard", () => {
  it("fails and skips the hello probe for an Anthropic model without an API key", async () => {
    const workspace = await tempDir("paperclip-pi-guard-envtest-");
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: { command: "pi", cwd: workspace, model: "anthropic/claude-sonnet-4-5" },
    });

    expect(result.checks.find((check) => check.code === "pi_anthropic_api_key_required")).toMatchObject({
      level: "error",
      message: CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE,
    });
    expect(result.status).toBe("fail");
    expect(mocks.spawns.some((spawn) => spawn.args.includes("Respond with hello."))).toBe(false);
    expect(result.checks.some((check) => check.code.startsWith("pi_hello_probe"))).toBe(false);
  });

  it("probes an Anthropic model with an API key without Pi's stored logins", async () => {
    const workspace = await tempDir("paperclip-pi-guard-envtest-");
    await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        command: "pi",
        cwd: workspace,
        model: "anthropic/claude-sonnet-4-5",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" },
      },
    });

    const probe = mocks.spawns.find((spawn) => spawn.args.includes("Respond with hello."));
    expect(probe?.env.PI_CODING_AGENT_DIR).not.toBe(process.env.PI_CODING_AGENT_DIR);
    expect(probe?.agentDirEntries).toEqual(["settings.json"]);
  });
});
