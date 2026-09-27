import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPiAnthropicModel, isPiAnthropicRun, preparePiRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function readModelsJson(agentConfigDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentConfigDir, "models.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("preparePiRuntimeConfig", () => {
  it("is a no-op when PAPERCLIP_PI_PROVIDERS is unset", async () => {
    const prepared = await preparePiRuntimeConfig({ env: { FOO: "bar" } });

    expect(prepared.env).toEqual({ FOO: "bar" });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("writes the providers JSON verbatim to a managed models.json and points PI_CODING_AGENT_DIR at it", async () => {
    const providers = {
      tensorix: {
        baseUrl: "http://gateway.example.svc.cluster.local:8080/anthropic",
        apiKey: "sk-literal",
        api: "anthropic-messages",
        models: [
          {
            id: "deepseek/deepseek-chat-v3.1",
            name: "DeepSeek v3.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    };

    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    cleanupPaths.add(agentConfigDir);

    expect(await readModelsJson(agentConfigDir)).toEqual({ providers });
    expect(prepared.notes.some((n) => n.includes("tensorix"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(agentConfigDir);
    await expect(fs.access(agentConfigDir)).rejects.toThrow();
  });

  it("reads PAPERCLIP_PI_PROVIDERS from process.env when absent from the run env", async () => {
    const providers = { tensorix: { baseUrl: "http://gw/anthropic", api: "anthropic-messages", models: [] } };
    process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await preparePiRuntimeConfig({ env: {} });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      expect(agentConfigDir).toBeTruthy();
      cleanupPaths.add(agentConfigDir);
      expect(await readModelsJson(agentConfigDir)).toEqual({ providers });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_PI_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders from the run env (bakes the literal key)", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:ANTHROPIC_API_KEY}", api: "anthropic-messages", models: [] },
    };
    const prepared = await preparePiRuntimeConfig({
      env: {
        PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers),
        ANTHROPIC_API_KEY: "sk-bf-REALVK",
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsJson.providers.tensorix.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("expands {env:VAR} placeholders from process.env when absent from the run env", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:PAPERCLIP_PI_TEST_KEY}", api: "anthropic-messages", models: [] },
    };
    process.env.PAPERCLIP_PI_TEST_KEY = "sk-from-process-env";
    try {
      const prepared = await preparePiRuntimeConfig({
        env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
      });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      cleanupPaths.add(agentConfigDir);
      const modelsJson = (await readModelsJson(agentConfigDir)) as {
        providers: { tensorix: { apiKey: string } };
      };
      expect(modelsJson.providers.tensorix.apiKey).toBe("sk-from-process-env");
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_PI_TEST_KEY;
    }
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}", api: "anthropic-messages", models: [] },
    };
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsJson.providers.tensorix.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_PI_PROVIDERS without writing a config", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("ignores provider entries that are not objects and names them in the note", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({ tensorix: "nope" }) },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.agentConfigDir).toBeNull();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces skipped non-object entries while keeping the usable ones", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: {
        PAPERCLIP_PI_PROVIDERS: JSON.stringify({
          bad: "http://gw/v1",
          tensorix: { baseUrl: "http://gw/anthropic", apiKey: "k", api: "anthropic-messages", models: [] },
        }),
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    expect(prepared.agentConfigDir).toBe(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: Record<string, unknown>;
    };
    expect(modelsJson.providers.tensorix).toBeDefined();
    expect(modelsJson.providers.bad).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: bad.",
      "Injected 1 custom Pi provider(s) from PAPERCLIP_PI_PROVIDERS into a managed models.json: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_PI_PROVIDERS contains invalid JSON", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "{not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_PI_PROVIDERS is not a JSON object", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "[1,2]" },
    });
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces the skipped entries when no provider objects remain", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: '{"a": 1}' },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: a.",
    ]);
    await prepared.cleanup();
  });

  it("stays silent when PAPERCLIP_PI_PROVIDERS is an empty object", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "{}" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });
});

describe("isPiAnthropicModel", () => {
  it("matches the anthropic provider and bare claude-* IDs only", () => {
    expect(isPiAnthropicModel("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isPiAnthropicModel(" Anthropic/claude-opus-4 ")).toBe(true);
    expect(isPiAnthropicModel("claude-sonnet-4-5")).toBe(true);
    expect(isPiAnthropicModel("openrouter/anthropic/claude-sonnet-4-5")).toBe(false);
    expect(isPiAnthropicModel("amazon-bedrock/anthropic.claude-sonnet-4-5")).toBe(false);
    expect(isPiAnthropicModel("openai/gpt-5.4-mini")).toBe(false);
    expect(isPiAnthropicModel("")).toBe(false);
    expect(isPiAnthropicModel(null)).toBe(false);
  });
});

describe("isPiAnthropicRun", () => {
  it("counts a provider or model that extra args set after --provider and --model", () => {
    expect(isPiAnthropicRun({ model: "openai/gpt-5", extraArgs: ["--provider", "anthropic"] })).toBe(true);
    expect(isPiAnthropicRun({ model: "openai/gpt-5", extraArgs: ["--model", "anthropic/claude-opus-4"] })).toBe(true);
    expect(isPiAnthropicRun({ model: "", extraArgs: ["--model=claude-sonnet-4-5"] })).toBe(true);
    expect(isPiAnthropicRun({ model: "openai/gpt-5", extraArgs: ["--provider=anthropic", "--model", "x"] })).toBe(true);
    // A bare model stays on the configured provider.
    expect(isPiAnthropicRun({ model: "openrouter/x", extraArgs: ["--model", "claude-sonnet-4-5"] })).toBe(false);
    expect(isPiAnthropicRun({ model: "openai/gpt-5", extraArgs: ["--thinking", "high"] })).toBe(false);
  });
});

describe("preparePiRuntimeConfig hideStoredLogins", () => {
  async function hostAgentDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-host-agent-"));
    cleanupPaths.add(dir);
    await fs.writeFile(path.join(dir, "auth.json"), '{"anthropic":{"type":"oauth"}}');
    await fs.mkdir(path.join(dir, "auth.json.lock"));
    await fs.writeFile(path.join(dir, "settings.json"), '{"defaultThinkingLevel":"high"}');
    await fs.writeFile(path.join(dir, "models.json"), '{"providers":{}}');
    await fs.mkdir(path.join(dir, "extensions"));
    return dir;
  }

  it("links every host agent entry except the stored logins for a local run", async () => {
    const host = await hostAgentDir();
    const prepared = await preparePiRuntimeConfig({
      env: { PI_CODING_AGENT_DIR: host },
      hideStoredLogins: true,
    });
    const managed = prepared.env.PI_CODING_AGENT_DIR!;
    cleanupPaths.add(managed);

    expect(managed).not.toBe(host);
    expect(prepared.agentConfigDir).toBe(managed);
    expect((await fs.readdir(managed)).sort()).toEqual(["extensions", "models.json", "settings.json"]);
    expect(await fs.readlink(path.join(managed, "settings.json"))).toBe(path.join(host, "settings.json"));
    expect(prepared.notes.join("\n")).toMatch(/without auth\.json/);

    await prepared.cleanup();
    await expect(fs.stat(managed)).rejects.toMatchObject({ code: "ENOENT" });
    // The host agent dir and its login are untouched.
    expect(await fs.readFile(path.join(host, "auth.json"), "utf8")).toContain("oauth");
  });

  it("gives a remote run an empty managed agent dir", async () => {
    const host = await hostAgentDir();
    const prepared = await preparePiRuntimeConfig({
      env: { PI_CODING_AGENT_DIR: host },
      hideStoredLogins: true,
      targetIsRemote: true,
    });
    cleanupPaths.add(prepared.agentConfigDir!);

    expect(await fs.readdir(prepared.agentConfigDir!)).toEqual([]);
    await prepared.cleanup();
  });

  it("works when the host agent dir does not exist", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PI_CODING_AGENT_DIR: path.join(os.tmpdir(), "paperclip-pi-missing-agent-dir-does-not-exist") },
      hideStoredLogins: true,
    });
    cleanupPaths.add(prepared.agentConfigDir!);

    expect(await fs.readdir(prepared.agentConfigDir!)).toEqual([]);
    await prepared.cleanup();
  });

  it("keeps the custom-provider dir, which never holds auth.json", async () => {
    const host = await hostAgentDir();
    const prepared = await preparePiRuntimeConfig({
      env: {
        PI_CODING_AGENT_DIR: host,
        PAPERCLIP_PI_PROVIDERS: JSON.stringify({ gateway: { baseUrl: "https://gateway.example", models: [] } }),
      },
      hideStoredLogins: true,
    });
    cleanupPaths.add(prepared.agentConfigDir!);

    expect(await fs.readdir(prepared.agentConfigDir!)).toEqual(["models.json"]);
    await prepared.cleanup();
  });

  it("does nothing without hideStoredLogins", async () => {
    const host = await hostAgentDir();
    const prepared = await preparePiRuntimeConfig({ env: { PI_CODING_AGENT_DIR: host } });

    expect(prepared.agentConfigDir).toBeNull();
    expect(prepared.env.PI_CODING_AGENT_DIR).toBe(host);
    await prepared.cleanup();
  });
});
