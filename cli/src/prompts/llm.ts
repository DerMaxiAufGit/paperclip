import * as p from "@clack/prompts";
import {
  CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
  isClaudeSubscriptionTokenValue,
} from "@paperclipai/shared";
import type { LlmConfig } from "../config/schema.js";

export async function promptLlm(): Promise<LlmConfig | undefined> {
  const configureLlm = await p.confirm({
    message: "Configure an LLM provider now?",
    initialValue: false,
  });

  if (p.isCancel(configureLlm)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (!configureLlm) return undefined;

  const provider = await p.select({
    message: "LLM provider",
    options: [
      { value: "claude" as const, label: "Claude (Anthropic)" },
      { value: "openai" as const, label: "OpenAI" },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const apiKey = await p.password({
    message: `${provider === "claude" ? "Anthropic" : "OpenAI"} API key`,
    validate: (val) => {
      if (!val) return "API key is required";
      // Refused before onboard sends the key to the provider or configure
      // writes it to the config file.
      if (isClaudeSubscriptionTokenValue(val)) return CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE;
    },
  });

  if (p.isCancel(apiKey)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return { provider, apiKey };
}
