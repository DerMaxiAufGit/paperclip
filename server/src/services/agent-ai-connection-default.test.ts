import { describe, expect, it } from "vitest";
import { defaultAiConnectionForHire } from "./agent-ai-connection-default.js";

describe("defaultAiConnectionForHire", () => {
  it("leaves a claude_local hire unmanaged when the manager uses another provider", () => {
    expect(
      defaultAiConnectionForHire("claude_local", {}, {
        provider: "openai",
        method: "subscription",
        mode: "responsible_user",
      }),
    ).toBeUndefined();
  });

  it("still passes an Anthropic API-key binding from the manager to a claude_local hire", () => {
    const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" } as const;
    expect(defaultAiConnectionForHire("claude_local", {}, binding)).toEqual(binding);
  });

  it("still falls back to OpenAI for a codex_local hire under an Anthropic manager", () => {
    expect(
      defaultAiConnectionForHire("codex_local", {}, {
        provider: "anthropic",
        method: "api_key",
        mode: "responsible_user",
      }),
    ).toEqual({ provider: "openai", method: "api_key", mode: "responsible_user" });
  });
});
