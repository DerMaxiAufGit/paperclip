import { describe, expect, it } from "vitest";

import { createSanitizedClaudeManagedEnvironment } from "./environment.js";

describe("Claude Managed runnerd environment", () => {
  it("passes an Anthropic API key and the runtime allowlist only", () => {
    expect(
      createSanitizedClaudeManagedEnvironment({
        PATH: "/bin",
        HTTPS_PROXY: "https://proxy.example",
        ANTHROPIC_API_KEY: "sk-ant-api03-key",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-subscription",
        UNRELATED_SECRET: "not-visible",
      }),
    ).toEqual({
      PATH: "/bin",
      HTTPS_PROXY: "https://proxy.example",
      ANTHROPIC_API_KEY: "sk-ant-api03-key",
    });
  });

  it.each(["sk-ant-oat01-subscription", " SK-ANT-ORT01-refresh", "sk-ant-sid01-session"])(
    "never forwards a Claude.ai credential as ANTHROPIC_API_KEY (%s)",
    (value) => {
      const env = createSanitizedClaudeManagedEnvironment({
        PATH: "/bin",
        ANTHROPIC_API_KEY: value,
      });
      expect(env).toEqual({ PATH: "/bin" });
      expect(JSON.stringify(env)).not.toMatch(/sk-ant-(oat|ort|sid)/i);
    },
  );

  it("drops a Claude.ai credential under any allowlisted key", () => {
    expect(
      createSanitizedClaudeManagedEnvironment({
        PATH: "/bin",
        HTTPS_PROXY: "sk-ant-oat01-subscription",
      }),
    ).toEqual({ PATH: "/bin" });
  });
});
