import { readHarnessCliFlagValues } from "@paperclipai/adapter-utils/claude-subscription-harness-guard";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { asStringArray, parseObject } from "@paperclipai/adapter-utils/server-utils";
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
 * adapter-utils). On the ACP engine, and while the engine is not chosen yet,
 * they count only when the adapter env sets them, because the adapter env
 * always reaches the child. A host-only value would let the gate pass while the
 * child still falls back to the service user's Claude sign-in.
 */
const CONFIG_ENV_ONLY_PROVIDER_FLAGS = ["CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] as const;

export const CLAUDE_INLINE_SETTINGS_INVALID_MESSAGE =
  "The --settings value in the agent's extra args is not valid JSON; fix or remove it.";

/**
 * The inline `--settings` JSON in a CLI run's `extraArgs`/`args`. The `claude`
 * binary applies its `env` over the process env, so an entry there can take a
 * credential away from the agent or server env: with
 * `{"env":{"ANTHROPIC_API_KEY":""}}` the binary drops the key and sends the
 * server's Claude sign-in instead (verified with claude 2.1.283). A value that
 * does not start with `{` is a settings file path, which is not read (see the
 * plan's grey area). The ACP child never gets these args.
 */
interface ClaudeInlineSettings {
  /** The `env` object of each inline `--settings` JSON, in order. */
  envs: Record<string, unknown>[];
  /** An inline `--settings` value is not valid JSON. */
  invalid: boolean;
}

const NO_INLINE_SETTINGS: ClaudeInlineSettings = { envs: [], invalid: false };

function claudeCliArgs(config: Record<string, unknown>): string[] {
  return [...asStringArray(config.extraArgs), ...asStringArray(config.args)];
}

function readClaudeInlineSettings(args: readonly string[]): ClaudeInlineSettings {
  const envs: Record<string, unknown>[] = [];
  let invalid = false;
  for (const value of readHarnessCliFlagValues(args, ["--settings"])) {
    if (!value.startsWith("{")) continue;
    try {
      envs.push(parseObject(parseObject(JSON.parse(value)).env));
    } catch {
      invalid = true;
    }
  }
  return { envs, invalid };
}

/**
 * True when the inline `--settings` env may take `key` away: an entry for it,
 * in any case, whose value does not count by itself (`""`, whitespace, `"0"`, a
 * subscription token, or a non-string the binary turns into a string). Settings
 * that are not valid JSON take every credential away. The settings can only
 * take a credential away, never add one: claude 2.1.283 ignores the whole
 * `--settings` JSON when any field fails its settings schema, and skips a
 * `--settings` token that is the value of another flag, so a key the settings
 * add may never reach the binary, which then uses the server's sign-in. An
 * `apiKeyHelper` in the settings does not count for the same reason.
 */
function inlineSettingsTakeAway(
  settings: ClaudeInlineSettings,
  key: string,
  counts: (value: string) => boolean,
): boolean {
  if (settings.invalid) return true;
  return settings.envs.some((env) =>
    Object.entries(env).some(
      ([rawKey, value]) =>
        rawKey.trim().toUpperCase() === key && !(typeof value === "string" && counts(value.trim())),
    ),
  );
}

/**
 * True when the run authenticates with a non-subscription credential, by the
 * same classifier as the billing label (`resolveClaudeBillingIdentity`). The
 * adapter config env wins over the host env, the same way the launch env is
 * merged. The host env only counts for a local target without a managed AI
 * connection, because a remote target and a managed connection never inherit
 * the host credentials. On the CLI engine the inline `--settings` env can take
 * a credential away. Without `engine`, the credential must count for both
 * engines.
 *
 * `ANTHROPIC_BEDROCK_BASE_URL` alone does not count: without
 * `CLAUDE_CODE_USE_BEDROCK` Claude Code ignores it and uses its own sign-in.
 */
export function claudeRunHasApiCredential(input: {
  config: Record<string, unknown>;
  targetIsRemote: boolean;
  hostEnv?: NodeJS.ProcessEnv;
  engine?: ClaudeCredentialPolicyEngine;
}): boolean {
  const engines: ClaudeCredentialPolicyEngine[] = input.engine ? [input.engine] : ["cli", "acp"];
  return engines.every((engine) => {
    const { billingType } = resolveClaudeConfigBillingIdentity({ ...input, engine });
    return billingType === "api" || billingType === "metered_api";
  });
}

/**
 * The engine a claude_local run uses when `engine` is not set. A run with an
 * Anthropic API credential on this server uses ACP, which needs no global
 * `claude` binary (the Agent SDK ships with Paperclip). Every other run uses
 * the CLI engine: a subscription only through the `claude` binary signed in on
 * this server, and a remote target through the CLI installed there. A
 * credential that the inline `--settings` env takes away keeps the run on the
 * CLI engine, where `isClaudeSubscriptionLaneRun` puts it on the lane too.
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
 * The only host the server's Claude sign-in may be sent to. With no API
 * credential the `claude` binary sends the sign-in's bearer token to whatever
 * endpoint its env names, so the subscription lane refuses an agent env that
 * points the binary elsewhere or lets another program read its requests.
 */
const CLAUDE_SUBSCRIPTION_API_HOST = "api.anthropic.com";

/**
 * Env keys that set the endpoint of the `claude` binary's API requests, allowed
 * only at `https://api.anthropic.com`. `ANTHROPIC_UNIX_SOCKET`, which sends the
 * requests to a local socket instead, is refused whatever its value.
 */
const CLAUDE_API_ENDPOINT_ENV_KEYS = new Set(["ANTHROPIC_BASE_URL", "CLAUDE_CODE_API_BASE_URL"]);
const CLAUDE_API_SOCKET_ENV_KEY = "ANTHROPIC_UNIX_SOCKET";

/**
 * Env keys the subscription lane refuses whatever their value, because they let
 * another program read the binary's requests: `NODE_EXTRA_CA_CERTS`,
 * `SSL_CERT_FILE` and `SSL_CERT_DIR` change which TLS certificates it trusts,
 * so a proxy could read them; `BUN_INSPECT*` opens a debugger on its Bun
 * runtime, and `BUN_OPTIONS`, `LD_PRELOAD`, `LD_AUDIT` and
 * `DYLD_INSERT_LIBRARIES` load code into it.
 */
const CLAUDE_SUBSCRIPTION_REFUSED_ENV_KEYS = new Set([
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
]);
const CLAUDE_SUBSCRIPTION_REFUSED_ENV_KEY_PREFIXES = ["BUN_INSPECT"];

/**
 * `NODE_OPTIONS` flags that open a debugger on, load code or env into, or log
 * the TLS keys of a `claude` CLI that runs on Node (an npm install). Other
 * flags, such as `--max-old-space-size`, stay allowed.
 */
const NODE_OPTIONS_REFUSED_FLAGS = [
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--env-file-if-exists",
  "--tls-keylog",
];

/** True when `value` names `https://api.anthropic.com` (any path). */
export function isClaudeSubscriptionApiEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === CLAUDE_SUBSCRIPTION_API_HOST;
  } catch {
    return false;
  }
}

function nodeOptionsLoadOrInspect(value: string): boolean {
  return value.split(/\s+/).some((token) => {
    const name = token.replace(/^["']/, "").split("=")[0]!;
    return name.startsWith("--inspect") || name.startsWith("--debug") || NODE_OPTIONS_REFUSED_FLAGS.includes(name);
  });
}

/**
 * The value of an env binding: a string, or a plain binding's value. `null`
 * means set with a value this check cannot see (an unresolved secret), which
 * fails closed; `undefined` means unset.
 */
function envBindingValue(binding: unknown): string | null | undefined {
  if (binding === undefined || binding === null) return undefined;
  if (typeof binding === "string") return binding;
  const record = parseObject(binding);
  if (record.type === "plain" && typeof record.value === "string") return record.value;
  return null;
}

type ClaudeSubscriptionEnvFinding = { key: string; kind: "endpoint" | "exposure" };

function findClaudeSubscriptionEnvFinding(env: Record<string, unknown>): ClaudeSubscriptionEnvFinding | null {
  for (const [rawKey, binding] of Object.entries(env)) {
    const value = envBindingValue(binding);
    if (value === undefined || value === "") continue;
    const key = rawKey.trim();
    const normalized = key.toUpperCase();
    if (CLAUDE_API_ENDPOINT_ENV_KEYS.has(normalized)) {
      if (value === null || !isClaudeSubscriptionApiEndpoint(value)) return { key, kind: "endpoint" };
      continue;
    }
    if (normalized === CLAUDE_API_SOCKET_ENV_KEY) return { key, kind: "endpoint" };
    const refused =
      CLAUDE_SUBSCRIPTION_REFUSED_ENV_KEYS.has(normalized) ||
      CLAUDE_SUBSCRIPTION_REFUSED_ENV_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
      (normalized === "NODE_TLS_REJECT_UNAUTHORIZED" && value !== "1") ||
      (normalized === "NODE_OPTIONS" && (value === null || nodeOptionsLoadOrInspect(value)));
    if (refused) return { key, kind: "exposure" };
  }
  return null;
}

function claudeSubscriptionEndpointMessage(finding: ClaudeSubscriptionEnvFinding, place: string): string {
  const prefix = "A Claude subscription is only sent to api.anthropic.com.";
  return finding.kind === "endpoint"
    ? `${prefix} Remove ${finding.key} from ${place} or add an Anthropic API key (ANTHROPIC_API_KEY) to use a custom endpoint.`
    : `${prefix} ${finding.key} lets another program read the claude CLI's requests; remove it from ${place} or add an Anthropic API key (ANTHROPIC_API_KEY) to use it.`;
}

/**
 * The refusal message when a subscription-lane run's config points the
 * `claude` binary away from api.anthropic.com or lets another program read its
 * requests, or null when it may start. It reads the adapter config env (agent,
 * project, environment and routine env, and issue overrides) and the env of an
 * inline `--settings` JSON in `extraArgs`/`args`, which the binary applies over
 * its process env; those settings must also pass
 * `claudeInlineSettingsViolation`. The server's own process env is the
 * operator's and is not checked. The caller decides that the run is on the
 * subscription lane.
 */
export function resolveClaudeSubscriptionEndpointViolation(config: Record<string, unknown>): string | null {
  const envFinding = findClaudeSubscriptionEnvFinding(parseObject(config.env));
  if (envFinding) return claudeSubscriptionEndpointMessage(envFinding, "the agent env");
  const settings = readClaudeInlineSettings(claudeCliArgs(config));
  const settingsViolation = claudeInlineSettingsViolation(settings);
  if (settingsViolation) return settingsViolation;
  for (const env of settings.envs) {
    const settingsFinding = findClaudeSubscriptionEnvFinding(env);
    if (settingsFinding) {
      return claudeSubscriptionEndpointMessage(settingsFinding, "the --settings env in the agent's extra args");
    }
  }
  return null;
}

/**
 * The refusal message for a CLI run, on any target, whose inline `--settings`
 * is not valid JSON (the credential classifier cannot read it, and the binary
 * refuses it too), or whose settings env would hand the `claude` binary a
 * Claude subscription token (a token key with a value, or a token value).
 */
function claudeInlineSettingsViolation(settings: ClaudeInlineSettings): string | null {
  if (settings.invalid) return CLAUDE_INLINE_SETTINGS_INVALID_MESSAGE;
  for (const env of settings.envs) {
    for (const [rawKey, value] of Object.entries(env)) {
      const blank = typeof value === "string" && value.trim() === "";
      if ((isClaudeSubscriptionTokenEnvKey(rawKey) && !blank) || isClaudeSubscriptionTokenValue(value)) {
        return `Paperclip never passes a Claude sign-in to the claude CLI. Remove ${rawKey.trim()} from the --settings env in the agent's extra args.`;
      }
    }
  }
  return null;
}

/**
 * True when a local CLI run has no API credential, so the `claude` binary uses
 * the sign-in of the user Paperclip runs as.
 */
function isLocalCliSubscriptionRun(config: Record<string, unknown>, hostEnv: NodeJS.ProcessEnv | undefined): boolean {
  const identity = resolveClaudeConfigBillingIdentity({ config, engine: "cli", targetIsRemote: false, hostEnv });
  return identity.billingType === "subscription";
}

/**
 * The single credential gate shared by the CLI engine, the ACP engine, and the
 * environment Test. Returns the user-facing error message when the run must
 * not start, or null when it may start.
 *
 * - CLI engine (any target): the inline `--settings` JSON in the extra args
 *   must be valid JSON and must not carry a subscription token
 *   (`claudeInlineSettingsViolation`).
 * - Local CLI engine: allowed; the `claude` binary uses its own sign-in. On the
 *   subscription lane (no API credential) the config must not point it away
 *   from api.anthropic.com (`resolveClaudeSubscriptionEndpointViolation`).
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
  if (input.engine === "cli") {
    const settingsViolation = claudeInlineSettingsViolation(readClaudeInlineSettings(claudeCliArgs(input.config)));
    if (settingsViolation) return settingsViolation;
    if (!targetIsRemote) {
      return isLocalCliSubscriptionRun(input.config, input.hostEnv)
        ? resolveClaudeSubscriptionEndpointViolation(input.config)
        : null;
    }
  }
  if (
    claudeRunHasApiCredential({
      config: input.config,
      targetIsRemote,
      hostEnv: input.hostEnv,
      engine: input.engine,
    })
  ) {
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
 * host Vertex or Foundry flag, so on ACP those count only from `env`. On the
 * CLI engine the inline `--settings` env in `extraArgs` can take a credential
 * away (see `inlineSettingsTakeAway`).
 */
export function resolveClaudeBillingIdentity(input: {
  engine: ClaudeCredentialPolicyEngine;
  targetIsRemote: boolean;
  env: Record<string, unknown>;
  hostEnv?: NodeJS.ProcessEnv;
  /** The claude CLI's extra args, read on the CLI engine only. */
  extraArgs?: readonly string[];
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
  const settings = input.engine === "cli" ? readClaudeInlineSettings(input.extraArgs ?? []) : NO_INLINE_SETTINGS;
  const credential = (key: string, value: string, counts: (value: string) => boolean): boolean =>
    counts(value) && !inlineSettingsTakeAway(settings, key, counts);
  const providerFlag = (key: string): boolean =>
    credential(key, configEnvOnly(key) ? readConfigured(key) ?? "" : read(key), providerFlagSet);
  const apiCredential = (key: string): boolean => credential(key, read(key), isApiCredentialValue);
  const identity = (billingType: ClaudeBillingType, biller = "anthropic"): ClaudeBillingIdentity => ({
    provider: "anthropic",
    biller,
    billingType,
  });

  if (providerFlag("CLAUDE_CODE_USE_BEDROCK")) return identity("metered_api", CLAUDE_BEDROCK_BILLER);
  if (providerFlag("CLAUDE_CODE_USE_VERTEX")) return identity("metered_api", CLAUDE_VERTEX_BILLER);
  if (providerFlag("CLAUDE_CODE_USE_FOUNDRY")) return identity("metered_api", CLAUDE_FOUNDRY_BILLER);
  if (apiCredential("ANTHROPIC_API_KEY")) return identity("api");
  if (apiCredential("ANTHROPIC_AUTH_TOKEN")) {
    return identity("metered_api", claudeGatewayBiller(read("ANTHROPIC_BASE_URL")));
  }
  return input.engine === "cli" && !input.targetIsRemote ? identity("subscription") : identity("unknown");
}

/**
 * `resolveClaudeBillingIdentity` for a claude_local adapter config: the one
 * classifier behind `claudeRunHasApiCredential`, the subscription lane and its
 * endpoint check. A managed AI connection never inherits the host credentials.
 */
function resolveClaudeConfigBillingIdentity(input: {
  config: Record<string, unknown>;
  engine: ClaudeCredentialPolicyEngine;
  targetIsRemote: boolean;
  hostEnv?: NodeJS.ProcessEnv;
}): ClaudeBillingIdentity {
  return resolveClaudeBillingIdentity({
    engine: input.engine,
    targetIsRemote: input.targetIsRemote,
    env: parseObject(input.config.env),
    hostEnv: input.config.managedAiConnection ? {} : input.hostEnv,
    extraArgs: claudeCliArgs(input.config),
  });
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
 * this server (local target) with no API credential in the env the `claude`
 * CLI uses (after the inline `--settings` env, which can take one away), so
 * the CLI uses the sign-in of the user Paperclip runs as. An explicit
 * `engine=acp` run is not on the lane (the ACP credential gate refuses it
 * without an API key). This is the lane the owner-only and trigger-source
 * gates guard.
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
  if (rawEngine === "acp") return false;
  return isLocalCliSubscriptionRun(input.config, input.hostEnv);
}

/**
 * True when a stored (not yet resolved) claude_local adapter config names an
 * API credential: a set `ANTHROPIC_API_KEY` or gateway `ANTHROPIC_AUTH_TOKEN`
 * binding (a literal that is not a subscription token, or a secret reference),
 * or a Bedrock, Vertex or Foundry flag, that the inline `--settings` env does
 * not take away. Used where secrets are not resolved, for example to pick safe
 * defaults when a chat endpoint is created. It does not read the host env.
 */
export function claudeConfigDeclaresApiCredential(config: Record<string, unknown>): boolean {
  const env = parseObject(config.env);
  const settings = readClaudeInlineSettings(claudeCliArgs(config));
  const kept = (key: string, counts: (value: string) => boolean): boolean =>
    !inlineSettingsTakeAway(settings, key, counts);
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
  // A managed Anthropic connection injects ANTHROPIC_API_KEY at run time.
  return (
    ((Boolean(config.managedAiConnection) || bindingIsCredential(env.ANTHROPIC_API_KEY)) &&
      kept("ANTHROPIC_API_KEY", isApiCredentialValue)) ||
    (bindingIsCredential(env.ANTHROPIC_AUTH_TOKEN) && kept("ANTHROPIC_AUTH_TOKEN", isApiCredentialValue)) ||
    (flagSet(env.CLAUDE_CODE_USE_BEDROCK) && kept("CLAUDE_CODE_USE_BEDROCK", providerFlagSet)) ||
    (flagSet(env.CLAUDE_CODE_USE_VERTEX) && kept("CLAUDE_CODE_USE_VERTEX", providerFlagSet)) ||
    (flagSet(env.CLAUDE_CODE_USE_FOUNDRY) && kept("CLAUDE_CODE_USE_FOUNDRY", providerFlagSet))
  );
}
