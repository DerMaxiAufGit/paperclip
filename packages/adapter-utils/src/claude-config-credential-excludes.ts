import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DirectorySnapshot } from "./workspace-restore-merge.js";

// Fork policy: Paperclip never forwards a Claude sign-in. A remote target (SSH
// or sandbox) runs only with an Anthropic API key, so the Claude sign-in files
// a staged workspace happens to contain never leave this server, whichever
// adapter stages it, and the sync-back never reads them as deleted or copies a
// remote one home. See doc/plans/2026-09-24-claude-cli-only-auth.md.

/**
 * File names under which Claude Code stores a Claude sign-in in its config dir
 * (`CLAUDE_CONFIG_DIR`, default `~/.claude`). A remote target runs only with an
 * Anthropic API key, so these files are never staged into a sandbox and never
 * synced back from one.
 */
export const CLAUDE_CONFIG_CREDENTIAL_FILE_NAMES = [".credentials.json", "credentials.json"] as const;

/**
 * Claude Code's global state file: `~/.claude.json`, or `.claude.json` inside
 * `CLAUDE_CONFIG_DIR`. It names the signed-in account and can hold a Console
 * API key, so it is kept out of remote staging too.
 */
export const CLAUDE_GLOBAL_CONFIG_FILE_NAME = ".claude.json";

// Sign-in excludes for a Claude config dir (or home) at any depth of a staged
// workspace. tar matches a plain entry unanchored, at any depth; the in-process
// matcher (`shouldExcludePath`) needs the `*/` prefix form for that.
export const CLAUDE_SIGN_IN_ANY_DEPTH_WORKSPACE_EXCLUDES: readonly string[] = [
  ...CLAUDE_CONFIG_CREDENTIAL_FILE_NAMES.map((name) => `.claude/${name}`),
  CLAUDE_GLOBAL_CONFIG_FILE_NAME,
].flatMap((entry) => [entry, `*/${entry}`]);

/**
 * `candidate` relative to `workspaceLocalDir` in posix form: `""` for the
 * workspace itself, `null` when `candidate` is not an absolute path inside it.
 */
export function workspaceRelativePosixPath(workspaceLocalDir: string, candidate: string): string | null {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  const relative = path.relative(path.resolve(workspaceLocalDir), path.resolve(candidate));
  if (relative.length === 0) return "";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join(path.posix.sep);
}

/**
 * Workspace-relative paths of the Claude sign-in files of every Claude config
 * dir that lives inside the staged workspace: the agent's explicit
 * `CLAUDE_CONFIG_DIR`, the server's own `CLAUDE_CONFIG_DIR`, and the default
 * `~/.claude` (when the workspace contains the home directory). The remote ACP
 * lane excludes them from both the workspace upload and the teardown sync-back.
 */
export function claudeConfigCredentialWorkspaceExcludes(input: {
  workspaceLocalDir: string;
  configDirs: ReadonlyArray<string | null | undefined>;
}): string[] {
  const excludes = new Set<string>();
  for (const configDir of input.configDirs) {
    const trimmed = typeof configDir === "string" ? configDir.trim() : "";
    const relative = workspaceRelativePosixPath(input.workspaceLocalDir, trimmed);
    if (relative === null) continue;
    for (const name of CLAUDE_CONFIG_CREDENTIAL_FILE_NAMES) {
      excludes.add(relative ? `${relative}/${name}` : name);
    }
  }
  return [...excludes];
}

// The resolved path plus its real path, so a workspace or config dir reached
// through a symbolic link still matches.
function pathSpellings(value: string): string[] {
  const resolved = path.resolve(value);
  try {
    const real = realpathSync.native(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

/**
 * The Claude sign-in excludes the generic remote staging (SSH, sandbox and
 * command runner) merges into every adapter's workspace excludes, for both the
 * upload and the sync-back: the sign-in files of the server's
 * `CLAUDE_CONFIG_DIR` (plus its `.claude.json`) and of `~/.claude` when they
 * live inside the workspace, `~/.claude.json` when the workspace holds the
 * home directory, and the sign-in files of a `.claude` dir and any
 * `.claude.json` at any depth.
 */
export function claudeSignInWorkspaceExcludes(input: {
  workspaceLocalDir: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string[] {
  const env = input.env ?? process.env;
  const homeDir = (input.homeDir ?? os.homedir()).trim();
  const serverConfigDir = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  const configDirs = [serverConfigDir, homeDir ? path.join(homeDir, ".claude") : ""]
    .filter((dir) => path.isAbsolute(dir))
    .flatMap(pathSpellings);
  // `.claude.json` sits inside CLAUDE_CONFIG_DIR, or in the home directory.
  const globalConfigDirs = [serverConfigDir, homeDir]
    .filter((dir) => path.isAbsolute(dir))
    .flatMap(pathSpellings);
  const excludes = new Set<string>(CLAUDE_SIGN_IN_ANY_DEPTH_WORKSPACE_EXCLUDES);
  for (const workspaceLocalDir of pathSpellings(input.workspaceLocalDir)) {
    for (const entry of claudeConfigCredentialWorkspaceExcludes({ workspaceLocalDir, configDirs })) {
      excludes.add(entry);
    }
    for (const dir of globalConfigDirs) {
      const relative = workspaceRelativePosixPath(workspaceLocalDir, dir);
      if (relative === null) continue;
      excludes.add(relative ? `${relative}/${CLAUDE_GLOBAL_CONFIG_FILE_NAME}` : CLAUDE_GLOBAL_CONFIG_FILE_NAME);
    }
  }
  return [...excludes];
}

/**
 * Whether a workspace-relative path (segments, any case) names a Claude
 * sign-in file by its location: a credential file anywhere inside a `.claude`
 * dir, or `.claude.json` at any depth. Same names as the staging excludes.
 */
export function isClaudeSignInPathSegments(segments: readonly string[]): boolean {
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const fileName = lowerSegments.at(-1) ?? "";
  if (fileName === CLAUDE_GLOBAL_CONFIG_FILE_NAME) return true;
  return (
    (CLAUDE_CONFIG_CREDENTIAL_FILE_NAMES as readonly string[]).includes(fileName) &&
    lowerSegments.slice(0, -1).includes(".claude")
  );
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type ClaudeSignInLocationInput = { env?: NodeJS.ProcessEnv; homeDir?: string };

// The Claude config dirs the server's own `claude` reads a sign-in from (its
// `CLAUDE_CONFIG_DIR` and `~/.claude`), plus where their sign-in files really
// live, each in its resolved and real spelling.
function claudeSignInLocations(input: ClaudeSignInLocationInput) {
  const env = input.env ?? process.env;
  const homeDir = (input.homeDir ?? os.homedir()).trim();
  const serverConfigDir = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  const configDirs = [serverConfigDir, homeDir ? path.join(homeDir, ".claude") : ""].filter((dir) =>
    path.isAbsolute(dir),
  );
  const signInFiles = [
    ...configDirs.flatMap((dir) =>
      [...CLAUDE_CONFIG_CREDENTIAL_FILE_NAMES, CLAUDE_GLOBAL_CONFIG_FILE_NAME].map((name) => path.join(dir, name)),
    ),
    ...(path.isAbsolute(homeDir) ? [path.join(homeDir, CLAUDE_GLOBAL_CONFIG_FILE_NAME)] : []),
  ];
  return {
    configDirs: [...new Set(configDirs.flatMap(pathSpellings))],
    signInFiles: new Set(signInFiles.flatMap(pathSpellings)),
  };
}

export type ClaudeSignInPathMatcher = (candidatePath: string) => boolean;

/**
 * A matcher for absolute host paths (pass the real path of the file that would
 * be read or listed) that names a Claude sign-in file whatever folder a caller
 * treats as its root: a credential file directly inside any `.claude` dir or
 * anywhere inside the server's `CLAUDE_CONFIG_DIR` or `~/.claude`, any
 * `.claude.json`, and the real target of each of those sign-in files when it is
 * a link to a file of another name. Resolves the config dirs once, so a scan
 * builds one matcher and checks every entry with it. A relative path matches
 * nothing.
 */
export function createClaudeSignInPathMatcher(input: ClaudeSignInLocationInput = {}): ClaudeSignInPathMatcher {
  const { configDirs, signInFiles } = claudeSignInLocations(input);
  return (candidatePath) => {
    if (!candidatePath || !path.isAbsolute(candidatePath)) return false;
    const resolved = path.resolve(candidatePath);
    if (signInFiles.has(resolved)) return true;
    const fileName = path.basename(resolved).toLowerCase();
    if (fileName === CLAUDE_GLOBAL_CONFIG_FILE_NAME) return true;
    if (!(CLAUDE_CONFIG_CREDENTIAL_FILE_NAMES as readonly string[]).includes(fileName)) return false;
    if (path.basename(path.dirname(resolved)).toLowerCase() === ".claude") return true;
    return configDirs.some((dir) => isSameOrInside(dir, resolved));
  };
}

/** One-off form of {@link createClaudeSignInPathMatcher}. */
export function isClaudeSignInPath(candidatePath: string, input: ClaudeSignInLocationInput = {}): boolean {
  return createClaudeSignInPathMatcher(input)(candidatePath);
}

/**
 * Whether handing out the files of the folder `dirPath` could expose the
 * server's Claude sign-in: the folder is the server's `CLAUDE_CONFIG_DIR` or
 * `~/.claude` or lies inside one of them, is itself named `.claude`, or holds
 * one of them (the home directory and everything above it hold `~/.claude`).
 * Checks the resolved and the real spelling of every path.
 */
export function overlapsClaudeConfigDir(dirPath: string, input: ClaudeSignInLocationInput = {}): boolean {
  if (!dirPath) return false;
  const { configDirs } = claudeSignInLocations(input);
  return pathSpellings(dirPath).some(
    (folder) =>
      path.basename(folder).toLowerCase() === ".claude" ||
      configDirs.some((dir) => isSameOrInside(dir, folder) || isSameOrInside(folder, dir)),
  );
}

function mergeExcludeLists(first: readonly string[] | undefined, second: readonly string[]): string[] {
  return [...new Set([...(first ?? []), ...second])];
}

/** `workspaceExclude` with the Claude sign-in excludes merged in (deduplicated, caller entries first). */
export function withClaudeSignInWorkspaceExcludes(
  workspaceLocalDir: string,
  workspaceExclude: readonly string[] | undefined,
): string[] {
  return mergeExcludeLists(workspaceExclude, claudeSignInWorkspaceExcludes({ workspaceLocalDir }));
}

/**
 * The generic staging input with the Claude sign-in excludes merged into its
 * workspace excludes and into a supplied (persisted) restore baseline, so a
 * baseline captured before these excludes existed never reads an excluded
 * sign-in file as deleted remotely.
 */
export function withClaudeSignInStagingExcludes<
  T extends { workspaceLocalDir: string; workspaceExclude?: string[]; workspaceBaseline?: DirectorySnapshot },
>(input: T): T & { workspaceExclude: string[] } {
  const signInExcludes = claudeSignInWorkspaceExcludes({ workspaceLocalDir: input.workspaceLocalDir });
  return {
    ...input,
    workspaceExclude: mergeExcludeLists(input.workspaceExclude, signInExcludes),
    ...(input.workspaceBaseline
      ? {
          workspaceBaseline: {
            ...input.workspaceBaseline,
            exclude: mergeExcludeLists(input.workspaceBaseline.exclude, signInExcludes),
          },
        }
      : {}),
  };
}
