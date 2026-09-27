import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProviderQuotaResult } from "@paperclipai/adapter-utils";
import { withoutClaudeSubscriptionTokens } from "./credential-policy.js";

// Paperclip shows no Claude subscription quota. Reading it would mean driving
// an interactive `claude` session or reading the Claude sign-in, and Paperclip
// does neither. The only thing Paperclip asks the `claude` binary is its own
// sign-in status (`claude auth status`), for the sign-in panel. It never reads
// the Claude sign-in files or the macOS Keychain, and never calls an Anthropic
// endpoint with a Claude subscription token.

const execFileAsync = promisify(execFile);

/**
 * Path of the Claude config dir. The server uses it to find Claude session
 * transcripts. Nothing here reads anything under it.
 */
export function claudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

export interface ClaudeAuthStatusProbe {
  status: ClaudeAuthStatus | null;
  /** True when the `claude` binary is not on PATH. */
  binaryMissing: boolean;
}

function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return {
      loggedIn: record.loggedIn === true,
      authMethod: typeof record.authMethod === "string" ? record.authMethod : null,
      subscriptionType: typeof record.subscriptionType === "string" ? record.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

async function probeClaudeAuthStatus(env: NodeJS.ProcessEnv): Promise<ClaudeAuthStatusProbe> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], {
      env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return { status: parseClaudeAuthStatus(stdout), binaryMissing: false };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (code === "ENOENT") return { status: null, binaryMissing: true };
    // `claude auth status` exits non-zero when signed out but still prints its
    // JSON status on stdout.
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
    return { status: parseClaudeAuthStatus(stdout), binaryMissing: false };
  }
}

/**
 * Ask the `claude` binary for its own sign-in status (`claude auth status`),
 * and say whether the binary is missing from PATH. Paperclip only runs the
 * binary; it never reads the sign-in itself.
 */
export async function probeClaudeCliAuth(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeAuthStatusProbe> {
  return probeClaudeAuthStatus(withoutClaudeSubscriptionTokens(options.env ?? process.env));
}

/** Ask the `claude` binary for its own sign-in status (`claude auth status`). */
export async function readClaudeAuthStatus(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeAuthStatus | null> {
  return (await probeClaudeCliAuth(options)).status;
}

/**
 * Claude has no quota windows on the Costs page. The result is `ok` with no
 * windows, so the page shows neither a Claude usage section nor an error.
 * Nothing is run or read.
 */
export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  return { provider: "anthropic", ok: true, windows: [] };
}
