import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_SIGN_IN_ANY_DEPTH_WORKSPACE_EXCLUDES,
  claudeConfigCredentialWorkspaceExcludes,
  claudeSignInWorkspaceExcludes,
  createClaudeSignInPathMatcher,
  isClaudeSignInPath,
  isClaudeSignInPathSegments,
  overlapsClaudeConfigDir,
  withClaudeSignInStagingExcludes,
  withClaudeSignInWorkspaceExcludes,
} from "./claude-config-credential-excludes.js";
import { shouldExcludePath } from "./exclude-patterns.js";

describe("claudeConfigCredentialWorkspaceExcludes", () => {
  it("excludes the sign-in files of each Claude config dir inside the workspace", () => {
    const workspace = path.join(os.tmpdir(), "ws");
    expect(
      claudeConfigCredentialWorkspaceExcludes({
        workspaceLocalDir: workspace,
        configDirs: [
          path.join(workspace, ".claude-config"),
          path.join(workspace, "nested", "claude"),
          path.join(os.tmpdir(), "outside"),
          "relative/path",
          "",
          null,
          undefined,
        ],
      }),
    ).toEqual([
      ".claude-config/.credentials.json",
      ".claude-config/credentials.json",
      "nested/claude/.credentials.json",
      "nested/claude/credentials.json",
    ]);
  });
});

describe("claudeSignInWorkspaceExcludes", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("always excludes the sign-in files of a .claude dir and any .claude.json, at any depth", () => {
    const workspace = path.join(os.tmpdir(), "paperclip-sign-in-missing-ws");
    const excludes = claudeSignInWorkspaceExcludes({
      workspaceLocalDir: workspace,
      env: {},
      homeDir: path.join(os.tmpdir(), "paperclip-sign-in-elsewhere"),
    });
    expect(excludes).toEqual([...CLAUDE_SIGN_IN_ANY_DEPTH_WORKSPACE_EXCLUDES]);
    for (const relative of [
      ".claude/.credentials.json",
      ".claude/credentials.json",
      ".claude.json",
      "home/agent/.claude/.credentials.json",
      "home/agent/.claude.json",
      "a/b/c/.claude/credentials.json",
    ]) {
      expect(shouldExcludePath(relative, excludes)).toBe(true);
    }
    for (const relative of [
      ".claude/settings.json",
      ".claude/skills/demo/SKILL.md",
      "credentials.json",
      "config/credentials.json",
      "src/.credentials.json",
      ".claude.json.d/readme.md",
    ]) {
      expect(shouldExcludePath(relative, excludes)).toBe(false);
    }
  });

  it("resolves the server's CLAUDE_CONFIG_DIR and home when they live inside the workspace", () => {
    const workspace = path.join(os.tmpdir(), "paperclip-sign-in-ws");
    const excludes = claudeSignInWorkspaceExcludes({
      workspaceLocalDir: workspace,
      env: { CLAUDE_CONFIG_DIR: ` ${path.join(workspace, "state", "claude-cfg")} ` },
      homeDir: path.join(workspace, "home", "agent"),
    });
    expect(excludes).toEqual(expect.arrayContaining([
      "state/claude-cfg/.credentials.json",
      "state/claude-cfg/credentials.json",
      "state/claude-cfg/.claude.json",
      "home/agent/.claude/.credentials.json",
      "home/agent/.claude/credentials.json",
      "home/agent/.claude.json",
    ]));
    expect(shouldExcludePath("state/claude-cfg/.credentials.json", excludes)).toBe(true);
    expect(shouldExcludePath("state/claude-cfg/settings.json", excludes)).toBe(false);
  });

  it("excludes top-level sign-in files when the workspace is the config dir or the home dir", () => {
    const workspace = path.join(os.tmpdir(), "paperclip-sign-in-cfg");
    expect(
      claudeSignInWorkspaceExcludes({ workspaceLocalDir: workspace, env: { CLAUDE_CONFIG_DIR: workspace }, homeDir: "" }),
    ).toEqual(expect.arrayContaining([".credentials.json", "credentials.json", ".claude.json"]));
    expect(
      claudeSignInWorkspaceExcludes({ workspaceLocalDir: workspace, env: {}, homeDir: workspace }),
    ).toEqual(expect.arrayContaining([".claude/.credentials.json", ".claude/credentials.json", ".claude.json"]));
  });

  it("ignores a relative or outside CLAUDE_CONFIG_DIR and home", () => {
    const workspace = path.join(os.tmpdir(), "paperclip-sign-in-ws");
    expect(
      claudeSignInWorkspaceExcludes({
        workspaceLocalDir: workspace,
        env: { CLAUDE_CONFIG_DIR: "relative/claude" },
        homeDir: path.join(os.tmpdir(), "paperclip-sign-in-other-home"),
      }),
    ).toEqual([...CLAUDE_SIGN_IN_ANY_DEPTH_WORKSPACE_EXCLUDES]);
  });

  it("matches a config dir reached through a symbolic link to the workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sign-in-link-"));
    cleanupDirs.push(rootDir);
    const realWorkspace = path.join(rootDir, "real-workspace");
    await mkdir(path.join(realWorkspace, "cfg"), { recursive: true });
    const linkedWorkspace = path.join(rootDir, "linked-workspace");
    await symlink(realWorkspace, linkedWorkspace);
    expect(
      claudeSignInWorkspaceExcludes({
        workspaceLocalDir: realWorkspace,
        env: { CLAUDE_CONFIG_DIR: path.join(linkedWorkspace, "cfg") },
        homeDir: "",
      }),
    ).toEqual(expect.arrayContaining(["cfg/.credentials.json", "cfg/credentials.json", "cfg/.claude.json"]));
  });

  it("merges into the caller's excludes and into a supplied baseline, keeping caller entries first", () => {
    const workspace = path.join(os.tmpdir(), "paperclip-sign-in-ws");
    const merged = withClaudeSignInWorkspaceExcludes(workspace, ["operator.txt", "*/.claude.json"]);
    expect(merged.slice(0, 2)).toEqual(["operator.txt", "*/.claude.json"]);
    expect(new Set(merged).size).toBe(merged.length);
    expect(merged).toEqual(expect.arrayContaining([...CLAUDE_SIGN_IN_ANY_DEPTH_WORKSPACE_EXCLUDES]));

    const entries = new Map([[".claude/.credentials.json", { kind: "file" as const, mode: 0o600, hash: "x" }]]);
    const staged = withClaudeSignInStagingExcludes({
      workspaceLocalDir: workspace,
      workspaceBaseline: { exclude: [".paperclip-runtime"], entries },
    });
    expect(staged.workspaceExclude).toEqual(expect.arrayContaining([...CLAUDE_SIGN_IN_ANY_DEPTH_WORKSPACE_EXCLUDES]));
    expect(staged.workspaceBaseline?.exclude[0]).toBe(".paperclip-runtime");
    expect(shouldExcludePath(".claude/.credentials.json", staged.workspaceBaseline?.exclude ?? [])).toBe(true);
    expect(staged.workspaceBaseline?.entries).toBe(entries);
    expect(withClaudeSignInStagingExcludes({ workspaceLocalDir: workspace })).not.toHaveProperty("workspaceBaseline");
  });
});

describe("isClaudeSignInPathSegments", () => {
  it("matches a credential file inside a .claude dir and .claude.json at any depth, ignoring case", () => {
    for (const relative of [
      ".claude/.credentials.json",
      ".claude/credentials.json",
      "home/svc/.claude/backups/credentials.json",
      ".claude.json",
      "home/svc/.Claude.json",
      "HOME/.CLAUDE/.Credentials.json",
    ]) {
      expect(isClaudeSignInPathSegments(relative.split("/")), relative).toBe(true);
    }
    for (const relative of [
      ".claude/settings.json",
      "credentials.json",
      "config/credentials.json",
      "src/.credentials.json",
      ".claude.json.d/readme.md",
    ]) {
      expect(isClaudeSignInPathSegments(relative.split("/")), relative).toBe(false);
    }
  });
});

describe("isClaudeSignInPath", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const elsewhere = path.join(os.tmpdir(), "paperclip-sign-in-path-elsewhere");

  it("matches a credential file directly inside any .claude dir and any .claude.json", () => {
    const opts = { env: {}, homeDir: elsewhere };
    const root = path.join(os.tmpdir(), "paperclip-sign-in-path");
    for (const candidate of [
      path.join(root, ".claude", ".credentials.json"),
      path.join(root, ".claude", "credentials.json"),
      path.join(root, "srv", ".CLAUDE", ".credentials.json"),
      path.join(root, ".claude.json"),
      path.join(root, "a", "b", ".Claude.json"),
    ]) {
      expect(isClaudeSignInPath(candidate, opts), candidate).toBe(true);
    }
    for (const candidate of [
      path.join(root, ".claude", "settings.json"),
      path.join(root, ".claude", "projects", "notes.md"),
      path.join(root, "credentials.json"),
      path.join(root, "src", ".credentials.json"),
      path.join(root, ".claude.json.d", "readme.md"),
      "relative/.claude/.credentials.json",
      "",
    ]) {
      expect(isClaudeSignInPath(candidate, opts), candidate).toBe(false);
    }
  });

  it("matches a credential file anywhere inside the server's CLAUDE_CONFIG_DIR and ~/.claude, whatever they are named", () => {
    const root = path.join(os.tmpdir(), "paperclip-sign-in-path-cfg");
    const configDir = path.join(root, "claude-config");
    const homeDir = path.join(root, "home");
    const opts = { env: { CLAUDE_CONFIG_DIR: ` ${configDir} ` }, homeDir };
    expect(isClaudeSignInPath(path.join(configDir, ".credentials.json"), opts)).toBe(true);
    expect(isClaudeSignInPath(path.join(configDir, "backups", "credentials.json"), opts)).toBe(true);
    expect(isClaudeSignInPath(path.join(configDir, ".claude.json"), opts)).toBe(true);
    expect(isClaudeSignInPath(path.join(homeDir, ".claude", "old", "credentials.json"), opts)).toBe(true);
    expect(isClaudeSignInPath(path.join(homeDir, ".claude.json"), opts)).toBe(true);
    expect(isClaudeSignInPath(path.join(configDir, "settings.json"), opts)).toBe(false);
    expect(isClaudeSignInPath(path.join(`${configDir}-other`, ".credentials.json"), opts)).toBe(false);
    expect(isClaudeSignInPath(path.join(root, "credentials.json"), opts)).toBe(false);
    // A relative CLAUDE_CONFIG_DIR names no folder of this server.
    expect(
      isClaudeSignInPath(path.join(process.cwd(), "claude-rel", ".credentials.json"), {
        env: { CLAUDE_CONFIG_DIR: "claude-rel" },
        homeDir: elsewhere,
      }),
    ).toBe(false);
  });

  it("follows symbolic links: a config dir reached through a link, and a sign-in file that links elsewhere", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-sign-in-path-link-"));
    cleanupDirs.push(root);
    const realConfigDir = path.join(root, "store", "cfg");
    await mkdir(realConfigDir, { recursive: true });
    await writeFile(path.join(realConfigDir, ".credentials.json"), "{}", "utf8");
    const linkedConfigDir = path.join(root, "cfg-link");
    await symlink(realConfigDir, linkedConfigDir);
    const homeDir = path.join(root, "home");
    await mkdir(path.join(root, "dotfiles"), { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(root, "dotfiles", "claude-state.json"), "{}", "utf8");
    await symlink(path.join(root, "dotfiles", "claude-state.json"), path.join(homeDir, ".claude.json"));

    const matcher = createClaudeSignInPathMatcher({ env: { CLAUDE_CONFIG_DIR: linkedConfigDir }, homeDir });
    expect(matcher(path.join(realConfigDir, ".credentials.json"))).toBe(true);
    expect(matcher(path.join(linkedConfigDir, ".credentials.json"))).toBe(true);
    expect(matcher(path.join(root, "dotfiles", "claude-state.json"))).toBe(true);
    expect(matcher(path.join(root, "dotfiles", "other.json"))).toBe(false);
    expect(matcher(path.join(root, "store", "credentials.json"))).toBe(false);
  });
});

describe("overlapsClaudeConfigDir", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("flags the server's config dirs, folders inside or around them, and any folder named .claude", () => {
    const root = path.join(os.tmpdir(), "paperclip-sign-in-overlap");
    const configDir = path.join(root, "state", "claude-config");
    const homeDir = path.join(root, "home", "svc");
    const opts = { env: { CLAUDE_CONFIG_DIR: configDir }, homeDir };
    for (const folder of [
      configDir,
      path.join(configDir, "projects"),
      path.join(root, "state"),
      root,
      path.join(homeDir, ".claude"),
      path.join(homeDir, ".claude", "skills"),
      homeDir,
      path.join(root, "repo", ".claude"),
      path.parse(root).root,
    ]) {
      expect(overlapsClaudeConfigDir(folder, opts), folder).toBe(true);
    }
    for (const folder of [
      path.join(root, "state", "claude-config-other"),
      path.join(root, "repo"),
      path.join(root, "repo", ".claude-notes"),
      path.join(homeDir, ".paperclip", "plugin-data"),
    ]) {
      expect(overlapsClaudeConfigDir(folder, opts), folder).toBe(false);
    }
  });

  it("flags a folder that reaches a config dir through a symbolic link", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-sign-in-overlap-link-"));
    cleanupDirs.push(root);
    const configDir = path.join(root, "store", "cfg");
    await mkdir(configDir, { recursive: true });
    const folderLink = path.join(root, "plugin-folder");
    await symlink(configDir, folderLink);
    const opts = { env: { CLAUDE_CONFIG_DIR: configDir }, homeDir: path.join(root, "home") };
    expect(overlapsClaudeConfigDir(folderLink, opts)).toBe(true);
    expect(overlapsClaudeConfigDir(path.join(root, "home", "notes"), opts)).toBe(false);
  });
});
