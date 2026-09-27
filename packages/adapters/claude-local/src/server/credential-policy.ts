import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE,
  CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE,
  CLAUDE_SUBSCRIPTION_TOKEN_ENV_KEYS as SHARED_CLAUDE_SUBSCRIPTION_TOKEN_ENV_KEYS,
  isClaudeSubscriptionTokenEnvKey,
  isClaudeSubscriptionTokenValue,
} from "@paperclipai/shared";

export {
  CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE,
  CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE,
  isClaudeSubscriptionTokenValue,
};

/**
 * Claude subscription use is limited to the official `claude` CLI engine
 * running on the Paperclip server itself, where the binary reads the service
 * user's own sign-in. Paperclip never forwards subscription credentials to any
 * other lane. The ACP engine and every remote execution target (SSH, sandbox,
 * runner) therefore need a non-subscription credential: an Anthropic API key,
 * a gateway bearer token (`ANTHROPIC_AUTH_TOKEN`), or a cloud provider
 * (Bedrock, Vertex or Foundry) that bills outside the subscription.
 */
export const CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE =
  "The Claude ACP engine needs an Anthropic API key. Use engine=cli to run with the claude CLI signed in on this server.";

export const CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE =
  "Claude on remote targets needs an Anthropic API key; subscription use is limited to the claude CLI signed in on this server.";

/**
 * Environment keys that carry a Claude subscription credential. Paperclip never
 * forwards them to any engine or execution target, the local CLI lane included:
 * the local `claude` binary uses its own sign-in. A subscription token value
 * (`sk-ant-oat…`) is dropped under any other key too.
 */
export const CLAUDE_SUBSCRIPTION_TOKEN_ENV_KEYS: readonly string[] = SHARED_CLAUDE_SUBSCRIPTION_TOKEN_ENV_KEYS;

export type ClaudeCredentialPolicyEngine = "cli" | "acp";

function providerFlagSet(value: string): boolean {
  return value === "1" || value === "true";
}

/**
 * A non-empty credential value that is not a Claude subscription OAuth token
 * (`sk-ant-oat…`, from `claude setup-token`). A subscription token never counts
 * as an API credential, whatever env key carries it.
 */
function isApiCredentialValue(value: string): boolean {
  return value.length > 0 && !isClaudeSubscriptionTokenValue(value);
}

/**
 * Settings that select a cloud provider but that the ACP child does not inherit
 * from the host environment (see `ACPX_INHERITED_PROVIDER_ENV_KEYS.claude` in
 * adapter-utils). They count only when the adapter env sets them, because the
 * adapter env always reaches the child. A host-only value would let the gate
 * pass while the child still falls back to the service user's Claude sign-in.
 */
const CONFIG_ENV_ONLY_PROVIDER_FLAGS = ["CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] as const;

/**
 * True when the run authenticates with a non-subscription credential. The
 * adapter config env wins over the host env, the same way the launch env is
 * merged. The host env only counts for a local target without a managed AI
 * connection, because a remote target and a managed connection never inherit
 * the host credentials.
 *
 * `ANTHROPIC_BEDROCK_BASE_URL` alone does not count: without
 * `CLAUDE_CODE_USE_BEDROCK` Claude Code ignores it and uses its own sign-in.
 */
export function claudeRunHasApiCredential(input: {
  config: Record<string, unknown>;
  targetIsRemote: boolean;
  hostEnv?: NodeJS.ProcessEnv;
}): boolean {
  const envConfig = parseObject(input.config.env);
  const considerHostEnv = !input.targetIsRemote && !input.config.managedAiConnection;
  const hostEnv = considerHostEnv ? input.hostEnv ?? process.env : {};
  const readConfigured = (key: string): string | null => {
    const configured = envConfig[key];
    return typeof configured === "string" ? configured.trim() : null;
  };
  const read = (key: string): string => {
    const configured = readConfigured(key);
    if (configured !== null) return configured;
    const inherited = hostEnv[key];
    return typeof inherited === "string" ? inherited.trim() : "";
  };
  if (isApiCredentialValue(read("ANTHROPIC_API_KEY"))) return true;
  if (isApiCredentialValue(read("ANTHROPIC_AUTH_TOKEN"))) return true;
  if (providerFlagSet(read("CLAUDE_CODE_USE_BEDROCK"))) return true;
  for (const flag of CONFIG_ENV_ONLY_PROVIDER_FLAGS) {
    if (providerFlagSet(readConfigured(flag) ?? "")) return true;
  }
  return false;
}

/**
 * The engine a claude_local run uses when `engine` is not set. A run with an
 * Anthropic API credential on this server uses ACP, which needs no global
 * `claude` binary (the Agent SDK ships with Paperclip). Every other run uses
 * the CLI engine: a subscription only through the `claude` binary signed in on
 * this server, and a remote target through the CLI installed there.
 */
export function resolveClaudeDefaultEngine(input: {
  config: Record<string, unknown>;
  targetIsRemote: boolean;
  hostEnv?: NodeJS.ProcessEnv;
}): ClaudeCredentialPolicyEngine {
  if (input.targetIsRemote) return "cli";
  return claudeRunHasApiCredential({ config: input.config, targetIsRemote: false, hostEnv: input.hostEnv })
    ? "acp"
    : "cli";
}

/**
 * The single credential gate shared by the CLI engine, the ACP engine, and the
 * environment Test. Returns the user-facing error message when the run must
 * not start, or null when it may start.
 *
 * - Local CLI engine: always allowed; the `claude` binary uses its own sign-in.
 * - Remote target (either engine): needs an API credential.
 * - ACP engine (any target): needs an API credential.
 */
export function resolveClaudeCredentialPolicyViolation(input: {
  engine: ClaudeCredentialPolicyEngine;
  config: Record<string, unknown>;
  target: AdapterExecutionTarget | null | undefined;
  hostEnv?: NodeJS.ProcessEnv;
}): string | null {
  const targetIsRemote = input.target?.kind === "remote";
  if (!targetIsRemote && input.engine === "cli") return null;
  if (claudeRunHasApiCredential({ config: input.config, targetIsRemote, hostEnv: input.hostEnv })) {
    return null;
  }
  return targetIsRemote ? CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE : CLAUDE_ACP_API_KEY_REQUIRED_MESSAGE;
}

export type ClaudeBillingType = "api" | "metered_api" | "subscription" | "unknown";

export interface ClaudeBillingIdentity {
  provider: "anthropic";
  biller: string;
  billingType: ClaudeBillingType;
}

/**
 * Billers for runs that pay per use outside Anthropic. `aws_bedrock` and
 * `google` already have display names on the Costs page; `azure` is added
 * there for Microsoft Foundry.
 */
export const CLAUDE_BEDROCK_BILLER = "aws_bedrock";
export const CLAUDE_VERTEX_BILLER = "google";
export const CLAUDE_FOUNDRY_BILLER = "azure";

/**
 * The biller for a gateway `ANTHROPIC_AUTH_TOKEN` run, from the
 * `ANTHROPIC_BASE_URL` host the token is sent to. No base URL, or an Anthropic
 * host, means Anthropic bills it; OpenRouter is recognized; any other gateway
 * (LiteLLM, a corporate proxy) can route anywhere, so it is `unknown` rather
 * than being counted as Anthropic spend.
 */
function claudeGatewayBiller(baseUrl: string): string {
  if (!baseUrl) return "anthropic";
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host === "anthropic.com" || host.endsWith(".anthropic.com")) return "anthropic";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  return "unknown";
}

/**
 * Classify a claude_local run for the cost ledger. Both engines use this, and
 * it reads the env the same way as `claudeRunHasApiCredential`, so the
 * credential gate and the billing label cannot drift apart.
 *
 * - `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX` or `_FOUNDRY`: `metered_api`, billed by
 *   that cloud provider. `ANTHROPIC_BEDROCK_BASE_URL` alone does not count,
 *   because Claude Code ignores it without `CLAUDE_CODE_USE_BEDROCK`.
 * - `ANTHROPIC_API_KEY` (not a subscription `sk-ant-oat` token): `api`, billed
 *   by Anthropic.
 * - A gateway `ANTHROPIC_AUTH_TOKEN` (not a subscription `sk-ant-oat` token):
 *   `metered_api`, biller from the `ANTHROPIC_BASE_URL` host.
 * - None of these: `subscription` only for the local CLI engine, which runs the
 *   `claude` binary signed in on this server. ACP and remote targets cannot use
 *   a subscription, so a run there with no visible credential (for example an
 *   `apiKeyHelper` in the Claude settings) is `unknown`.
 *
 * `env` is the run's adapter env and wins over `hostEnv`, as in the launch env.
 * The host env counts only for a local target. The ACP child never inherits a
 * host Vertex or Foundry flag, so on ACP those count only from `env`.
 */
export function resolveClaudeBillingIdentity(input: {
  engine: ClaudeCredentialPolicyEngine;
  targetIsRemote: boolean;
  env: Record<string, unknown>;
  hostEnv?: NodeJS.ProcessEnv;
}): ClaudeBillingIdentity {
  const hostEnv = input.targetIsRemote ? {} : input.hostEnv ?? process.env;
  const readConfigured = (key: string): string | null => {
    const configured = input.env[key];
    return typeof configured === "string" ? configured.trim() : null;
  };
  const read = (key: string): string => {
    const configured = readConfigured(key);
    if (configured !== null) return configured;
    const inherited = hostEnv[key];
    return typeof inherited === "string" ? inherited.trim() : "";
  };
  const configEnvOnly = (key: string): boolean =>
    input.engine === "acp" && (CONFIG_ENV_ONLY_PROVIDER_FLAGS as readonly string[]).includes(key);
  const providerFlag = (key: string): boolean =>
    providerFlagSet(configEnvOnly(key) ? readConfigured(key) ?? "" : read(key));
  const identity = (billingType: ClaudeBillingType, biller = "anthropic"): ClaudeBillingIdentity => ({
    provider: "anthropic",
    biller,
    billingType,
  });

  if (providerFlag("CLAUDE_CODE_USE_BEDROCK")) return identity("metered_api", CLAUDE_BEDROCK_BILLER);
  if (providerFlag("CLAUDE_CODE_USE_VERTEX")) return identity("metered_api", CLAUDE_VERTEX_BILLER);
  if (providerFlag("CLAUDE_CODE_USE_FOUNDRY")) return identity("metered_api", CLAUDE_FOUNDRY_BILLER);
  if (isApiCredentialValue(read("ANTHROPIC_API_KEY"))) return identity("api");
  if (isApiCredentialValue(read("ANTHROPIC_AUTH_TOKEN"))) {
    return identity("metered_api", claudeGatewayBiller(read("ANTHROPIC_BASE_URL")));
  }
  return input.engine === "cli" && !input.targetIsRemote ? identity("subscription") : identity("unknown");
}

/**
 * Drop subscription credentials from an env map before any lane (local CLI,
 * ACP, or remote) uses it: every entry whose key names a subscription token, and
 * every entry whose string value is one (`sk-ant-oat…`), whatever its key.
 */
export function withoutClaudeSubscriptionTokens<T>(env: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isClaudeSubscriptionTokenEnvKey(key)) continue;
    if (isClaudeSubscriptionTokenValue(value)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * True when a claude_local run is on the Claude subscription lane: it runs on
 * this server (local target) with no API credential, so the `claude` CLI uses
 * the sign-in of the user Paperclip runs as. An explicit `engine=acp` run is not
 * on the lane (the ACP credential gate refuses it without an API key). This is
 * the lane the owner-only and trigger-source gates guard.
 */
export function isClaudeSubscriptionLaneRun(input: {
  config: Record<string, unknown>;
  /** The run's execution target, or `targetIsRemote` when only that is known. */
  target?: AdapterExecutionTarget | null;
  targetIsRemote?: boolean;
  hostEnv?: NodeJS.ProcessEnv;
}): boolean {
  if (input.targetIsRemote === true || input.target?.kind === "remote") return false;
  const rawEngine = typeof input.config.engine === "string" ? input.config.engine.trim().toLowerCase() : "";
  const engine: ClaudeCredentialPolicyEngine = rawEngine === "acp" ? "acp" : "cli";
  if (engine === "acp") return false;
  const identity = resolveClaudeBillingIdentity({
    engine,
    targetIsRemote: false,
    env: parseObject(input.config.env),
    hostEnv: input.config.managedAiConnection ? {} : input.hostEnv,
  });
  return identity.billingType === "subscription";
}

/**
 * True when a stored (not yet resolved) claude_local adapter config names an
 * API credential: a set `ANTHROPIC_API_KEY` or gateway `ANTHROPIC_AUTH_TOKEN`
 * binding (a literal that is not a subscription token, or a secret reference),
 * or a Bedrock, Vertex or Foundry flag. Used where secrets are not resolved,
 * for example to pick safe defaults when a chat endpoint is created. It does
 * not read the host env.
 */
export function claudeConfigDeclaresApiCredential(config: Record<string, unknown>): boolean {
  if (config.managedAiConnection) return true;
  const env = parseObject(config.env);
  const bindingIsCredential = (binding: unknown): boolean => {
    if (typeof binding === "string") return isApiCredentialValue(binding.trim());
    const record = parseObject(binding);
    if (record.type === "plain") {
      return typeof record.value === "string" && isApiCredentialValue(record.value.trim());
    }
    return record.type === "secret_ref" || record.type === "user_secret_ref";
  };
  const flagSet = (binding: unknown): boolean => {
    const record = parseObject(binding);
    const value = typeof binding === "string" ? binding : record.type === "plain" ? record.value : null;
    return typeof value === "string" && providerFlagSet(value.trim());
  };
  return (
    bindingIsCredential(env.ANTHROPIC_API_KEY) ||
    bindingIsCredential(env.ANTHROPIC_AUTH_TOKEN) ||
    flagSet(env.CLAUDE_CODE_USE_BEDROCK) ||
    flagSet(env.CLAUDE_CODE_USE_VERTEX) ||
    flagSet(env.CLAUDE_CODE_USE_FOUNDRY)
  );
}
