import { lstat, readdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { CLAUDE_SETTINGS_CREDENTIAL_KEYS } from "@paperclipai/adapter-claude-local/server";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger as serverLogger } from "../middleware/logger.js";

/**
 * One-time startup housekeeping for the removed Claude subscription-login
 * capture. Earlier builds ran `CLAUDE_CONFIG_DIR=<dir> claude auth login` with a
 * per-attempt `<dir>` under `<instanceRoot>/ai-local-logins/`, so leftover homes
 * there can still hold Claude OAuth tokens. The same parent directory is still
 * used by the OpenAI/Codex (`CODEX_HOME`) and xAI/Grok (`GROK_HOME`) login
 * attempts, which may be live across a restart, so only children that look like
 * a Claude config home are removed. Symlinks are never followed.
 */

export const LOCAL_AI_LOGIN_HOMES_DIRNAME = "ai-local-logins";

const CLAUDE_CONFIG_MARKER_FILE = ".claude.json";
const CLAUDE_CREDENTIAL_FILES = [".credentials.json", "credentials.json"] as const;
// Claude credential files are a few KiB; refuse to parse anything unexpectedly large.
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;

export interface ClaudeLoginHomeCleanupLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ClaudeLoginHomeCleanupOptions {
  /** Defaults to `resolvePaperclipInstanceRoot()`. */
  instanceRoot?: string;
  /** Defaults to the server logger. */
  logger?: ClaudeLoginHomeCleanupLogger;
}

export interface ClaudeLoginHomeCleanupResult {
  /** Number of Claude login home directories removed. */
  removed: number;
  /** Number of failures encountered (reported in a single warn line). */
  failed: number;
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function hasClaudeOauthCredential(filePath: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) return false;
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, "claudeAiOauth")
    );
  } catch {
    // Unreadable or invalid JSON is not evidence of a Claude login home.
    return false;
  }
}

async function isClaudeLoginHome(directory: string): Promise<boolean> {
  if (await isRegularFile(path.join(directory, CLAUDE_CONFIG_MARKER_FILE))) return true;
  for (const name of CLAUDE_CREDENTIAL_FILES) {
    if (await hasClaudeOauthCredential(path.join(directory, name))) return true;
  }
  return false;
}

function safeLog(log: () => void) {
  try {
    log();
  } catch {
    // Logging must never break best-effort startup housekeeping.
  }
}

/**
 * Removes leftover Claude login homes from `<instanceRoot>/ai-local-logins`.
 * Best effort: never throws. Logs one info line when at least one home was
 * removed and at most one warn line when anything failed.
 */
export async function removeLeftoverClaudeLoginHomes(
  options: ClaudeLoginHomeCleanupOptions = {},
): Promise<ClaudeLoginHomeCleanupResult> {
  const log = options.logger ?? serverLogger;
  let removed = 0;
  let failed = 0;
  let firstError: unknown;
  let loginsDir: string | undefined;
  const recordFailure = (err: unknown) => {
    failed += 1;
    if (firstError === undefined) firstError = err;
  };

  try {
    const instanceRoot = options.instanceRoot ?? resolvePaperclipInstanceRoot();
    const resolvedLoginsDir = path.resolve(instanceRoot, LOCAL_AI_LOGIN_HOMES_DIRNAME);
    loginsDir = resolvedLoginsDir;

    let parentStat;
    try {
      parentStat = await lstat(resolvedLoginsDir);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return { removed: 0, failed: 0 };
      throw err;
    }
    // Never operate through a symlinked (or non-directory) parent.
    if (!parentStat.isDirectory()) return { removed: 0, failed: 0 };

    const entries = await readdir(resolvedLoginsDir, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(resolvedLoginsDir, entry.name);
      // Only direct children of the login-homes directory are ever candidates.
      if (path.dirname(child) !== resolvedLoginsDir) continue;
      // Dirent types are lstat-based: symlinks and files are skipped here.
      if (!entry.isDirectory()) continue;
      try {
        const childStat = await lstat(child);
        if (!childStat.isDirectory()) continue;
        if (!(await isClaudeLoginHome(child))) continue;
        await rm(child, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        recordFailure(err);
      }
    }

    if (removed > 0) {
      try {
        await rmdir(resolvedLoginsDir);
      } catch (err) {
        const code = errnoCode(err);
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") recordFailure(err);
      }
    }
  } catch (err) {
    recordFailure(err);
  }

  if (removed > 0) {
    safeLog(() =>
      log.info(
        { directory: loginsDir, removed },
        `Removed ${removed} leftover Claude login home(s) from ${loginsDir}`,
      ),
    );
  }
  if (failed > 0) {
    safeLog(() =>
      log.warn(
        { err: firstError, directory: loginsDir, failed },
        "Failed to clean up leftover Claude login homes",
      ),
    );
  }
  return { removed, failed };
}

export const CLAUDE_CONFIG_SEED_DIRNAME = "claude-config-seed";
const COMPANIES_DIRNAME = "companies";

async function listDirectChildDirectories(parent: string): Promise<string[]> {
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    throw err;
  }
  // Never operate through a symlinked (or non-directory) parent.
  if (!parentStat.isDirectory()) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .filter((child) => path.dirname(child) === parent);
}

async function seedCarriesCredentialSettings(snapshotDir: string): Promise<boolean> {
  const settingsPath = path.join(snapshotDir, "settings.json");
  try {
    const stat = await lstat(settingsPath);
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) return false;
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    return CLAUDE_SETTINGS_CREDENTIAL_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(parsed, key),
    );
  } catch {
    return false;
  }
}

/**
 * One-time startup housekeeping for remote Claude config seeds written by
 * earlier builds. Those builds copied the host `settings.json` with its `env`
 * block and credential helpers into `<instanceRoot>/[companies/<id>/]claude-config-seed/<hash>`.
 * The current seed drops those keys, so a snapshot that still has them is stale
 * and may hold a credential. Only such snapshots are removed; the next remote
 * run writes a clean one. Symlinks are never followed. Best effort: never throws.
 */
export async function removeStaleClaudeConfigSeeds(
  options: ClaudeLoginHomeCleanupOptions = {},
): Promise<ClaudeLoginHomeCleanupResult> {
  const log = options.logger ?? serverLogger;
  let removed = 0;
  let failed = 0;
  let firstError: unknown;
  try {
    const instanceRoot = path.resolve(options.instanceRoot ?? resolvePaperclipInstanceRoot());
    const seedRoots = [path.join(instanceRoot, CLAUDE_CONFIG_SEED_DIRNAME)];
    for (const companyDir of await listDirectChildDirectories(path.join(instanceRoot, COMPANIES_DIRNAME))) {
      seedRoots.push(path.join(companyDir, CLAUDE_CONFIG_SEED_DIRNAME));
    }
    for (const seedRoot of seedRoots) {
      let snapshots: string[];
      try {
        snapshots = await listDirectChildDirectories(seedRoot);
      } catch (err) {
        failed += 1;
        if (firstError === undefined) firstError = err;
        continue;
      }
      for (const snapshot of snapshots) {
        try {
          if (!(await seedCarriesCredentialSettings(snapshot))) continue;
          await rm(snapshot, { recursive: true, force: true });
          removed += 1;
        } catch (err) {
          failed += 1;
          if (firstError === undefined) firstError = err;
        }
      }
    }
  } catch (err) {
    failed += 1;
    if (firstError === undefined) firstError = err;
  }
  if (removed > 0) {
    safeLog(() => log.info({ removed }, `Removed ${removed} stale Claude config seed snapshot(s)`));
  }
  if (failed > 0) {
    safeLog(() => log.warn({ err: firstError, failed }, "Failed to clean up stale Claude config seed snapshots"));
  }
  return { removed, failed };
}
