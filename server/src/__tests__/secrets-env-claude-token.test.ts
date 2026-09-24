import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE } from "@paperclipai/shared";
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
});
