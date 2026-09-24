import { describe, expect, it } from "vitest";
import { isNeverForwardedChildEnvKey, sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";

describe("sanitizeRemoteExecutionEnv", () => {
  it("never forwards a Claude subscription token to a remote or sandbox process", () => {
    const sanitized = sanitizeRemoteExecutionEnv(
      {
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-explicit",
        Claude_Code_OAuth_Token: "sk-ant-oat01-mixed",
        ANTHROPIC_API_KEY: "sk-ant-api",
        OPENAI_API_KEY: "sk-openai",
      },
      {},
    );
    expect(sanitized).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api", OPENAI_API_KEY: "sk-openai" });
  });

  it("still drops identity keys that match the inherited env", () => {
    expect(sanitizeRemoteExecutionEnv({ HOME: "/home/host", FOO: "bar" }, { HOME: "/home/host" })).toEqual({
      FOO: "bar",
    });
  });

  it("matches the never-forwarded key in any letter case", () => {
    expect(isNeverForwardedChildEnvKey("claude_code_oauth_token")).toBe(true);
    expect(isNeverForwardedChildEnvKey(" CLAUDE_CODE_OAUTH_TOKEN ")).toBe(true);
    expect(isNeverForwardedChildEnvKey("ANTHROPIC_API_KEY")).toBe(false);
  });
});
