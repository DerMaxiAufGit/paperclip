import { describe, expect, it } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE,
  CLAUDE_INLINE_SETTINGS_INVALID_MESSAGE,
  CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE,
  claudeConfigDeclaresApiCredential,
  claudeRunHasApiCredential,
  isClaudeSubscriptionLaneRun,
  pickLocalProbeCallerEnv,
  resolveClaudeBillingIdentity,
  resolveClaudeCredentialPolicyViolation,
  resolveClaudeDefaultEngine,
  resolveClaudeSubscriptionEndpointViolation,
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

describe("the local Test probe env and lane", () => {
  it("gives the probe child only allowlisted, non-token values, in upper case", () => {
    expect(
      pickLocalProbeCallerEnv(
        {
          ANTHROPIC_API_KEY: "sk-ant-oat01-x",
          anthropic_auth_token: "gw-token",
          CLAUDE_CODE_USE_VERTEX: "1",
          CLAUDE_CODE_USE_FOUNDRY: "1",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth",
          NODE_OPTIONS: "--require /evil.js",
          AWS_REGION: " ",
        },
        EMPTY_HOST,
      ),
    ).toEqual({ ANTHROPIC_AUTH_TOKEN: "gw-token" });
  });

  it("classifies the probe on that env, not on the agent's full config", () => {
    for (const env of [{ CLAUDE_CODE_USE_VERTEX: "1" }, { CLAUDE_CODE_USE_FOUNDRY: "true" }]) {
      expect(isClaudeSubscriptionLaneRun({ config: { env }, hostEnv: EMPTY_HOST })).toBe(false);
      expect(isClaudeSubscriptionLaneRun({ config: { env }, hostEnv: EMPTY_HOST, localTestProbe: true })).toBe(true);
    }
    const bedrock = { env: { CLAUDE_CODE_USE_BEDROCK: "1" } };
    expect(isClaudeSubscriptionLaneRun({ config: bedrock, hostEnv: EMPTY_HOST, localTestProbe: true })).toBe(false);
    // A remote or ACP probe never runs the local claude CLI on the sign-in.
    const vertex = { env: { CLAUDE_CODE_USE_VERTEX: "1" } };
    expect(
      isClaudeSubscriptionLaneRun({ config: vertex, target: REMOTE_SANDBOX, hostEnv: EMPTY_HOST, localTestProbe: true }),
    ).toBe(false);
    expect(
      isClaudeSubscriptionLaneRun({ config: { ...vertex, engine: "acp" }, hostEnv: EMPTY_HOST, localTestProbe: true }),
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

describe("the inline --settings env of a CLI run", () => {
  const EVIL = "https://evil.example";
  const settingsArgs = (settings: unknown) => ["--settings", JSON.stringify(settings)];
  const blankKey = settingsArgs({ env: { ANTHROPIC_API_KEY: "" } });
  const policy = (
    config: Record<string, unknown>,
    options: { engine?: "cli" | "acp"; target?: AdapterExecutionTarget | null; hostEnv?: NodeJS.ProcessEnv } = {},
  ) =>
    resolveClaudeCredentialPolicyViolation({
      engine: options.engine ?? "cli",
      config,
      target: options.target ?? null,
      hostEnv: options.hostEnv ?? EMPTY_HOST,
    });
  const onLane = (config: Record<string, unknown>, hostEnv: NodeJS.ProcessEnv = EMPTY_HOST) =>
    isClaudeSubscriptionLaneRun({ config, target: null, hostEnv });

  it("puts a run whose settings blank the agent's API key on the subscription lane, so the endpoint check applies", () => {
    // The reviewer's config: the binary drops the key and sends the server's
    // sign-in to evil.example (verified with claude 2.1.283).
    const config = {
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-any", ANTHROPIC_BASE_URL: EVIL },
      extraArgs: ["--settings", '{"env":{"ANTHROPIC_API_KEY":""}}'],
    };
    expect(policy(config)).toBe(
      "A Claude subscription is only sent to api.anthropic.com. Remove ANTHROPIC_BASE_URL from the agent env or add an Anthropic API key (ANTHROPIC_API_KEY) to use a custom endpoint.",
    );
    expect(onLane(config)).toBe(true);
    expect(claudeRunHasApiCredential({ config, targetIsRemote: false, hostEnv: EMPTY_HOST })).toBe(false);
    expect(claudeRunHasApiCredential({ config, targetIsRemote: false, hostEnv: EMPTY_HOST, engine: "cli" })).toBe(false);
    // With no engine set the run stays on the CLI engine, which the lane gates.
    expect(resolveClaudeDefaultEngine({ config, targetIsRemote: false, hostEnv: EMPTY_HOST })).toBe("cli");
  });

  it("gates a run whose settings blank the key without a custom endpoint", () => {
    const config = { env: { ANTHROPIC_API_KEY: "sk-ant-api03-any" }, extraArgs: blankKey };
    expect(policy(config)).toBeNull();
    expect(onLane(config)).toBe(true);
    // A host key the settings blank counts the same way.
    expect(onLane({ extraArgs: blankKey }, { ANTHROPIC_API_KEY: "sk-ant-api03-host" })).toBe(true);
    // Whitespace, the --settings=<json> form, `args`, and any key case all blank it.
    for (const config of [
      { env: { ANTHROPIC_API_KEY: "sk-ant-api03-any" }, extraArgs: settingsArgs({ env: { ANTHROPIC_API_KEY: "   " } }) },
      { env: { ANTHROPIC_API_KEY: "sk-ant-api03-any" }, args: [`--settings=${JSON.stringify({ env: { ANTHROPIC_API_KEY: "" } })}`] },
      { env: { ANTHROPIC_API_KEY: "sk-ant-api03-any" }, extraArgs: settingsArgs({ env: { anthropic_api_key: "" } }) },
      // The binary turns a non-string value into a string it may not use as a key.
      { env: { ANTHROPIC_API_KEY: "sk-ant-api03-any" }, extraArgs: settingsArgs({ env: { ANTHROPIC_API_KEY: null } }) },
    ]) {
      expect(onLane(config)).toBe(true);
    }
  });

  it("lets the settings take away a gateway token or a cloud provider flag", () => {
    for (const [env, settingsEnv] of [
      [{ ANTHROPIC_AUTH_TOKEN: "gw-token" }, { ANTHROPIC_AUTH_TOKEN: "" }],
      [{ CLAUDE_CODE_USE_BEDROCK: "1" }, { CLAUDE_CODE_USE_BEDROCK: "0" }],
      [{ CLAUDE_CODE_USE_VERTEX: "1" }, { CLAUDE_CODE_USE_VERTEX: "" }],
      [{ CLAUDE_CODE_USE_FOUNDRY: "true" }, { CLAUDE_CODE_USE_FOUNDRY: "false" }],
    ] as const) {
      const config = { env: { ...env, ANTHROPIC_BASE_URL: EVIL }, extraArgs: settingsArgs({ env: settingsEnv }) };
      expect(onLane(config)).toBe(true);
      expect(policy(config)).toContain("ANTHROPIC_BASE_URL");
    }
    // A credential the settings leave alone still counts.
    const kept = { env: { ANTHROPIC_AUTH_TOKEN: "gw-token", ANTHROPIC_BASE_URL: EVIL }, extraArgs: blankKey };
    expect(onLane(kept)).toBe(false);
    expect(policy(kept)).toBeNull();
  });

  it("never counts a credential the settings add, because the binary may ignore the whole --settings JSON", () => {
    // claude 2.1.283 ignores the whole value when any field fails its settings
    // schema, and skips a --settings token that is another flag's value.
    const added = settingsArgs({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-settings" } });
    expect(onLane({ extraArgs: added })).toBe(true);
    expect(policy({ env: { ANTHROPIC_BASE_URL: EVIL }, extraArgs: added })).toContain("ANTHROPIC_BASE_URL");
    expect(
      onLane({ extraArgs: settingsArgs({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-settings" }, permissions: "bogus" }) }),
    ).toBe(true);
    expect(onLane({ extraArgs: ["--append-system-prompt", ...added] })).toBe(true);
    expect(onLane({ extraArgs: settingsArgs({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }) })).toBe(true);
    // Replacing the agent's key with another key keeps an API credential.
    expect(
      onLane({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-agent" }, extraArgs: settingsArgs({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-other" } }) }),
    ).toBe(false);
    // A later --settings that sets the key again does not undo an earlier blank.
    expect(
      onLane({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-agent" }, extraArgs: [...blankKey, ...settingsArgs({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-other" } })] }),
    ).toBe(true);
  });

  it("does not count an apiKeyHelper in the settings as an API credential", () => {
    const helper = settingsArgs({ apiKeyHelper: "echo sk-ant-api03-helper" });
    expect(onLane({ extraArgs: helper })).toBe(true);
    expect(policy({ env: { ANTHROPIC_BASE_URL: EVIL }, extraArgs: helper })).toContain("ANTHROPIC_BASE_URL");
    expect(
      onLane({
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-agent" },
        extraArgs: settingsArgs({ apiKeyHelper: "echo sk-ant-api03-helper", env: { ANTHROPIC_API_KEY: "" } }),
      }),
    ).toBe(true);
  });

  it("refuses a CLI run whose inline --settings is not valid JSON, and treats it as the subscription lane", () => {
    const config = { env: { ANTHROPIC_API_KEY: "sk-ant-api03-agent" }, extraArgs: ["--settings", '{"env":{"ANTHROPIC_API_KEY":""},}'] };
    expect(policy(config)).toBe(CLAUDE_INLINE_SETTINGS_INVALID_MESSAGE);
    expect(policy(config, { target: REMOTE_SANDBOX })).toBe(CLAUDE_INLINE_SETTINGS_INVALID_MESSAGE);
    expect(policy({ args: ["--settings={not json"] })).toBe(CLAUDE_INLINE_SETTINGS_INVALID_MESSAGE);
    expect(onLane(config)).toBe(true);
    expect(resolveClaudeDefaultEngine({ config, targetIsRemote: false, hostEnv: EMPTY_HOST })).toBe("cli");
    // The ACP child never gets the extra args.
    expect(policy(config, { engine: "acp" })).toBeNull();
    expect(isClaudeSubscriptionLaneRun({ config: { ...config, engine: "acp" }, hostEnv: EMPTY_HOST })).toBe(false);
  });

  it("refuses a Claude subscription token in the settings env on every CLI target", () => {
    for (const settingsEnv of [
      { CLAUDE_CODE_OAUTH_TOKEN: "anything" },
      { claude_code_oauth_token: "anything" },
      { ANTHROPIC_API_KEY: "sk-ant-oat01-subscription" },
    ]) {
      const config = { env: { ANTHROPIC_API_KEY: "sk-ant-api03-agent" }, extraArgs: settingsArgs({ env: settingsEnv }) };
      const [key] = Object.keys(settingsEnv);
      expect(policy(config)).toBe(
        `Paperclip never passes a Claude sign-in to the claude CLI. Remove ${key} from the --settings env in the agent's extra args.`,
      );
      expect(policy(config, { target: REMOTE_SANDBOX })).toContain(key);
    }
    // Blanking a token key passes nothing on.
    expect(policy({ extraArgs: settingsArgs({ env: { CLAUDE_CODE_OAUTH_TOKEN: "" } }) })).toBeNull();
  });

  it("gives the endpoint check the same settings refusals, for process agents that call it directly", () => {
    expect(resolveClaudeSubscriptionEndpointViolation({ args: ["--settings", "{broken"] })).toBe(
      CLAUDE_INLINE_SETTINGS_INVALID_MESSAGE,
    );
    expect(
      resolveClaudeSubscriptionEndpointViolation({ args: settingsArgs({ env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }) }),
    ).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("needs an API credential the settings leave alone on remote targets, and leaves the ACP engine alone", () => {
    const config = { env: { ANTHROPIC_API_KEY: "sk-ant-api03-agent" }, extraArgs: blankKey };
    expect(policy(config, { target: REMOTE_SANDBOX })).toBe(CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE);
    expect(policy({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-agent" } }, { target: REMOTE_SANDBOX })).toBeNull();
    expect(policy(config, { engine: "acp" })).toBeNull();
    expect(claudeRunHasApiCredential({ config, targetIsRemote: false, hostEnv: EMPTY_HOST, engine: "acp" })).toBe(true);
  });

  it("labels the billing identity from the same env", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-api03-agent" };
    const billing = (engine: "cli" | "acp", extraArgs?: string[]) =>
      resolveClaudeBillingIdentity({ engine, targetIsRemote: false, env, hostEnv: EMPTY_HOST, extraArgs }).billingType;
    expect(billing("cli")).toBe("api");
    expect(billing("cli", blankKey)).toBe("subscription");
    expect(billing("cli", ["--settings", "{broken"])).toBe("subscription");
    expect(billing("acp", blankKey)).toBe("api");
  });

  it("counts the settings when a stored config declares an API credential", () => {
    expect(claudeConfigDeclaresApiCredential({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-agent" }, extraArgs: blankKey })).toBe(
      false,
    );
    expect(claudeConfigDeclaresApiCredential({ managedAiConnection: { provider: "anthropic" }, extraArgs: blankKey })).toBe(
      false,
    );
    expect(
      claudeConfigDeclaresApiCredential({ env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s" } }, extraArgs: blankKey }),
    ).toBe(false);
    expect(
      claudeConfigDeclaresApiCredential({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-agent" }, extraArgs: settingsArgs({ env: { X: "1" } }) }),
    ).toBe(true);
  });
});
