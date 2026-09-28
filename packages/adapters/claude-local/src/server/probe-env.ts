import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { pickLocalProbeCallerEnv } from "./credential-policy.js";

/**
 * The proxy variable names the probe may forward. The builder reads these only
 * from the trusted server-resolved input. It never reads a proxy key from the
 * untrusted caller input, and it never logs, returns, or reflects a proxy
 * value.
 */
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] as const;

/**
 * Windows interpreter-selection variables. The builder never takes these from
 * any input. The child-process launcher derives the interpreter from trusted
 * server state instead, so a caller value must never reach the child env.
 */
const WINDOWS_INTERPRETER_ENV_KEYS = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC"]);

export interface LocalProbeEnvironment {
  /**
   * The trusted absolute path to the resolved `claude` executable, or `null`
   * when the trusted server PATH holds no `claude`. The caller must not run a
   * local probe when this is `null`; it reports a probe-unavailable check
   * instead.
   */
  command: string | null;
  /**
   * The child environment for the local probe. It holds only allowlisted
   * caller values plus proxy values from the trusted input. It never holds a
   * caller-supplied proxy key, a loader variable, a PATH override, or a Windows
   * interpreter variable.
   */
  env: Record<string, string>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve a command name to a trusted absolute executable. The function reads
 * the PATH and PATHEXT from the trusted server env only. It never reads a
 * caller value, so a hostile caller PATH cannot select the executable. The
 * function ignores a command that contains a path separator; a local probe
 * must not run a caller-supplied executable path.
 */
async function resolveTrustedExecutable(
  commandName: string,
  trustedEnv: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (commandName.includes("/") || commandName.includes("\\")) {
    return null;
  }
  const pathValue = trustedEnv.PATH ?? trustedEnv.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (trustedEnv.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  const mode = process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? exts.map((ext) => path.join(dir, `${commandName}${ext}`))
        : [path.join(dir, commandName)];
    for (const candidate of candidates) {
      try {
        await access(candidate, mode);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}

/**
 * Build the child environment and executable for a local Claude adapter-test
 * hello probe. Both the ACP Test lane and the Claude CLI Test lane use this
 * builder, so the two lanes probe the host the same safe way.
 *
 * The builder denies by default. It never merges the arbitrary caller env into
 * a host base. It reads two separate inputs:
 *   - `callerEnv`: the untrusted adapter-config env from the Test request. The
 *     builder takes only allowlisted Claude, auth, and Bedrock keys from it. It
 *     discards every proxy key and every Windows interpreter key, in any case.
 *   - `trustedEnv`: the trusted server-resolved env (the server launch config
 *     and the authorized environment's server-resolved env). The builder takes
 *     proxy keys only from this input.
 *
 * The builder resolves `claude` to a trusted absolute executable with the
 * trusted server PATH, before it reads any caller value. It ignores a caller
 * `command` path.
 *
 * The builder never logs, returns, or reflects a proxy value in a check.
 */
export async function buildLocalAdapterTestProbeEnv(input: {
  callerEnv: Record<string, string>;
  trustedEnv?: NodeJS.ProcessEnv;
  commandName?: string;
}): Promise<LocalProbeEnvironment> {
  const trustedEnv = input.trustedEnv ?? process.env;
  const commandName = input.commandName ?? "claude";
  const command = await resolveTrustedExecutable(commandName, trustedEnv);

  // Allowlisted caller values (`pickLocalProbeCallerEnv`), read by name so no
  // unexpected caller key can enter the child env. Proxy and Windows
  // interpreter keys are never in the allowlist, so a caller cannot pass them
  // here. The probe's lane is classified on the same function
  // (`isClaudeSubscriptionLaneRun` with `localTestProbe`), and it drops a caller
  // ANTHROPIC_BASE_URL when the child would run on the server's sign-in.
  const env: Record<string, string> = pickLocalProbeCallerEnv(input.callerEnv, trustedEnv);

  // Proxy values come from the trusted input only. A caller-supplied proxy key
  // in `callerEnv` is never read, so it cannot reach the child.
  for (const key of PROXY_ENV_KEYS) {
    const upperValue = trustedEnv[key];
    if (isNonEmptyString(upperValue)) {
      env[key] = upperValue;
    }
    const lowerKey = key.toLowerCase();
    const lowerValue = trustedEnv[lowerKey];
    if (isNonEmptyString(lowerValue)) {
      env[lowerKey] = lowerValue;
    }
  }

  // Defense in depth: strip any Windows interpreter key that a future allowlist
  // edit might introduce, in any case.
  for (const key of Object.keys(env)) {
    if (WINDOWS_INTERPRETER_ENV_KEYS.has(key.toUpperCase())) {
      delete env[key];
    }
  }

  return { command, env };
}
