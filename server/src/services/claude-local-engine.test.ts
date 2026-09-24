import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClaudeLocalEngine, resolvePersistedClaudeLocalEngine } from "./claude-local-engine.js";

afterEach(() => vi.unstubAllEnvs());

function clearHostCredentials() {
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]) vi.stubEnv(key, "");
}

describe("claude_local engine for server heuristics", () => {
  it("keeps an explicit engine", () => {
    expect(resolveClaudeLocalEngine({ engine: "acp" }, false)).toBe("acp");
    expect(resolveClaudeLocalEngine({ engine: " CLI ", env: { ANTHROPIC_API_KEY: "k" } }, false)).toBe("cli");
  });

  it("follows the credential when the engine is unset, like the adapter", () => {
    clearHostCredentials();
    expect(resolveClaudeLocalEngine({ env: { ANTHROPIC_API_KEY: "k" } }, false)).toBe("acp");
    expect(resolveClaudeLocalEngine({ env: {} }, false)).toBe("cli");
    expect(resolveClaudeLocalEngine({ env: { ANTHROPIC_API_KEY: "k" } }, true)).toBe("cli");
    expect(resolveClaudeLocalEngine({ env: { ANTHROPIC_API_KEY: "k" }, filesystemScope: "workspace" }, false)).toBe("cli");
  });

  it("reads persisted env bindings and a managed Anthropic connection", () => {
    clearHostCredentials();
    expect(
      resolvePersistedClaudeLocalEngine({
        adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" } } },
      }),
    ).toBe("acp");
    expect(
      resolvePersistedClaudeLocalEngine({
        adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "plain", value: "" } } },
      }),
    ).toBe("cli");
    expect(
      resolvePersistedClaudeLocalEngine({
        adapterConfig: {},
        runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } },
      }),
    ).toBe("acp");
    expect(resolvePersistedClaudeLocalEngine({ adapterConfig: {} })).toBe("cli");
  });
});
