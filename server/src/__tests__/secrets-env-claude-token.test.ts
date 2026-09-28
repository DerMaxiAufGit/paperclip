import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE,
  CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { secretService } from "../services/secrets.js";

// The Claude subscription token check runs before any database access, so a
// stub database is enough. Every env persistence path (agent adapterConfig,
// project, routine, pipeline, environment, company import) goes through here.
const svc = secretService({} as never);

describe("secret env normalization rejects a Claude subscription token", () => {
  for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "claude_code_oauth_token"]) {
    it(`normalizeEnvBindingsForPersistence rejects ${key} with 422`, async () => {
      await expect(
        svc.normalizeEnvBindingsForPersistence("company-1", { [key]: { type: "plain", value: "x" } }),
      ).rejects.toMatchObject({ status: 422, message: CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE });
    });

    it(`normalizeAdapterConfigForPersistence rejects ${key} in adapterConfig.env with 422`, async () => {
      await expect(
        svc.normalizeAdapterConfigForPersistence("company-1", {
          model: "claude-opus",
          env: { [key]: { type: "plain", value: "x" } },
        }),
      ).rejects.toMatchObject({ status: 422, message: CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE });
    });
  }

  it("still accepts an Anthropic API key", async () => {
    await expect(
      svc.normalizeEnvBindingsForPersistence("company-1", { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant" } }),
    ).resolves.toEqual({ ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant" } });
  });
});

describe("secrets reject Claude subscription tokens by value and by every token key", () => {
  it("rejects the other subscription token keys", async () => {
    for (const key of ["ANTHROPIC_OAUTH_TOKEN", "anthropic_token"]) {
      await expect(
        svc.normalizeEnvBindingsForPersistence("company-1", { [key]: { type: "plain", value: "x" } }),
      ).rejects.toMatchObject({ status: 422, message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE });
    }
  });

  it("rejects a subscription token value under any env key", async () => {
    for (const binding of [{ type: "plain", value: "sk-ant-oat01-x" }, " sk-ant-oat01-x"]) {
      await expect(
        svc.normalizeEnvBindingsForPersistence("company-1", { ANTHROPIC_API_KEY: binding }),
      ).rejects.toMatchObject({
        status: 422,
        message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
        details: { code: "claude_subscription_token_unsupported", key: "ANTHROPIC_API_KEY" },
      });
    }
    await expect(
      svc.normalizeAdapterConfigForPersistence("company-1", {
        env: { SOME_TOKEN: { type: "plain", value: "sk-ant-oat01-x" } },
      }),
    ).rejects.toMatchObject({ status: 422, message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE });
  });

  it("rejects creating or rotating a company secret whose value is a subscription token", async () => {
    await expect(
      svc.create("company-1", { name: "claude", provider: "local_encrypted", value: "sk-ant-oat01-x" }),
    ).rejects.toMatchObject({ status: 422, message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE });
    // Rotation reads the secret's company for its lock before the value check.
    const secretRow = { id: "secret-1", companyId: "company-1", status: "active" };
    const rotating = secretService({
      select: () => ({ from: () => ({ where: () => Promise.resolve([secretRow]) }) }),
    } as never);
    await expect(rotating.rotate("secret-1", { value: "sk-ant-oat01-x" })).rejects.toMatchObject({
      status: 422,
      message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
    });
  });

  it("rejects a subscription token inside a longer env or secret value", async () => {
    const headers = "Authorization: Bearer sk-ant-oat01-embedded";
    await expect(
      svc.normalizeEnvBindingsForPersistence("company-1", { ANTHROPIC_CUSTOM_HEADERS: headers }),
    ).rejects.toMatchObject({
      status: 422,
      message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
      details: { code: "claude_subscription_token_unsupported", key: "ANTHROPIC_CUSTOM_HEADERS" },
    });
    await expect(
      svc.create("company-1", { name: "headers", provider: "local_encrypted", value: headers }),
    ).rejects.toMatchObject({ status: 422, message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE });
  });

  it("rejects creating a user secret whose value is a subscription token", async () => {
    await expect(
      svc.createCurrentUserSecretValue("company-1", "user-1", { definitionKey: "claude", value: "sk-ant-oat01-x" }),
    ).rejects.toMatchObject({ status: 422, message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE });
  });
});

describe("secret binding proposals reject a Claude subscription token path", () => {
  it("rejects env.CLAUDE_CODE_OAUTH_TOKEN as the target or source path before any lookup", async () => {
    const { createSecretProposalsService } = await import("../services/secret-proposals.js");
    const proposals = createSecretProposalsService({} as never);
    const context = { companyId: "company-1", heartbeatRunId: "run-1" };
    const base = { justification: "needed", bindingTargetPolicy: "self_and_reports" as const };
    await expect(
      proposals.createBinding(context, {
        ...base,
        secretId: "11111111-1111-4111-8111-111111111111",
        configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
      }),
    ).rejects.toMatchObject({ status: 422, message: CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE });
    await expect(
      proposals.createBinding(context, {
        ...base,
        sourceConfigPath: "env.claude_code_oauth_token",
        configPath: "env.OTHER_KEY",
      }),
    ).rejects.toMatchObject({ status: 422, message: CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE });
  });
});

describe("runtime service base env", () => {
  it("drops a host Claude subscription token", async () => {
    const { sanitizeRuntimeServiceBaseEnv } = await import("../services/workspace-runtime.js");
    const env = sanitizeRuntimeServiceBaseEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-host",
      claude_code_oauth_token: "sk-ant-oat01-lower",
      KEEP_ME: "kept",
    });
    expect(env).toEqual({ KEEP_ME: "kept" });
  });

  it("drops a Claude subscription token value under any key, in the base env and in overrides", async () => {
    const { sanitizeRuntimeServiceBaseEnv, withoutClaudeSubscriptionTokenEntries } = await import(
      "../services/workspace-runtime.js"
    );
    expect(
      sanitizeRuntimeServiceBaseEnv({
        ANTHROPIC_API_KEY: " sk-ant-oat01-pasted",
        MY_REFRESH: "sk-ant-ort01-host",
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "anything",
        OPENAI_API_KEY: "sk-openai",
      }),
    ).toEqual({ OPENAI_API_KEY: "sk-openai" });
    expect(
      withoutClaudeSubscriptionTokenEntries({
        ...sanitizeRuntimeServiceBaseEnv({ KEEP_ME: "kept" }),
        ANTHROPIC_API_KEY: "sk-ant-oat01-adapter-env",
        SERVICE_TOKEN: "sk-ant-sid01-service-env",
        ANTHROPIC_TOKEN: "x",
        PORT: "3000",
      } as Record<string, string>),
    ).toEqual({ KEEP_ME: "kept", PORT: "3000" });
  });
});

// The http adapter sends `headers` and `payloadTemplate` to its URL and the
// OpenClaw gateway sends `headers` and `authToken`, so a token in any adapter
// config leaf, not only in `env`, would be stored and forwarded on every run.
describe("adapter config leaves never carry a Claude subscription token", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const nest = (levels: number, leaf: unknown): unknown => {
    let value = leaf;
    for (let i = 0; i < levels; i += 1) value = { l: value };
    return value;
  };

  it("normalizeAdapterConfigForPersistence rejects a token in any nested string leaf or key", async () => {
    const cases: Array<{ config: Record<string, unknown>; path: string }> = [
      { config: { url: "https://x.test", headers: { "x-api-key": "sk-ant-oat01-headervalue" } }, path: "headers.x-api-key" },
      { config: { headers: { Authorization: "Bearer sk-ant-oat01-bearervalue" } }, path: "headers.Authorization" },
      {
        config: { payloadTemplate: { messages: [{ content: "hi" }, { auth: ["ok", " SK-ANT-ORT01-refresh"] }] } },
        path: "payloadTemplate.messages[1].auth[1]",
      },
      { config: { authToken: "sk-ant-sid01-sessionvalue" }, path: "authToken" },
      { config: { extraArgs: ["--token", "sk-ant-oat01-argvalue"] }, path: "extraArgs[1]" },
      { config: { payloadTemplate: '{"key":"sk-ant-oat01-jsonvalue"}' }, path: "payloadTemplate" },
      { config: { headers: { "sk-ant-oat01-keyvalue": "x" } }, path: "headers.[token key]" },
    ];
    for (const { config, path } of cases) {
      const error = await svc.normalizeAdapterConfigForPersistence("company-1", config).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({
        status: 422,
        message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
        details: { code: "claude_subscription_token_unsupported", path },
      });
      expect(JSON.stringify((error as { details?: unknown }).details)).not.toMatch(/sk-ant-/i);
    }
  });

  it("normalizeAdapterConfigForPersistence refuses a config nested past the walk bound", async () => {
    await expect(
      svc.normalizeAdapterConfigForPersistence("company-1", { payloadTemplate: nest(40, "fine") }),
    ).rejects.toMatchObject({ status: 422, details: { code: "adapter_config_too_deep" } });
  });

  it("normalizeAdapterConfigForPersistence keeps every non-token value", async () => {
    const config = {
      url: "https://x.test",
      headers: { "x-api-key": "sk-ant-api03-real-key", Authorization: "Bearer sk-ant-api03-real-key" },
      promptTemplate: "Never paste sk-ant-oat tokens here.",
      extraArgs: ["--flag", "value"],
      payloadTemplate: { n: 1, ok: true, nil: null, list: [[1, "two"]], deep: nest(20, "fine") },
      env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api03-real-key" } },
    };
    await expect(svc.normalizeAdapterConfigForPersistence("company-1", config)).resolves.toEqual(config);
  });

  it("resolveAdapterConfigForRuntime drops token leaves of a stored config and logs only their paths", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const stored = {
      url: "https://x.test",
      model: "m",
      headers: {
        Authorization: "Bearer sk-ant-oat01-bearervalue",
        "x-api-key": "sk-ant-api03-real-key",
        "sk-ant-oat01-keyvalue": "x",
      },
      payloadTemplate: { a: ["keep", " sk-ant-ort01-refresh", { token: "SK-ANT-SID01-session" }], b: 2 },
      authToken: "sk-ant-oat01-authvalue",
      env: { KEEP: "kept", ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-ant-oat01-envvalue" },
    };
    const snapshot = structuredClone(stored);

    const result = await svc.resolveAdapterConfigForRuntime("company-1", stored);

    expect(result.config).toEqual({
      url: "https://x.test",
      model: "m",
      headers: { "x-api-key": "sk-ant-api03-real-key" },
      payloadTemplate: { a: ["keep", "", {}], b: 2 },
      env: { KEEP: "kept" },
    });
    expect(stored).toEqual(snapshot);
    const loggedPaths = warn.mock.calls.map(([fields]) => fields as unknown as Record<string, unknown>);
    for (const configPath of [
      "headers.Authorization",
      "headers.[token key]",
      "payloadTemplate.a[1]",
      "payloadTemplate.a[2].token",
      "authToken",
      "env.ANTHROPIC_CUSTOM_HEADERS",
    ]) {
      expect(loggedPaths).toContainEqual(expect.objectContaining({ companyId: "company-1", configPath }));
    }
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sk-ant-(oat|ort|sid)/i);
  });

  it("resolveAdapterConfigForRuntime drops a subtree nested past the walk bound", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const result = await svc.resolveAdapterConfigForRuntime("company-1", {
      model: "m",
      payloadTemplate: { shallow: "ok", deep: nest(40, "sk-ant-oat01-hidden") },
    });
    expect(result.config).toMatchObject({ model: "m", payloadTemplate: { shallow: "ok" } });
    expect(JSON.stringify(result.config)).not.toMatch(/sk-ant-/i);
  });

  it("resolveAdapterConfigForRuntime leaves a token-free config untouched", async () => {
    const warn = vi.spyOn(logger, "warn");
    const headers = { "x-api-key": "sk-ant-api03-real-key" };
    const payloadTemplate = { messages: [{ role: "user", content: "The sk-ant-oat prefix alone is not a token" }] };
    const result = await svc.resolveAdapterConfigForRuntime("company-1", {
      url: "https://x.test",
      headers,
      payloadTemplate,
    });
    expect(result.config).toEqual({ url: "https://x.test", headers, payloadTemplate });
    // Nothing is copied when no leaf carries a token.
    expect(result.config.headers).toBe(headers);
    expect(result.config.payloadTemplate).toBe(payloadTemplate);
    expect(warn).not.toHaveBeenCalled();
  });
});
