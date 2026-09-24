/**
 * Environment keys that carry a Claude subscription credential. Paperclip never
 * passes them to a process it spawns, locally, over SSH, in a sandbox, or into
 * an ACP child, whether the value comes from the host process env or from the
 * caller env. The `claude` binary on the Paperclip host uses its own sign-in;
 * every other lane authenticates with an API key.
 */
export const NEVER_FORWARDED_CHILD_ENV_KEYS: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN"];

/** True when `key` (any letter case) must never reach a spawned process. */
export function isNeverForwardedChildEnvKey(key: string): boolean {
  return NEVER_FORWARDED_CHILD_ENV_KEYS.includes(key.trim().toUpperCase());
}

const REMOTE_EXECUTION_ENV_IDENTITY_KEYS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "NVM_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const upper = key.toUpperCase();
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (candidateKey.toUpperCase() === upper && typeof candidateValue === "string") {
      return candidateValue;
    }
  }
  return undefined;
}

export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isNeverForwardedChildEnvKey(key)) continue;
    const normalizedKey = key.toUpperCase();
    if (!REMOTE_EXECUTION_ENV_IDENTITY_KEYS.has(normalizedKey)) {
      sanitized[key] = value;
      continue;
    }
    const inheritedValue = readEnvValueCaseInsensitive(inheritedEnv, key);
    if (typeof inheritedValue === "string" && inheritedValue === value) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
