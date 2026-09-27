/**
 * Only the official claude binary may use a Claude subscription. Hermes's
 * Anthropic provider falls back to a Claude sign-in when it has no API key, so
 * an Anthropic run needs ANTHROPIC_API_KEY, and the claude CLI sign-in is
 * hidden from it. Runs on other providers are unchanged.
 */

import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE } from "@paperclipai/adapter-utils/claude-subscription-harness-guard";

const spawned = vi.hoisted(() => ({
  calls: [] as Array<{ env: Record<string, string>; claudeConfigDirExisted: boolean | null }>,
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  const { stat } = await import("node:fs/promises");
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId: string, _command: string, _args: string[], opts: { env: Record<string, string> }) => {
      const dir = opts.env.CLAUDE_CONFIG_DIR;
      let claudeConfigDirExisted: boolean | null = null;
      if (dir) {
        claudeConfigDirExisted = await stat(dir).then((s) => s.isDirectory(), () => false);
      }
      spawned.calls.push({ env: { ...opts.env }, claudeConfigDirExisted });
      return { exitCode: 0, signal: null, timedOut: false, stdout: "done\n\nsession_id: s-1\n", stderr: "" };
    }),
  };
});

import { execute } from "./execute.js";
import { isHermesAnthropicRoute, isHermesAnthropicRunRoute } from "./detect-model.js";
import { testEnvironment } from "./test.js";

function ctx(config: Record<string, unknown>) {
  const logs: Array<[string, string]> = [];
  return {
    logs,
    ctx: {
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5, ...config },
      context: {},
      onLog: vi.fn(async (stream: string, chunk: string) => {
        logs.push([stream, chunk]);
      }),
    } as never,
  };
}

beforeEach(() => {
  spawned.calls.length = 0;
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isHermesAnthropicRoute", () => {
  it("is true for the anthropic provider and for auto with an anthropic Hermes config", () => {
    expect(isHermesAnthropicRoute({ resolvedProvider: "anthropic" })).toBe(true);
    expect(isHermesAnthropicRoute({ resolvedProvider: "auto", detectedProvider: "anthropic" })).toBe(true);
    expect(isHermesAnthropicRoute({ resolvedProvider: "auto", detectedProvider: "openrouter" })).toBe(false);
    expect(isHermesAnthropicRoute({ resolvedProvider: "auto" })).toBe(false);
    expect(isHermesAnthropicRoute({ resolvedProvider: "openrouter", detectedProvider: "anthropic" })).toBe(false);
  });
});

describe("isHermesAnthropicRunRoute", () => {
  it("counts a provider or model that extraArgs set after Paperclip's own flags", () => {
    const route = (resolvedProvider: string, extraArgs: string[], detectedProvider?: string) =>
      isHermesAnthropicRunRoute({ resolvedProvider, detectedProvider, extraArgs });
    expect(route("openrouter", ["--provider", "anthropic", "-m", "claude-sonnet-4-5"])).toBe(true);
    expect(route("openrouter", ["--provider=anthropic"])).toBe(true);
    expect(route("openrouter", ["--prov", "anthropic"])).toBe(true);
    expect(route("auto", ["-m", "claude-sonnet-4-5"])).toBe(true);
    expect(route("auto", ["--model=gpt-5"], "anthropic")).toBe(true);
    // Another provider keeps an Anthropic model on that provider's billing.
    expect(route("openrouter", ["-m", "anthropic/claude-sonnet-4-5"])).toBe(false);
    expect(route("openrouter", ["--provider", "zai", "-m", "glm-5"])).toBe(false);
    expect(route("openrouter", [])).toBe(false);
  });
});

describe("hermes_local Claude subscription guard", () => {
  it("refuses a run whose extraArgs switch to the Anthropic provider without an API key", async () => {
    const { ctx: runCtx, logs } = ctx({
      provider: "openrouter",
      model: "x",
      extraArgs: ["--provider", "anthropic", "-m", "claude-sonnet-4-5"],
    });

    const result = await execute(runCtx);

    expect(result.errorMessage).toBe(CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE);
    expect(spawned.calls).toEqual([]);
    expect(logs.some(([, line]) => line.includes("~/.hermes/.env"))).toBe(true);
  });

  it("refuses a claude-* model without an API key before starting Hermes", async () => {
    const { ctx: runCtx, logs } = ctx({ model: "claude-sonnet-4" });

    const result = await execute(runCtx);

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "adapter_engine_unavailable",
      errorMessage: CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE,
      provider: "anthropic",
    });
    expect(spawned.calls).toEqual([]);
    expect(logs).toContainEqual(["stderr", `[hermes] ${CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE}\n`]);
  });

  it("refuses an explicit anthropic provider whose only key is a subscription token", async () => {
    const { ctx: runCtx } = ctx({
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4",
      env: { ANTHROPIC_API_KEY: "sk-ant-oat01-fixture", ANTHROPIC_AUTH_TOKEN: "gateway-token" },
    });

    const result = await execute(runCtx);

    expect(result.errorMessage).toBe(CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE);
    expect(spawned.calls).toEqual([]);
  });

  it("runs an Anthropic model with an API key and hides the claude CLI sign-in", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/home/paperclip/.claude");
    const { ctx: runCtx } = ctx({
      provider: "anthropic",
      model: "claude-sonnet-4",
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" },
    });

    const result = await execute(runCtx);

    expect(result.errorMessage ?? null).toBeNull();
    expect(spawned.calls).toHaveLength(1);
    const { env, claudeConfigDirExisted } = spawned.calls[0]!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-fixture");
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(env.CLAUDE_CONFIG_DIR).not.toBe("/home/paperclip/.claude");
    // An empty private directory existed while Hermes ran and is gone after.
    expect(claudeConfigDirExisted).toBe(true);
    await expect(fs.stat(env.CLAUDE_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not change a run on another provider", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/home/paperclip/.claude");
    const { ctx: runCtx } = ctx({ provider: "openrouter", model: "anthropic/claude-sonnet-4" });

    const result = await execute(runCtx);

    expect(result.errorMessage ?? null).toBeNull();
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0]!.env.CLAUDE_CONFIG_DIR).toBe("/home/paperclip/.claude");
  });

  it("fails the environment test for an Anthropic model without an API key", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_local",
      config: { hermesCommand: "python3", provider: "anthropic", model: "claude-sonnet-4" },
    });

    const check = result.checks.find((entry) => entry.code === "hermes_anthropic_api_key_required");
    expect(check).toMatchObject({ level: "error", message: CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE });
    expect(result.status).toBe("fail");
  });

  it("passes the policy check in the environment test when the agent env has an API key", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_local",
      config: {
        hermesCommand: "python3",
        provider: "anthropic",
        model: "claude-sonnet-4",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" },
      },
    });

    expect(result.checks.some((entry) => entry.code === "hermes_anthropic_api_key_required")).toBe(false);
  });
});
