import { resolveClaudeDefaultEngine } from "@paperclipai/adapter-claude-local/server";

export type ClaudeLocalEngine = "cli" | "acp";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The engine a claude_local run uses, matching the adapter's own choice in
 * `resolveClaudeExecutionEngineForRun`: an explicit `engine` wins, local
 * confinement needs the CLI engine, and otherwise the credential decides
 * (see `resolveClaudeDefaultEngine`). `config.env` must hold resolved strings.
 */
export function resolveClaudeLocalEngine(
  config: Record<string, unknown>,
  targetIsRemote: boolean,
): ClaudeLocalEngine {
  const explicit = String(config.engine ?? "").trim().toLowerCase();
  if (explicit === "acp" || explicit === "cli") return explicit;
  if (config.filesystemScope != null || config.networkScope != null) return "cli";
  return resolveClaudeDefaultEngine({ config, targetIsRemote });
}

/**
 * Best-effort engine for a persisted claude_local agent whose env still holds
 * bindings (plain values or secret references), for server heuristics that run
 * before the secrets are resolved. A secret reference counts as a set value. A
 * managed Anthropic connection (API key only) counts as an API credential. The target
 * is assumed to be this server unless the caller knows otherwise.
 */
export function resolvePersistedClaudeLocalEngine(input: {
  adapterConfig: unknown;
  runtimeConfig?: unknown;
  targetIsRemote?: boolean;
}): ClaudeLocalEngine {
  const config = asRecord(input.adapterConfig);
  const env: Record<string, string> = {};
  for (const [key, binding] of Object.entries(asRecord(config.env))) {
    if (typeof binding === "string") env[key] = binding;
    else {
      const record = asRecord(binding);
      if (record.type === "plain") env[key] = typeof record.value === "string" ? record.value : "";
      else if (record.type === "secret_ref" || record.type === "user_secret_ref") env[key] = "secret";
    }
  }
  const aiConnection = asRecord(asRecord(input.runtimeConfig).aiConnection);
  // Anthropic connections are API-key only, so any managed Anthropic binding
  // injects ANTHROPIC_API_KEY at run time.
  if (aiConnection.provider === "anthropic") env.ANTHROPIC_API_KEY = "managed";
  return resolveClaudeLocalEngine(
    {
      ...config,
      env,
      // A managed connection never inherits host credentials.
      ...(Object.keys(aiConnection).length > 0 ? { managedAiConnection: aiConnection } : {}),
    },
    input.targetIsRemote === true,
  );
}
