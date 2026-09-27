/**
 * Only the official claude binary may use a Claude subscription. OpenCode can
 * hold a Claude Pro/Max login in its auth.json, so an Anthropic model needs
 * ANTHROPIC_API_KEY and runs with OPENCODE_AUTH_CONTENT={} (no stored logins).
 * Runs on other providers are unchanged.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE } from "@paperclipai/adapter-utils/claude-subscription-harness-guard";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { execute } from "./execute.js";
import {
  hideOpenCodeStoredLogins,
  isOpenCodeAnthropicModel,
  isOpenCodeAnthropicRun,
} from "./runtime-config.js";
import { testEnvironment } from "./test.js";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

function processResult(stdout: string) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  } as never;
}

let root: string;
let commandPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-guard-"));
  commandPath = path.join(root, "opencode");
  await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  runProcessMock.mockReset();
  runProcessMock.mockResolvedValue(
    processResult(JSON.stringify({ type: "text", sessionID: "session-1", part: { text: "hello" } })),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function run(config: Record<string, unknown>) {
  const logs: Array<[string, string]> = [];
  const result = await execute({
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: commandPath, cwd: root, ...config },
    context: {},
    onLog: async (stream: string, chunk: string) => {
      logs.push([stream, chunk]);
    },
  } as never);
  return { result, logs };
}

function spawnedEnv(): Record<string, string> {
  const call = runProcessMock.mock.calls.at(-1);
  return ((call?.[4] as { env?: Record<string, string> } | undefined)?.env ?? {}) as Record<string, string>;
}

describe("OpenCode Anthropic model helpers", () => {
  it("matches only the anthropic provider", () => {
    expect(isOpenCodeAnthropicModel("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isOpenCodeAnthropicModel("Anthropic/claude-opus-4")).toBe(true);
    expect(isOpenCodeAnthropicModel("openrouter/anthropic/claude-sonnet-4-5")).toBe(false);
    expect(isOpenCodeAnthropicModel("amazon-bedrock/anthropic.claude-sonnet-4-5")).toBe(false);
    expect(isOpenCodeAnthropicModel("google-vertex-anthropic/claude-sonnet-4-5")).toBe(false);
    expect(isOpenCodeAnthropicModel("claude-sonnet-4-5")).toBe(false);
    expect(isOpenCodeAnthropicModel("openai/gpt-5")).toBe(false);
  });

  it("counts an Anthropic model that extra args set after --model", () => {
    expect(isOpenCodeAnthropicRun({ model: "openai/gpt-5", extraArgs: ["--model", "anthropic/claude-sonnet-4-5"] })).toBe(true);
    expect(isOpenCodeAnthropicRun({ model: "openai/gpt-5", extraArgs: ["-m", "anthropic/claude-opus-4"] })).toBe(true);
    expect(isOpenCodeAnthropicRun({ model: "openai/gpt-5", extraArgs: ["--model=anthropic/claude-opus-4"] })).toBe(true);
    expect(isOpenCodeAnthropicRun({ model: "openai/gpt-5", extraArgs: ["--model", "openrouter/anthropic/claude"] })).toBe(false);
    expect(isOpenCodeAnthropicRun({ model: "openai/gpt-5", extraArgs: [] })).toBe(false);
  });

  it("hides stored logins with an empty OPENCODE_AUTH_CONTENT", () => {
    const env: Record<string, string> = { OPENCODE_AUTH_CONTENT: '{"anthropic":{"type":"oauth"}}' };
    hideOpenCodeStoredLogins(env);
    expect(env.OPENCODE_AUTH_CONTENT).toBe("{}");
  });
});

describe("opencode_local Claude subscription guard", () => {
  it("refuses an Anthropic model without an API key before starting OpenCode", async () => {
    const { result, logs } = await run({
      model: "anthropic/claude-sonnet-4-5",
      env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "adapter_engine_unavailable",
      errorMessage: CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE,
      provider: "anthropic",
    });
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(logs).toContainEqual(["stderr", `[paperclip] ${CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE}\n`]);
  });

  it("refuses when ANTHROPIC_API_KEY holds a subscription token", async () => {
    const { result } = await run({
      model: "anthropic/claude-sonnet-4-5",
      env: { OPENCODE_ALLOW_ALL_MODELS: "1", ANTHROPIC_API_KEY: "sk-ant-oat01-fixture" },
    });

    expect(result.errorMessage).toBe(CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE);
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it("runs an Anthropic model with an API key and without stored logins, even if the agent env sets them", async () => {
    const { result } = await run({
      model: "anthropic/claude-sonnet-4-5",
      env: {
        OPENCODE_ALLOW_ALL_MODELS: "1",
        ANTHROPIC_API_KEY: "sk-ant-api03-fixture",
        OPENCODE_AUTH_CONTENT: '{"anthropic":{"type":"oauth"}}',
      },
    });

    expect(result.errorMessage ?? null).toBeNull();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(spawnedEnv().OPENCODE_AUTH_CONTENT).toBe("{}");
    expect(spawnedEnv().ANTHROPIC_API_KEY).toBe("sk-ant-api03-fixture");
  });

  it("does not change a run on another provider", async () => {
    const { result } = await run({ model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } });

    expect(result.errorMessage ?? null).toBeNull();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(spawnedEnv().OPENCODE_AUTH_CONTENT).toBeUndefined();
  });

  it("fails the environment test and skips the hello probe without an API key", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command: commandPath, cwd: root, model: "anthropic/claude-sonnet-4-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
    });

    expect(result.checks.find((check) => check.code === "opencode_anthropic_api_key_required")).toMatchObject({
      level: "error",
      message: CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE,
    });
    expect(result.status).toBe("fail");
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it("probes an Anthropic model with an API key without stored logins", async () => {
    await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        command: commandPath,
        cwd: root,
        model: "anthropic/claude-sonnet-4-5",
        env: { OPENCODE_ALLOW_ALL_MODELS: "1", ANTHROPIC_API_KEY: "sk-ant-api03-fixture" },
      },
    });

    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(spawnedEnv().OPENCODE_AUTH_CONTENT).toBe("{}");
  });
});
