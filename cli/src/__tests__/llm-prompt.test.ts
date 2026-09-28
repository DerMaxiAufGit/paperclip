import { beforeEach, describe, expect, it, vi } from "vitest";
import * as p from "@clack/prompts";
import { CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE } from "@paperclipai/shared";
import { promptLlm } from "../prompts/llm.js";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
}));

type PasswordOptions = {
  message: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

// `paperclipai onboard` sends the key to the provider to check it, and
// `paperclipai configure` writes it into the config file. A Claude
// subscription token is refused at the prompt, before either happens.
describe("promptLlm", () => {
  let validate: PasswordOptions["validate"];

  beforeEach(() => {
    vi.clearAllMocks();
    validate = undefined;
    vi.mocked(p.confirm).mockResolvedValue(true);
    vi.mocked(p.password).mockImplementation(async (opts) => {
      validate = (opts as unknown as PasswordOptions).validate;
      return "sk-ant-api03-key";
    });
  });

  it.each(["claude", "openai"] as const)("refuses a Claude subscription token as the %s API key", async (provider) => {
    vi.mocked(p.select).mockResolvedValue(provider as never);

    await expect(promptLlm()).resolves.toEqual({ provider, apiKey: "sk-ant-api03-key" });

    for (const token of ["sk-ant-oat01-pasted", " SK-ANT-ORT01-refresh", "sk-ant-sid01-session"]) {
      expect(validate?.(token)).toBe(CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE);
    }
    expect(validate?.("")).toBe("API key is required");
    expect(validate?.("sk-ant-api03-key")).toBeUndefined();
  });
});
