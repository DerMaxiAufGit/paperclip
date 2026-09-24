import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

// A fake `claude` binary that records what it received in its env, then prints
// a successful stream-json run.
async function writeEnvCapturingClaude(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  const tokenKeys = Object.keys(process.env).filter((key) => key.toUpperCase() === "CLAUDE_CODE_OAUTH_TOKEN");
  fs.writeFileSync(capturePath, JSON.stringify({ tokenKeys, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }), "utf8");
}
const sessionId = "22222222-2222-4222-8222-222222222222";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: sessionId, result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("claude local CLI lane credentials", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("never passes a CLAUDE_CODE_OAUTH_TOKEN from the adapter config or the host to the local claude child", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-credentials-"));
    cleanupDirs.push(root);
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeEnvCapturingClaude(commandPath);

    vi.stubEnv("HOME", root);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-config"));
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "host-subscription-token");

    let loggedEnv: Record<string, string> = {};
    const logs: string[] = [];
    const result = await execute({
      runId: "run-local-credentials",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: { engine: "cli" },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: "claude",
        cwd: workspace,
        env: {
          PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          CLAUDE_CODE_OAUTH_TOKEN: "config-subscription-token",
        },
        promptTemplate: "Follow the paperclip heartbeat.",
      },
      context: {},
      authToken: "run-jwt-token",
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onMeta: async (meta) => {
        loggedEnv = meta.env ?? {};
      },
    });

    expect(result.exitCode).toBe(0);
    const captured = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
      tokenKeys: string[];
      token: string | null;
    };
    expect(captured).toEqual({ tokenKeys: [], token: null });
    expect(Object.keys(loggedEnv).map((key) => key.toUpperCase())).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(loggedEnv)).not.toContain("subscription-token");
    expect(logs.join("")).not.toContain("subscription-token");
  });

  describe("CLI-lane billing label", () => {
    async function runLocalCli(env: Record<string, string>) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-billing-"));
      cleanupDirs.push(root);
      const workspace = path.join(root, "workspace");
      const binDir = path.join(root, "bin");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await writeEnvCapturingClaude(path.join(binDir, "claude"));
      vi.stubEnv("HOME", root);
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-config"));
      vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
      for (const key of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_BEDROCK_BASE_URL",
      ]) {
        vi.stubEnv(key, "");
      }
      return execute({
        runId: "run-local-billing",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: "claude",
          cwd: workspace,
          env,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });
    }

    it.each([
      [
        "a gateway ANTHROPIC_AUTH_TOKEN",
        { ANTHROPIC_AUTH_TOKEN: "gw-token", ANTHROPIC_BASE_URL: "https://litellm.internal.example" },
        "unknown",
      ],
      ["Vertex", { CLAUDE_CODE_USE_VERTEX: "1" }, "google"],
      ["Foundry", { CLAUDE_CODE_USE_FOUNDRY: "1" }, "azure"],
    ])("labels a local CLI run with %s metered_api, not subscription", async (_label, env, biller) => {
      const result = await runLocalCli(env);
      expect(result.exitCode).toBe(0);
      expect(result.billingType).toBe("metered_api");
      expect(result.biller).toBe(biller);
    });

    it("labels a local CLI run with no API credential a subscription run", async () => {
      const result = await runLocalCli({});
      expect(result.exitCode).toBe(0);
      expect(result.billingType).toBe("subscription");
      expect(result.biller).toBe("anthropic");
    });
  });
});
