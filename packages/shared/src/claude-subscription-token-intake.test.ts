import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiConnectionSchema } from "./ai-connections.js";
import { llmConfigSchema, mergePaperclipConfig, paperclipConfigSchema } from "./config-schema.js";
import { CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE } from "./validators/secret.js";

// Paperclip never takes a Claude subscription token as an API key: not in an
// AI connection (which would send it to the provider's endpoint to verify it)
// and not in the config file's llm block.
const TOKENS = ["sk-ant-oat01-pasted", " SK-ANT-ORT01-refresh", "sk-ant-sid01-session"];

describe("createAiConnectionSchema", () => {
  const base = { method: "api_key", name: "Key", ownership: "personal" } as const;

  it.each(["anthropic", "openai", "openrouter", "xai"] as const)(
    "rejects a Claude subscription token as the %s API key",
    (provider) => {
      for (const apiKey of TOKENS) {
        const result = createAiConnectionSchema.safeParse({ ...base, provider, apiKey });
        expect(result.success).toBe(false);
        expect(result.error?.issues).toContainEqual(
          expect.objectContaining({ message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE, path: ["apiKey"] }),
        );
      }
    },
  );

  it("accepts an Anthropic API key", () => {
    expect(
      createAiConnectionSchema.safeParse({ ...base, provider: "anthropic", apiKey: "sk-ant-api03-key" }).success,
    ).toBe(true);
  });
});

describe("config llm block", () => {
  const config = (llm: Record<string, unknown>) => ({
    $meta: { version: 1, updatedAt: "2026-09-28T00:00:00.000Z", source: "configure" },
    llm,
    database: { mode: "embedded-postgres" },
    logging: { mode: "file" },
    server: {},
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("llmConfigSchema rejects a Claude subscription token as the API key", () => {
    for (const apiKey of TOKENS) {
      const result = llmConfigSchema.safeParse({ provider: "claude", apiKey });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE, path: ["apiKey"] }),
      ]);
    }
    expect(llmConfigSchema.parse({ provider: "claude", apiKey: "sk-ant-api03-key" }).apiKey).toBe("sk-ant-api03-key");
  });

  it("loads a config file that holds one without the token, so the server still starts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const provider of ["claude", "openai"]) {
      for (const apiKey of TOKENS) {
        const parsed = paperclipConfigSchema.parse(config({ provider, apiKey, extension: "keep" }));
        expect(parsed.llm).toEqual({ provider, extension: "keep" });
        expect(JSON.stringify(parsed)).not.toMatch(/sk-ant-(oat|ort|sid)/i);
      }
    }
    // The warning never repeats the token.
    for (const [message] of warn.mock.calls) {
      expect(String(message)).toContain("llm.apiKey");
      expect(String(message)).not.toMatch(/sk-ant-(oat|ort|sid)\d/i);
    }
    expect(warn).toHaveBeenCalled();
  });

  it("keeps a real API key, and a config write drops a loaded token for good", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(paperclipConfigSchema.parse(config({ provider: "claude", apiKey: "sk-ant-api03-key" })).llm).toEqual({
      provider: "claude",
      apiKey: "sk-ant-api03-key",
    });
    const source = paperclipConfigSchema.parse(config({ provider: "claude", apiKey: "sk-ant-oat01-x" }));
    const update = paperclipConfigSchema.parse({ ...config({ provider: "claude" }), server: { port: 3200 } });
    expect(paperclipConfigSchema.parse(mergePaperclipConfig(source, update)).llm).toEqual({ provider: "claude" });
  });
});
