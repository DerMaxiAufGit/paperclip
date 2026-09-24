/** Redacted presentation contracts shared with the production API. */
import { AI_CONNECTION_CAPABILITIES, aiConnectionMetadataSchema, type AiProvider, type AiAuthMethod, type AiManagedConnectionSummary, type AiConnectionBinding } from "@paperclipai/shared";
export type { AiProvider, AiAuthMethod, AiConnectionBinding } from "@paperclipai/shared";
export type AiConnectionStatus = AiManagedConnectionSummary["status"];

export const AI_PROVIDERS: Record<
  AiProvider,
  { name: string; subscriptionName?: string; logo?: string }
> = {
  // No subscription connection: see CLAUDE_SUBSCRIPTION_CLI_NOTE.
  anthropic: {
    name: "Claude",
    logo: "/brands/claude-color.svg",
  },
  openai: {
    name: "OpenAI",
    subscriptionName: "ChatGPT subscription",
    logo: "/brands/codex-color.svg",
  },
  openrouter: { name: "OpenRouter", logo: "/brands/apps/openrouter.svg" },
  xai: {
    name: "Grok",
    subscriptionName: "Grok subscription",
    logo: "/brands/adapters/grok.svg",
  },
};

export type AiConnectionSummary = Omit<AiManagedConnectionSummary, "isDefault"> & { isDefault?: boolean };

export interface AiConnectionRequirement {
  companyId: string;
  provider: AiProvider;
  method?: AiAuthMethod;
}

export const AI_CONNECTION_STATUS: Record<AiConnectionStatus, string> = {
  connected: "Connected",
  needs_attention: "Needs attention",
  expired: "Expired",
  revoked: "Revoked",
};

/**
 * A Claude subscription is never connected here. It is used only through the
 * claude CLI signed in on the Paperclip server; Paperclip does not import it.
 */
export const CLAUDE_SUBSCRIPTION_CLI_NOTE =
  "Claude subscriptions are used through the claude CLI signed in on this server.";

export function aiMethodSupported(provider: AiProvider, method: AiAuthMethod) {
  return Boolean(AI_CONNECTION_CAPABILITIES[provider].methods[method]);
}

/** The method a new connection for this provider starts with. */
export function defaultAiMethod(provider: AiProvider): AiAuthMethod {
  return aiMethodSupported(provider, "subscription") ? "subscription" : "api_key";
}

/** Why this provider cannot connect with this method, or null when it can. */
export function aiMethodUnsupportedMessage(provider: AiProvider, method: AiAuthMethod) {
  if (aiMethodSupported(provider, method)) return null;
  return provider === "anthropic"
    ? CLAUDE_SUBSCRIPTION_CLI_NOTE
    : "This provider does not offer a subscription connection.";
}

/** The same answer for a saved connection's `config.ai` metadata. */
export function aiConnectionConfigUnsupportedMessage(config: Record<string, unknown> | undefined) {
  const metadata = aiConnectionMetadataSchema.safeParse(config?.ai);
  return metadata.success ? aiMethodUnsupportedMessage(metadata.data.provider, metadata.data.method) : null;
}

export function aiMethodLabel(provider: AiProvider, method: AiAuthMethod) {
  return method === "subscription"
    ? (AI_PROVIDERS[provider].subscriptionName ?? "Subscription unavailable")
    : "API key";
}

export function matchesAiRequirement(
  connection: AiConnectionSummary,
  requirement: AiConnectionRequirement,
) {
  return (
    connection.companyId === requirement.companyId &&
    connection.provider === requirement.provider &&
    (requirement.method === undefined || connection.method === requirement.method)
  );
}

export function personalAiDefault(
  connections: AiConnectionSummary[],
  requirement: AiConnectionRequirement,
  userId: string,
) {
  // Never choose another account because the declared default is unhealthy.
  return connections.find(
    (connection) =>
      matchesAiRequirement(connection, { ...requirement, method: undefined }) &&
      connection.ownership === "personal" &&
      connection.ownerUserId === userId &&
      connection.isDefault,
  );
}

export function aiConnectionProblem(connection?: AiConnectionSummary) {
  if (!connection)
    return "No connection selected. Connect an account to continue.";
  // Connections saved before a method was withdrawn stay listed but unusable.
  const unsupported = aiMethodUnsupportedMessage(connection.provider, connection.method);
  if (unsupported) return `${unsupported} Connect an API key instead.`;
  return (
    connection.unavailableReason ??
    (connection.status === "connected"
      ? null
      : `${AI_CONNECTION_STATUS[connection.status]}. Reconnect this account to continue.`)
  );
}

export function bindingProblem(
  binding: AiConnectionBinding,
  requirement: AiConnectionRequirement,
  connections: AiConnectionSummary[],
  userId: string,
  _agentId: string,
) {
  if (
    binding.provider !== requirement.provider ||
    (binding.mode !== "responsible_user" && requirement.method !== undefined && binding.method !== requirement.method)
  )
    return "Choose a connection compatible with this provider and sign-in method.";
  if (binding.mode === "responsible_user")
    return aiConnectionProblem(
      personalAiDefault(connections, requirement, userId),
    );
  const connection = connections.find(
    (item) =>
      item.id === binding.connectionId &&
      item.grantId === binding.grantId &&
      item.method === binding.method &&
      matchesAiRequirement(item, requirement),
  );
  if (!connection)
    return "This connection is no longer available for this agent. Choose another connection.";
  if (binding.mode === "shared" && connection.ownership !== "shared")
    return "Choose a company-shared connection.";
  if (
    binding.mode === "delegated" &&
    (connection.ownership !== "personal" ||
      connection.ownerUserId !== userId)
  )
    return "This credential is not shared with you. Choose a connection you can use.";
  return aiConnectionProblem(connection);
}
