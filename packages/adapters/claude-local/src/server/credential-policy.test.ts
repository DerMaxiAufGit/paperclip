import { describe, expect, it } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE,
  CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE,
  claudeConfigDeclaresApiCredential,
  claudeRunHasApiCredential,
  isClaudeSubscriptionLaneRun,
  resolveClaudeBillingIdentity,
  resolveClaudeCredentialPolicyViolation,
  resolveClaudeDefaultEngine,
  withoutClaudeSubscriptionTokens,
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

describe("subscription endpoint check on the local CLI lane", () => {
  const EVIL = "https://evil.example";

  it("refuses a subscription-lane run whose agent env points ANTHROPIC_BASE_URL at another host", () => {
    const message = violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: EVIL } });
    expect(message).toBe(
      "A Claude subscription is only sent to api.anthropic.com. Remove ANTHROPIC_BASE_URL from the agent env or add an Anthropic API key (ANTHROPIC_API_KEY) to use a custom endpoint.",
    );
  });

  it("allows ANTHROPIC_BASE_URL only at https://api.anthropic.com", () => {
    for (const url of ["https://api.anthropic.com", "https://api.anthropic.com/", "https://API.anthropic.com:443/v1"]) {
      expect(violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: url } })).toBeNull();
    }
    for (const url of [
      "http://api.anthropic.com",
      "https://api.anthropic.com:8443",
      "https://api.anthropic.com.evil.example",
      "https://console.anthropic.com",
      "not a url",
      " ",
    ]) {
      expect(violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: url } })).toContain("ANTHROPIC_BASE_URL");
    }
    // An empty value leaves the CLI on its default endpoint.
    expect(violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: "" } })).toBeNull();
  });

  it("keeps custom base URLs for API-key and gateway runs", () => {
    expect(violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: EVIL, ANTHROPIC_API_KEY: "sk-ant-api03-key" } })).toBeNull();
    expect(violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: EVIL, ANTHROPIC_AUTH_TOKEN: "gw-token" } })).toBeNull();
    expect(violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: EVIL, CLAUDE_CODE_USE_BEDROCK: "1" } })).toBeNull();
    // A host API key makes the local CLI run an API-key run too.
    expect(
      violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: EVIL }, hostEnv: { ANTHROPIC_API_KEY: "sk-ant-api03-host" } }),
    ).toBeNull();
  });

  it("still refuses when the only credential is a subscription token or a host key a managed connection hides", () => {
    expect(
      violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: EVIL, ANTHROPIC_API_KEY: "sk-ant-oat01-subscription" } }),
    ).toContain("ANTHROPIC_BASE_URL");
    expect(
      violation({
        engine: "cli",
        env: { ANTHROPIC_BASE_URL: EVIL },
        managed: true,
        hostEnv: { ANTHROPIC_API_KEY: "sk-ant-api03-host" },
      }),
    ).toContain("ANTHROPIC_BASE_URL");
  });

  it("checks only the agent env, not the server's own env", () => {
    expect(violation({ engine: "cli", hostEnv: { ANTHROPIC_BASE_URL: EVIL, ANTHROPIC_UNIX_SOCKET: "/tmp/s" } })).toBeNull();
  });

  it("refuses ANTHROPIC_UNIX_SOCKET and CLAUDE_CODE_API_BASE_URL on the subscription lane", () => {
    expect(violation({ engine: "cli", env: { ANTHROPIC_UNIX_SOCKET: "/tmp/claude.sock" } })).toContain(
      "ANTHROPIC_UNIX_SOCKET",
    );
    expect(violation({ engine: "cli", env: { CLAUDE_CODE_API_BASE_URL: EVIL } })).toContain("CLAUDE_CODE_API_BASE_URL");
    expect(violation({ engine: "cli", env: { CLAUDE_CODE_API_BASE_URL: "https://api.anthropic.com" } })).toBeNull();
  });

  it("refuses TLS trust overrides, debugger and code-loading keys on the subscription lane", () => {
    for (const env of [
      { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      { NODE_EXTRA_CA_CERTS: "/tmp/proxy-ca.pem" },
      { SSL_CERT_FILE: "/tmp/proxy-ca.pem" },
      { SSL_CERT_DIR: "/tmp/certs" },
      { BUN_INSPECT: "0.0.0.0:6499" },
      { BUN_INSPECT_CONNECT_TO: "unix:///tmp/debug.sock" },
      { BUN_OPTIONS: "--preload /tmp/hook.js" },
      { LD_PRELOAD: "/tmp/hook.so" },
      { NODE_OPTIONS: "--max-old-space-size=4096 --require /tmp/hook.js" },
      { NODE_OPTIONS: "--inspect=0.0.0.0:9229" },
      { NODE_OPTIONS: "--import=/tmp/hook.mjs" },
    ]) {
      const [key] = Object.keys(env);
      const message = violation({ engine: "cli", env });
      expect(message).toContain(key);
      expect(message).toContain("api.anthropic.com");
    }
    expect(violation({ engine: "cli", env: { NODE_TLS_REJECT_UNAUTHORIZED: "1" } })).toBeNull();
    expect(violation({ engine: "cli", env: { NODE_OPTIONS: "--max-old-space-size=4096" } })).toBeNull();
    // The same keys stay allowed on an API-key run.
    expect(
      violation({ engine: "cli", env: { NODE_EXTRA_CA_CERTS: "/tmp/ca.pem", ANTHROPIC_API_KEY: "sk-ant-api03-key" } }),
    ).toBeNull();
  });

  it("matches keys in any case and reads plain bindings; an unresolved binding fails closed", () => {
    expect(violation({ engine: "cli", env: { anthropic_base_url: EVIL } })).toContain("anthropic_base_url");
    expect(violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: { type: "plain", value: EVIL } } })).toContain(
      "ANTHROPIC_BASE_URL",
    );
    expect(
      violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: { type: "plain", value: "https://api.anthropic.com" } } }),
    ).toBeNull();
    expect(
      violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: { type: "secret_ref", secretId: "s" } } }),
    ).toContain("ANTHROPIC_BASE_URL");
  });

  it("checks the env of an inline --settings value in the agent's extra args", () => {
    const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: EVIL } });
    const run = (config: Record<string, unknown>, hostEnv: NodeJS.ProcessEnv = EMPTY_HOST) =>
      resolveClaudeCredentialPolicyViolation({ engine: "cli", config, target: null, hostEnv });
    expect(run({ extraArgs: ["--settings", settings] })).toBe(
      "A Claude subscription is only sent to api.anthropic.com. Remove ANTHROPIC_BASE_URL from the --settings env in the agent's extra args or add an Anthropic API key (ANTHROPIC_API_KEY) to use a custom endpoint.",
    );
    expect(run({ args: [`--settings=${settings}`] })).toContain("ANTHROPIC_BASE_URL");
    expect(run({ extraArgs: ["--settings", JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" } })] })).toContain(
      "NODE_EXTRA_CA_CERTS",
    );
    expect(run({ extraArgs: ["--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } })] }))
      .toBeNull();
    expect(run({ extraArgs: ["--settings", settings], env: { ANTHROPIC_API_KEY: "sk-ant-api03-key" } })).toBeNull();
    // A settings file path is not read here (see the plan's grey area).
    expect(run({ extraArgs: ["--settings", "/etc/claude/settings.json"] })).toBeNull();
  });

  it("leaves the ACP and remote gates unchanged", () => {
    expect(violation({ engine: "acp", env: { ANTHROPIC_BASE_URL: EVIL } })).toBe(CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE);
    expect(violation({ engine: "cli", env: { ANTHROPIC_BASE_URL: EVIL }, target: REMOTE_SANDBOX })).toBe(
      CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE,
    );
    expect(
      violation({ engine: "acp", env: { ANTHROPIC_BASE_URL: EVIL, ANTHROPIC_API_KEY: "sk-ant-api03-key" } }),
    ).toBeNull();
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

describe("subscription token values are never API credentials", () => {
  it("does not count a subscription token in ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN", () => {
    for (const env of [
      { ANTHROPIC_API_KEY: "sk-ant-oat01-subscription" },
      { ANTHROPIC_API_KEY: "  sk-ant-oat01-subscription" },
      { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-subscription" },
    ]) {
      expect(claudeRunHasApiCredential({ config: { env }, targetIsRemote: false, hostEnv: EMPTY_HOST })).toBe(false);
      expect(violation({ engine: "acp", env })).toBe(CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE);
      expect(violation({ engine: "cli", env, target: REMOTE_SANDBOX })).toBe(CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE);
      expect(
        resolveClaudeBillingIdentity({ engine: "cli", targetIsRemote: false, env, hostEnv: EMPTY_HOST }).billingType,
      ).toBe("subscription");
    }
    // A subscription token in the host env is not a credential either.
    expect(
      claudeRunHasApiCredential({
        config: {},
        targetIsRemote: false,
        hostEnv: { ANTHROPIC_API_KEY: "sk-ant-oat01-host" },
      }),
    ).toBe(false);
    expect(
      resolveClaudeBillingIdentity({
        engine: "cli",
        targetIsRemote: false,
        env: {},
        hostEnv: { ANTHROPIC_API_KEY: "sk-ant-oat01-host" },
      }).billingType,
    ).toBe("subscription");
    expect(
      resolveClaudeBillingIdentity({
        engine: "cli",
        targetIsRemote: false,
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-key" },
        hostEnv: EMPTY_HOST,
      }).billingType,
    ).toBe("api");
  });

  it("drops every token key and every token value from an env map", () => {
    expect(
      withoutClaudeSubscriptionTokens({
        CLAUDE_CODE_OAUTH_TOKEN: "x",
        anthropic_oauth_token: "x",
        ANTHROPIC_TOKEN: "x",
        ANTHROPIC_API_KEY: "sk-ant-oat01-x",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
        KEEP: "kept",
        BINDING: { type: "secret_ref", secretId: "s" },
      }),
    ).toEqual({ ANTHROPIC_AUTH_TOKEN: "gateway-token", KEEP: "kept", BINDING: { type: "secret_ref", secretId: "s" } });
  });
});

describe("isClaudeSubscriptionLaneRun", () => {
  it("is a local CLI run with no API credential", () => {
    expect(isClaudeSubscriptionLaneRun({ config: {}, target: null, hostEnv: EMPTY_HOST })).toBe(true);
    expect(isClaudeSubscriptionLaneRun({ config: { engine: "cli" }, hostEnv: EMPTY_HOST })).toBe(true);
    expect(
      isClaudeSubscriptionLaneRun({
        config: { env: { ANTHROPIC_API_KEY: "sk-ant-oat01-x" } },
        hostEnv: EMPTY_HOST,
      }),
    ).toBe(true);
  });

  it("is not the lane with an API credential, a remote target, or the ACP engine", () => {
    expect(
      isClaudeSubscriptionLaneRun({ config: { env: { ANTHROPIC_API_KEY: "sk-ant-api03-x" } }, hostEnv: EMPTY_HOST }),
    ).toBe(false);
    expect(isClaudeSubscriptionLaneRun({ config: {}, hostEnv: { ANTHROPIC_API_KEY: "sk-ant-api03-host" } })).toBe(false);
    expect(isClaudeSubscriptionLaneRun({ config: { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, hostEnv: EMPTY_HOST })).toBe(
      false,
    );
    expect(isClaudeSubscriptionLaneRun({ config: {}, target: REMOTE_SANDBOX, hostEnv: EMPTY_HOST })).toBe(false);
    expect(isClaudeSubscriptionLaneRun({ config: {}, targetIsRemote: true, hostEnv: EMPTY_HOST })).toBe(false);
    expect(isClaudeSubscriptionLaneRun({ config: { engine: "ACP" }, hostEnv: EMPTY_HOST })).toBe(false);
  });

  it("ignores the host env for a managed AI connection", () => {
    expect(
      isClaudeSubscriptionLaneRun({
        config: { managedAiConnection: { provider: "anthropic" }, env: { ANTHROPIC_API_KEY: "sk-ant-api03-x" } },
        hostEnv: EMPTY_HOST,
      }),
    ).toBe(false);
  });
});

describe("claudeConfigDeclaresApiCredential", () => {
  it("counts API key bindings, gateway tokens, and cloud provider flags", () => {
    expect(claudeConfigDeclaresApiCredential({ env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s" } } })).toBe(true);
    expect(claudeConfigDeclaresApiCredential({ env: { ANTHROPIC_API_KEY: { type: "user_secret_ref", key: "k" } } })).toBe(true);
    expect(claudeConfigDeclaresApiCredential({ env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api03" } } })).toBe(true);
    expect(claudeConfigDeclaresApiCredential({ env: { ANTHROPIC_AUTH_TOKEN: "gateway" } })).toBe(true);
    expect(claudeConfigDeclaresApiCredential({ env: { CLAUDE_CODE_USE_VERTEX: { type: "plain", value: "1" } } })).toBe(true);
    expect(claudeConfigDeclaresApiCredential({ managedAiConnection: { provider: "anthropic" } })).toBe(true);
  });

  it("does not count an empty value, a subscription token, or nothing", () => {
    expect(claudeConfigDeclaresApiCredential({})).toBe(false);
    expect(claudeConfigDeclaresApiCredential({ env: { ANTHROPIC_API_KEY: { type: "plain", value: " " } } })).toBe(false);
    expect(claudeConfigDeclaresApiCredential({ env: { ANTHROPIC_API_KEY: "sk-ant-oat01-x" } })).toBe(false);
    expect(claudeConfigDeclaresApiCredential({ env: { CLAUDE_CODE_USE_BEDROCK: "0" } })).toBe(false);
  });
});
