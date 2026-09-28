import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { excludePatternMatches, shouldExcludePath } from "./exclude-patterns.js";
import type { DirectorySnapshot } from "./workspace-restore-merge.js";

const { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution, syncDirectoryToSsh } = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(async (_input: { exclude?: string[] }) => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async (_input: { baselineSnapshot?: DirectorySnapshot }) => undefined),
  syncDirectoryToSsh: vi.fn(async (_input: { localDir: string; exclude?: string[] }) => undefined),
}));

vi.mock("./ssh.js", () => ({
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
  syncDirectoryToSsh,
}));

import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

// Fork policy: an SSH target never receives a Claude sign-in from this server,
// whatever the adapter. The SSH workspace upload (tar `--exclude`, matched at
// any depth) and its restore baseline (matched by `shouldExcludePath`) leave
// the Claude sign-in files out.

const SIGN_IN_FILES = [
  ".claude/.credentials.json",
  "home/agent/.claude/.credentials.json",
  "home/agent/.claude.json",
  "claude-cfg/.credentials.json",
  "claude-cfg/.claude.json",
  "project/.claude/credentials.json",
];

describe("SSH staging never forwards a Claude sign-in (every adapter)", () => {
  const cleanupDirs: string[] = [];
  const savedEnv = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

  afterEach(async () => {
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("excludes the Claude sign-in files from a codex SSH upload and its restore baseline", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-claude-sign-in-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    process.env.HOME = path.join(workspaceDir, "home", "agent");
    process.env.CLAUDE_CONFIG_DIR = path.join(workspaceDir, "claude-cfg");
    for (const relative of [...SIGN_IN_FILES, "README.md", "home/agent/.claude/settings.json", "operator-only.txt"]) {
      await mkdir(path.dirname(path.join(workspaceDir, relative)), { recursive: true });
      await writeFile(path.join(workspaceDir, relative), "x\n", "utf8");
    }

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-ssh-sign-in",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceExclude: ["operator-only.txt"],
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    const uploadExclude = prepareWorkspaceForSshExecution.mock.calls[0]![0].exclude ?? [];
    // The caller's exclude survives the merge.
    expect(uploadExclude).toContain("operator-only.txt");
    // tar matches a pattern unanchored, so each sign-in file is covered by a
    // pattern that is a trailing path of it (the resolved config dir paths and
    // the `.claude` dir patterns).
    for (const relative of SIGN_IN_FILES) {
      expect(
        uploadExclude.some((pattern) => {
          const literal = pattern.startsWith("*/") ? pattern.slice(2) : pattern;
          return relative === literal || relative.endsWith(`/${literal}`);
        }),
      ).toBe(true);
    }
    expect(uploadExclude.some((pattern) => excludePatternMatches("README.md", pattern))).toBe(false);
    expect(uploadExclude.some((pattern) => excludePatternMatches("home/agent/.claude/settings.json", pattern))).toBe(false);

    await prepared.restoreWorkspace();
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    const baseline = restoreWorkspaceFromSshExecution.mock.calls[0]![0].baselineSnapshot!;
    for (const relative of SIGN_IN_FILES) {
      expect(baseline.entries.has(relative)).toBe(false);
      expect(shouldExcludePath(relative, baseline.exclude)).toBe(true);
    }
    // A sign-in file the remote plants in any other Claude config dir is not
    // synced back either.
    expect(shouldExcludePath("other/.claude/.credentials.json", baseline.exclude)).toBe(true);
    expect(shouldExcludePath("other/.claude.json", baseline.exclude)).toBe(true);
    expect(baseline.entries.has("README.md")).toBe(true);
    expect(baseline.entries.has("home/agent/.claude/settings.json")).toBe(true);
    expect(shouldExcludePath("home/agent/.claude/settings.json", baseline.exclude)).toBe(false);
  });

  it("excludes the Claude sign-in files from a referenced project's SSH upload", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-claude-sign-in-ref-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const projectDir = path.join(rootDir, "referenced-project");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = path.join(projectDir, "cfg");

    await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-ssh-sign-in-ref",
      adapterKey: "pi",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: projectDir, projectId: "proj", ignoreResolution: { kind: "git", ignoredPaths: ["secret.env"] } },
      ],
    });

    const call = syncDirectoryToSsh.mock.calls.find((entry) => entry[0].localDir === projectDir);
    expect(call).toBeDefined();
    const exclude = call![0].exclude ?? [];
    expect(exclude).toContain("secret.env");
    expect(exclude).toContain("node_modules");
    for (const pattern of [".claude/.credentials.json", ".claude/credentials.json", ".claude.json", "cfg/.credentials.json"]) {
      expect(exclude).toContain(pattern);
    }
  });
});
