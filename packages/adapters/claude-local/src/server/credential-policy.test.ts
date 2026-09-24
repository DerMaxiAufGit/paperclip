import { describe, expect, it } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE,
  CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE,
  claudeRunHasApiCredential,
  resolveClaudeBillingIdentity,
  resolveClaudeCredentialPolicyViolation,
  resolveClaudeDefaultEngine,
} from "./credential-policy.js";

const REMOTE_SANDBOX: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "fake-plugin",
  remoteCwd: "/work",
} as AdapterExecutionTarget;

const EMPTY_HOST: NodeJS.ProcessEnv = {};

function violation(input: {
  engine: "cli" | "acp";
  env?: Record<string, unknown>;
  target?: AdapterExecutionTarget | null;
  hostEnv?: NodeJS.ProcessEnv;
  managed?: boolean;
}) {
  return resolveClaudeCredentialPolicyViolation({
    engine: input.engine,
    config: {
      ...(input.env ? { env: input.env } : {}),
      ...(input.managed ? { managedAiConnection: { provider: "anthropic", method: "api_key" } } : {}),
    },
    target: input.target ?? null,
    hostEnv: input.hostEnv ?? EMPTY_HOST,
  });
}

describe("claude credential policy", () => {
  it("never counts ANTHROPIC_BEDROCK_BASE_URL alone, for ACP or remote targets", () => {
    const env = { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com" };
    expect(violation({ engine: "acp", env })).toBe(CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE);
    expect(violation({ engine: "cli", env, target: REMOTE_SANDBOX })).toBe(CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE);
    expect(violation({ engine: "acp", hostEnv: env })).toBe(CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE);
  });

  it("counts Bedrock when CLAUDE_CODE_USE_BEDROCK is set", () => {
    expect(violation({ engine: "acp", env: { CLAUDE_CODE_USE_BEDROCK: "1" } })).toBeNull();
    expect(violation({ engine: "acp", hostEnv: { CLAUDE_CODE_USE_BEDROCK: "true" } })).toBeNull();
  });

  it("does not count a host-only Vertex or Foundry flag, which the ACP child never inherits", () => {
    expect(violation({ engine: "acp", hostEnv: { CLAUDE_CODE_USE_VERTEX: "1" } })).toBe(
      CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE,
    );
    expect(violation({ engine: "acp", hostEnv: { CLAUDE_CODE_USE_FOUNDRY: "1" } })).toBe(
      CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE,
    );
  });

  it("counts Vertex and Foundry flags set in the adapter env, locally and on remote targets", () => {
    for (const key of ["CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
      expect(violation({ engine: "acp", env: { [key]: "1" } })).toBeNull();
      expect(violation({ engine: "cli", env: { [key]: "1" }, target: REMOTE_SANDBOX })).toBeNull();
    }
  });

  it("counts a gateway ANTHROPIC_AUTH_TOKEN for a remote CLI run and a local ACP run", () => {
    const env = { ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_AUTH_TOKEN: "gw-token" };
    expect(violation({ engine: "cli", env, target: REMOTE_SANDBOX })).toBeNull();
    expect(violation({ engine: "acp", env })).toBeNull();
    expect(violation({ engine: "acp", hostEnv: { ANTHROPIC_AUTH_TOKEN: "gw-token" } })).toBeNull();
  });

  it("never counts a subscription OAuth token carried in ANTHROPIC_AUTH_TOKEN", () => {
    const env = { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-subscription" };
    expect(violation({ engine: "acp", env })).toBe(CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE);
    expect(violation({ engine: "cli", env, target: REMOTE_SANDBOX })).toBe(CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE);
  });

  it("never counts CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(violation({ engine: "acp", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } })).toBe(
      CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE,
    );
  });

  it("always allows the local CLI engine", () => {
    expect(violation({ engine: "cli" })).toBeNull();
  });

  it("ignores host credentials for remote targets and managed connections", () => {
    const hostEnv = { ANTHROPIC_API_KEY: "sk-ant-host" };
    expect(claudeRunHasApiCredential({ config: {}, targetIsRemote: true, hostEnv })).toBe(false);
    expect(
      claudeRunHasApiCredential({
        config: { managedAiConnection: { provider: "anthropic" } },
        targetIsRemote: false,
        hostEnv,
      }),
    ).toBe(false);
    expect(claudeRunHasApiCredential({ config: {}, targetIsRemote: false, hostEnv })).toBe(true);
  });
});

describe("resolveClaudeDefaultEngine", () => {
  it("uses ACP for a local run with an API key in the adapter env", () => {
    expect(
      resolveClaudeDefaultEngine({
        config: { env: { ANTHROPIC_API_KEY: "sk-ant-agent" } },
        targetIsRemote: false,
        hostEnv: EMPTY_HOST,
      }),
    ).toBe("acp");
  });

  it("uses the CLI engine for a local run without a key", () => {
    expect(resolveClaudeDefaultEngine({ config: {}, targetIsRemote: false, hostEnv: EMPTY_HOST })).toBe("cli");
  });

  it("ignores the host key when a managed connection supplies no key", () => {
    expect(
      resolveClaudeDefaultEngine({
        config: { managedAiConnection: { provider: "anthropic" } },
        targetIsRemote: false,
        hostEnv: { ANTHROPIC_API_KEY: "sk-ant-host" },
      }),
    ).toBe("cli");
  });

  it("keeps remote targets on the CLI engine", () => {
    expect(
      resolveClaudeDefaultEngine({
        config: { env: { ANTHROPIC_API_KEY: "sk-ant-agent" } },
        targetIsRemote: true,
        hostEnv: EMPTY_HOST,
      }),
    ).toBe("cli");
  });
});

describe("resolveClaudeBillingIdentity", () => {
  function billing(input: {
    engine: "cli" | "acp";
    env?: Record<string, unknown>;
    targetIsRemote?: boolean;
    hostEnv?: NodeJS.ProcessEnv;
  }) {
    return resolveClaudeBillingIdentity({
      engine: input.engine,
      targetIsRemote: input.targetIsRemote ?? false,
      env: input.env ?? {},
      hostEnv: input.hostEnv ?? EMPTY_HOST,
    });
  }

  it("labels a local CLI run with no API credential a subscription run", () => {
    expect(billing({ engine: "cli" })).toEqual({
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription",
    });
  });

  it.each([
    ["a gateway ANTHROPIC_AUTH_TOKEN", { ANTHROPIC_AUTH_TOKEN: "gw-token", ANTHROPIC_BASE_URL: "https://gateway.example" }, "unknown"],
    ["an OpenRouter gateway token", { ANTHROPIC_AUTH_TOKEN: "sk-or-x", ANTHROPIC_BASE_URL: "https://openrouter.ai/api" }, "openrouter"],
    ["Bedrock", { CLAUDE_CODE_USE_BEDROCK: "1" }, "aws_bedrock"],
    ["Vertex", { CLAUDE_CODE_USE_VERTEX: "1" }, "google"],
    ["Foundry", { CLAUDE_CODE_USE_FOUNDRY: "true" }, "azure"],
  ])("labels a local CLI run with %s metered_api, never subscription", (_label, env, biller) => {
    expect(billing({ engine: "cli", env })).toEqual({ provider: "anthropic", biller, billingType: "metered_api" });
  });

  it("reads host Vertex, Foundry and gateway settings for a local CLI run, whose child inherits the host env", () => {
    expect(billing({ engine: "cli", hostEnv: { CLAUDE_CODE_USE_VERTEX: "1" } })).toMatchObject({
      biller: "google",
      billingType: "metered_api",
    });
    expect(billing({ engine: "cli", hostEnv: { CLAUDE_CODE_USE_FOUNDRY: "1" } })).toMatchObject({
      biller: "azure",
      billingType: "metered_api",
    });
    expect(billing({ engine: "cli", hostEnv: { ANTHROPIC_AUTH_TOKEN: "gw-token" } })).toMatchObject({
      billingType: "metered_api",
    });
  });

  it("labels an API key api, billed by Anthropic", () => {
    expect(billing({ engine: "cli", env: { ANTHROPIC_API_KEY: "sk-ant-key" } })).toEqual({
      provider: "anthropic",
      biller: "anthropic",
      billingType: "api",
    });
  });

  it("never treats ANTHROPIC_BEDROCK_BASE_URL alone as Bedrock", () => {
    const env = {
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      ANTHROPIC_API_KEY: "sk-ant-key",
    };
    expect(billing({ engine: "cli", env })).toEqual({ provider: "anthropic", biller: "anthropic", billingType: "api" });
    expect(billing({ engine: "acp", env })).toEqual({ provider: "anthropic", biller: "anthropic", billingType: "api" });
    expect(
      billing({ engine: "cli", hostEnv: { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com" } }),
    ).toMatchObject({ biller: "anthropic", billingType: "subscription" });
  });

  it("never labels a remote target subscription, and ignores the host env there", () => {
    const hostEnv = { ANTHROPIC_API_KEY: "sk-ant-host", CLAUDE_CODE_USE_VERTEX: "1" };
    expect(billing({ engine: "cli", targetIsRemote: true, hostEnv })).toEqual({
      provider: "anthropic",
      biller: "anthropic",
      billingType: "unknown",
    });
    expect(
      billing({ engine: "cli", targetIsRemote: true, env: { ANTHROPIC_AUTH_TOKEN: "gw-token" } }),
    ).toMatchObject({ billingType: "metered_api" });
    expect(
      billing({ engine: "cli", targetIsRemote: true, env: { CLAUDE_CODE_USE_VERTEX: "1" } }),
    ).toMatchObject({ biller: "google", billingType: "metered_api" });
    expect(billing({ engine: "cli", targetIsRemote: true, env: { ANTHROPIC_API_KEY: "sk-ant-key" } })).toMatchObject({
      billingType: "api",
    });
  });

  it("never labels an ACP run subscription", () => {
    expect(billing({ engine: "acp" }).billingType).toBe("unknown");
  });

  it("does not count a subscription OAuth token in ANTHROPIC_AUTH_TOKEN as a gateway credential", () => {
    const env = { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-subscription" };
    expect(billing({ engine: "cli", env }).billingType).toBe("subscription");
    expect(billing({ engine: "cli", env, targetIsRemote: true }).billingType).toBe("unknown");
  });

  it("lets an empty adapter env value unset a host credential, as the launch env does", () => {
    expect(billing({ engine: "cli", env: { ANTHROPIC_API_KEY: "" }, hostEnv: { ANTHROPIC_API_KEY: "sk-ant-host" } }).billingType).toBe(
      "subscription",
    );
  });
});
