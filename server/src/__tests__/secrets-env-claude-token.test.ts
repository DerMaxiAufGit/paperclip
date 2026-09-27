import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE,
  CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
} from "@paperclipai/shared";
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
