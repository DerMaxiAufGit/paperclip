import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareCommandManagedRuntime,
  type CommandManagedRuntimeRunner,
} from "./command-managed-runtime.js";
import {
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
  type SandboxSyncOperation,
  type SandboxSyncResult,
} from "./sandbox-managed-runtime.js";
import type { RunProcessResult } from "./server-utils.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// Fork policy: a Claude sign-in never leaves this server. Every adapter's
// remote staging (not only claude_local) leaves the Claude sign-in files of a
// workspace out of the upload and out of the sync-back, so a codex_local or
// opencode_local run whose workspace holds the service user's home or the
// server's CLAUDE_CONFIG_DIR does not forward the owner's Claude sign-in.

const execFile = promisify(execFileCallback);

const HOST_SIGN_IN = "host-sign-in\n";
const REMOTE_SIGN_IN = "remote-sign-in\n";

// Workspace-relative Claude sign-in files. `home/agent` is the service user's
// home (HOME) and `claude-cfg` is the server's CLAUDE_CONFIG_DIR, both inside
// the workspace; `project/.claude` and `.claude` are Claude config dirs at
// other depths.
const SIGN_IN_FILES = [
  ".claude/.credentials.json",
  "home/agent/.claude/.credentials.json",
  "home/agent/.claude.json",
  "claude-cfg/.credentials.json",
  "claude-cfg/.claude.json",
  "project/.claude/credentials.json",
];
const KEPT_FILES = [
  "README.md",
  ".claude/settings.json",
  "home/agent/.claude/settings.json",
  "claude-cfg/settings.json",
];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd });
}

async function seedWorkspace(workspaceDir: string, options: { git?: boolean } = {}): Promise<void> {
  for (const relative of KEPT_FILES) {
    await mkdir(path.dirname(path.join(workspaceDir, relative)), { recursive: true });
    await writeFile(path.join(workspaceDir, relative), `local ${relative}\n`, "utf8");
  }
  if (options.git) {
    await git(workspaceDir, ["init", "-b", "main"]);
    await git(workspaceDir, ["add", "."]);
    await git(workspaceDir, ["commit", "-m", "initial"]);
  }
  // Untracked sign-in files: a git-backed workspace ships them in its overlay.
  for (const relative of SIGN_IN_FILES) {
    await mkdir(path.dirname(path.join(workspaceDir, relative)), { recursive: true });
    await writeFile(path.join(workspaceDir, relative), HOST_SIGN_IN, "utf8");
  }
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectStagedWithoutSignIn(remoteWorkspaceDir: string): Promise<void> {
  for (const relative of KEPT_FILES) {
    await expect(readFile(path.join(remoteWorkspaceDir, relative), "utf8")).resolves.toBe(`local ${relative}\n`);
  }
  for (const relative of SIGN_IN_FILES) {
    await expectMissing(path.join(remoteWorkspaceDir, relative));
  }
}

// The remote run edits the workspace and plants its own sign-in files; the
// sync-back brings the edit home, keeps every host sign-in file, and never
// copies a remote sign-in file into the host workspace.
async function editRemoteAndRestore(
  remoteWorkspaceDir: string,
  restore: () => Promise<void>,
): Promise<void> {
  await writeFile(path.join(remoteWorkspaceDir, "README.md"), "remote readme\n", "utf8");
  await mkdir(path.join(remoteWorkspaceDir, "other/.claude"), { recursive: true });
  await writeFile(path.join(remoteWorkspaceDir, "other/.claude/.credentials.json"), REMOTE_SIGN_IN, "utf8");
  await writeFile(path.join(remoteWorkspaceDir, "claude-cfg/.credentials.json"), REMOTE_SIGN_IN, "utf8");
  await restore();
}

async function expectRestoredWithHostSignIn(localWorkspaceDir: string): Promise<void> {
  await expect(readFile(path.join(localWorkspaceDir, "README.md"), "utf8")).resolves.toBe("remote readme\n");
  for (const relative of SIGN_IN_FILES) {
    await expect(readFile(path.join(localWorkspaceDir, relative), "utf8")).resolves.toBe(HOST_SIGN_IN);
  }
  await expectMissing(path.join(localWorkspaceDir, "other/.claude/.credentials.json"));
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// A sandbox client backed by the local filesystem, with the base64-tar
// fallback `syncIn` (place each file, then run the post-upload commands).
function makeFilesystemClient(): SandboxManagedRuntimeClient {
  const client: SandboxManagedRuntimeClient = {
    makeDir: async (remotePath) => {
      await mkdir(remotePath, { recursive: true });
    },
    writeFile: async (remotePath, bytes) => {
      await mkdir(path.dirname(remotePath), { recursive: true });
      await writeFile(remotePath, Buffer.from(bytes));
    },
    readFile: async (remotePath) => await readFile(remotePath),
    listFiles: async (remotePath) => {
      const entries = await readdir(remotePath, { withFileTypes: true }).catch(() => []);
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    },
    remove: async (remotePath) => {
      await rm(remotePath, { recursive: true, force: true });
    },
    run: async (command) => {
      await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
    },
  };
  client.syncIn = async (operations: SandboxSyncOperation[]): Promise<SandboxSyncResult> => {
    const resultOperations: SandboxSyncResult["operations"] = [];
    for (const operation of operations) {
      let bytesTransferred = 0;
      for (const mapping of operation.files) {
        const bytes = await readFile(mapping.sourcePath);
        await client.makeDir(path.posix.dirname(mapping.targetPath));
        await client.writeFile(mapping.targetPath, toArrayBuffer(bytes));
        bytesTransferred += bytes.byteLength;
      }
      for (const command of operation.postUploadCommands ?? []) {
        await client.run(command.command, { timeoutMs: command.timeoutMs ?? 30_000 });
      }
      resultOperations.push({
        operationId: operation.operationId,
        filesTransferred: operation.files.length,
        bytesTransferred,
      });
    }
    return { operations: resultOperations };
  };
  return client;
}

// A command runner that runs each managed-runtime script locally, piping stdin.
function makeSpawnRunner(): CommandManagedRuntimeRunner {
  return {
    execute: async (input) =>
      await new Promise<RunProcessResult>((resolve) => {
        const startedAt = new Date().toISOString();
        const command =
          input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
        const child = spawn(command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", () => {
          resolve({ exitCode: 127, signal: null, timedOut: false, stdout, stderr, pid: null, startedAt });
        });
        child.on("close", async (code) => {
          if (input.onLog && stdout.length > 0) await input.onLog("stdout", stdout);
          resolve({ exitCode: code ?? 0, signal: null, timedOut: false, stdout, stderr, pid: child.pid ?? null, startedAt });
        });
        if (input.stdin != null) child.stdin.write(input.stdin);
        child.stdin.end();
      }),
  };
}

const sandboxSpec = (remoteCwd: string) => ({
  transport: "sandbox" as const,
  provider: "test",
  sandboxId: "sandbox-1",
  remoteCwd,
  timeoutMs: 30_000,
  apiKey: null,
});

describe("remote staging never forwards a Claude sign-in (every adapter)", () => {
  const cleanupDirs: string[] = [];
  const savedEnv = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  let rootDir = "";
  let localWorkspaceDir = "";
  let remoteWorkspaceDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-sign-in-staging-"));
    cleanupDirs.push(rootDir);
    localWorkspaceDir = path.join(rootDir, "local-workspace");
    remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    // The server's own HOME and CLAUDE_CONFIG_DIR both live inside the workspace.
    process.env.HOME = path.join(localWorkspaceDir, "home", "agent");
    process.env.CLAUDE_CONFIG_DIR = path.join(localWorkspaceDir, "claude-cfg");
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("sandbox: a codex run leaves the Claude sign-in out of a plain workspace upload and its sync-back", async () => {
    await seedWorkspace(localWorkspaceDir);
    const prepared = await prepareSandboxManagedRuntime({
      spec: sandboxSpec(remoteWorkspaceDir),
      adapterKey: "codex",
      client: makeFilesystemClient(),
      workspaceLocalDir: localWorkspaceDir,
    });
    await expectStagedWithoutSignIn(remoteWorkspaceDir);
    await editRemoteAndRestore(remoteWorkspaceDir, () => prepared.restoreWorkspace());
    await expectRestoredWithHostSignIn(localWorkspaceDir);
  });

  it("sandbox: a codex run leaves untracked Claude sign-in files out of a git-backed overlay and its sync-back", async () => {
    await seedWorkspace(localWorkspaceDir, { git: true });
    const prepared = await prepareSandboxManagedRuntime({
      spec: sandboxSpec(remoteWorkspaceDir),
      adapterKey: "codex",
      client: makeFilesystemClient(),
      workspaceLocalDir: localWorkspaceDir,
    });
    await expectStagedWithoutSignIn(remoteWorkspaceDir);
    await editRemoteAndRestore(remoteWorkspaceDir, () => prepared.restoreWorkspace());
    await expectRestoredWithHostSignIn(localWorkspaceDir);
  });

  it("sandbox: merges the sign-in excludes with the caller's excludes", async () => {
    await seedWorkspace(localWorkspaceDir);
    await writeFile(path.join(localWorkspaceDir, "operator-only.txt"), "stays local\n", "utf8");
    await prepareSandboxManagedRuntime({
      spec: sandboxSpec(remoteWorkspaceDir),
      adapterKey: "gemini",
      client: makeFilesystemClient(),
      workspaceLocalDir: localWorkspaceDir,
      workspaceExclude: ["operator-only.txt"],
    });
    await expectStagedWithoutSignIn(remoteWorkspaceDir);
    await expectMissing(path.join(remoteWorkspaceDir, "operator-only.txt"));
  });

  it("sandbox: a supplied baseline that still lists a sign-in file never deletes it on sync-back", async () => {
    await seedWorkspace(localWorkspaceDir);
    // A baseline persisted before the sign-in excludes existed lists the files.
    const staleBaseline = await captureDirectorySnapshot(localWorkspaceDir, { exclude: [".paperclip-runtime"] });
    expect(staleBaseline.entries.has("claude-cfg/.credentials.json")).toBe(true);
    const prepared = await prepareSandboxManagedRuntime({
      spec: sandboxSpec(remoteWorkspaceDir),
      adapterKey: "pi",
      client: makeFilesystemClient(),
      workspaceLocalDir: localWorkspaceDir,
      workspaceBaseline: staleBaseline,
    });
    await expectStagedWithoutSignIn(remoteWorkspaceDir);
    await editRemoteAndRestore(remoteWorkspaceDir, () => prepared.restoreWorkspace());
    await expectRestoredWithHostSignIn(localWorkspaceDir);
  });

  it("command runner: a referenced project never ships a Claude sign-in either", async () => {
    await seedWorkspace(localWorkspaceDir);
    const referencedDir = path.join(rootDir, "referenced-project");
    await mkdir(path.join(referencedDir, ".claude"), { recursive: true });
    await writeFile(path.join(referencedDir, "README.md"), "referenced\n", "utf8");
    await writeFile(path.join(referencedDir, ".claude", "settings.json"), "{}\n", "utf8");
    await writeFile(path.join(referencedDir, ".claude", ".credentials.json"), HOST_SIGN_IN, "utf8");
    await writeFile(path.join(referencedDir, ".claude.json"), HOST_SIGN_IN, "utf8");
    const prepared = await prepareCommandManagedRuntime({
      runner: makeSpawnRunner(),
      spec: { remoteCwd: remoteWorkspaceDir, timeoutMs: 30_000 },
      adapterKey: "kimi",
      workspaceLocalDir: localWorkspaceDir,
      additionalSources: [{ localPath: referencedDir, projectId: "ref", ignoreResolution: { kind: "other" } }],
    });
    const remoteProjectDir = prepared.additionalSourceDirs.ref!;
    expect(remoteProjectDir).toBeDefined();
    await expect(readFile(path.join(remoteProjectDir, "README.md"), "utf8")).resolves.toBe("referenced\n");
    await expect(readFile(path.join(remoteProjectDir, ".claude", "settings.json"), "utf8")).resolves.toBe("{}\n");
    await expectMissing(path.join(remoteProjectDir, ".claude", ".credentials.json"));
    await expectMissing(path.join(remoteProjectDir, ".claude.json"));
  });

  it("command runner: an opencode run leaves the Claude sign-in out of the upload and the sync-back", async () => {
    await seedWorkspace(localWorkspaceDir);
    const prepared = await prepareCommandManagedRuntime({
      runner: makeSpawnRunner(),
      spec: { remoteCwd: remoteWorkspaceDir, timeoutMs: 30_000 },
      adapterKey: "opencode",
      workspaceLocalDir: localWorkspaceDir,
    });
    await expectStagedWithoutSignIn(remoteWorkspaceDir);
    await editRemoteAndRestore(remoteWorkspaceDir, () => prepared.restoreWorkspace());
    await expectRestoredWithHostSignIn(localWorkspaceDir);
  });
});
