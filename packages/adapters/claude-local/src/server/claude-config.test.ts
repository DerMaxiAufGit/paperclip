import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// A shared handle so the managed-config test can force the runtime preparation
// step to throw an error that carries untrusted markers, and the staging tests
// can capture the assets it stages.
const { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: null,
    startedAt: new Date(0).toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    adapterExecutionTargetUsesManagedHome: () => true,
    maybeRunSandboxInstallCommand: async () => null,
    prepareAdapterExecutionTargetRuntime,
    runAdapterExecutionTargetShellCommand,
  };
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterManagedRuntimeAsset } from "@paperclipai/adapter-utils/execution-target";
import { createTarballFromDirectory } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { prepareClaudeConfigSeed, prepareSandboxClaudeProbeRuntime } from "./claude-config.js";

const execFileAsync = promisify(execFile);

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
  });

  it("never copies credential settings (env block or helper commands) into a remote seed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-credentials-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "dark",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-host", ANTHROPIC_API_KEY: "sk-ant-host" },
      apiKeyHelper: "/usr/local/bin/print-key",
      awsAuthRefresh: "aws sso login",
      awsCredentialExport: "/usr/local/bin/aws-creds",
      otelHeadersHelper: "/usr/local/bin/otel-headers",
    }), "utf8");

    const seedDir = await prepareClaudeConfigSeed(createEnv(root, sourceDir), vi.fn(async () => {}), "company-1");
    const raw = await fs.readFile(path.join(seedDir, "settings.json"), "utf8");

    expect(JSON.parse(raw)).toEqual({ theme: "dark", permissions: { defaultMode: "default" } });
    expect(raw).not.toContain("sk-ant-oat01-host");
    expect(raw).not.toContain("sk-ant-host");
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });
});

describe("prepareSandboxClaudeProbeRuntime managed-config diagnostics", () => {
  const cleanupDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const sandboxTarget: AdapterExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/home/daytona/paperclip-workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps a thrown config-materialization error out of every check and the log", async () => {
    // The runtime preparation throws an error that carries two untrusted values:
    // an opaque credential marker and a proxy marker. Neither may reach a check
    // or the server log. The log carries only the fixed context, the allowlisted
    // classification, and the safe error class name.
    const opaqueCredMarker = "OPAQUECREDMARKERconfig";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-mgmt-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    for (const key of ["CLAUDE_CONFIG_DIR", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = sourceDir;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    prepareAdapterExecutionTargetRuntime.mockRejectedValueOnce(
      new Error(`materialize failed with ${opaqueCredMarker} via ${proxyMarker}`),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await prepareSandboxClaudeProbeRuntime({
      runId: "run-1",
      target: sandboxTarget,
      // The probe passes no CLAUDE_CONFIG_DIR, so the managed branch runs.
      cwd: "/home/daytona/paperclip-workspace",
      companyId: "company-1",
      env: {},
      installCommand: "install-claude",
      detectCommand: "claude",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 30,
    });

    const failed = checks.find((check) => check.code === "claude_managed_config_dir_failed");
    expect(failed).toBeTruthy();
    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "spawn_error",
      errorClass: "Error",
    });
    warnSpy.mockRestore();
  });
});

describe("prepareSandboxClaudeProbeRuntime config-seed staging", () => {
  const cleanupDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const sandboxTarget: AdapterExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/home/daytona/paperclip-workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };

  afterEach(async () => {
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeRoot(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(root);
    for (const key of ["CLAUDE_CONFIG_DIR", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
      if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    }
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    return root;
  }

  // A Claude config dir as the service user's ~/.claude looks: a sign-in, the
  // global state file, and settings, plus a sign-in copy one level down.
  async function writeSignedInClaudeConfigDir(dir: string): Promise<void> {
    await fs.mkdir(path.join(dir, "backup"), { recursive: true });
    await fs.writeFile(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-HOSTSIGNIN" } }));
    await fs.writeFile(path.join(dir, "credentials.json"), JSON.stringify({ token: "sk-ant-ort01-HOSTREFRESH" }));
    await fs.writeFile(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "owner@example.test" }, primaryApiKey: "sk-ant-api03-HOSTCONSOLE" }));
    await fs.writeFile(path.join(dir, "backup", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-HOSTBACKUP" } }));
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ theme: "dark" }));
  }

  // Stage every asset the probe hands to the runtime preparation through the
  // real tarball builder, then unpack it, so the test sees exactly what would
  // reach the sandbox.
  function captureStagedAssets(root: string): {
    assets: AdapterManagedRuntimeAsset[];
    stagedDirs: Record<string, string>;
    archives: Record<string, Buffer>;
  } {
    const captured = {
      assets: [] as AdapterManagedRuntimeAsset[],
      stagedDirs: {} as Record<string, string>,
      archives: {} as Record<string, Buffer>,
    };
    prepareAdapterExecutionTargetRuntime.mockImplementation(
      async (input: { assets?: AdapterManagedRuntimeAsset[] }) => {
        for (const asset of input.assets ?? []) {
          captured.assets.push(asset);
          const archivePath = path.join(root, `${asset.key}.tar`);
          await createTarballFromDirectory({
            localDir: asset.localDir,
            archivePath,
            exclude: asset.exclude,
            followSymlinks: asset.followSymlinks,
          });
          captured.archives[asset.key] = await fs.readFile(archivePath);
          const stagedDir = path.join(root, "staged", asset.key);
          await fs.mkdir(stagedDir, { recursive: true });
          await execFileAsync("tar", ["-xf", archivePath, "-C", stagedDir]);
          captured.stagedDirs[asset.key] = stagedDir;
        }
        return {
          target: sandboxTarget,
          workspaceRemoteDir: "/home/daytona/paperclip-workspace",
          runtimeRootDir: "/home/daytona/paperclip-workspace/.paperclip-runtime/claude",
          assetDirs: { "config-seed": "/home/daytona/paperclip-workspace/.paperclip-runtime/claude/config-seed" },
          additionalSourceDirs: {},
          additionalSourceFailures: [],
          workspaceSyncSnapshot: null,
          restoreWorkspace: async () => {},
        };
      },
    );
    return captured;
  }

  async function listRelative(dir: string, relative = ""): Promise<string[]> {
    const entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      out.push(next);
      if (entry.isDirectory()) out.push(...(await listRelative(dir, next)));
    }
    return out.sort();
  }

  function probeInput(env: Record<string, string>, managedAiConnection?: boolean) {
    return {
      ...(managedAiConnection === undefined ? {} : { managedAiConnection }),
      runId: "run-seed",
      target: sandboxTarget,
      cwd: "/home/daytona/paperclip-workspace",
      companyId: "company-1",
      env,
      installCommand: "install-claude",
      detectCommand: "claude",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 30,
    };
  }

  it("never stages the Claude sign-in or .claude.json of a CLAUDE_CONFIG_DIR used as a managed AI connection's seed", async () => {
    // A managed AI connection's config dir is staged as the seed as-is. When it
    // names a signed-in Claude config dir (for example the service user's
    // ~/.claude), its sign-in files and global state file stay on this server.
    const root = await makeRoot("paperclip-claude-seed-managed-");
    const configDir = path.join(root, "service-home", ".claude");
    await writeSignedInClaudeConfigDir(configDir);
    const captured = captureStagedAssets(root);

    const checks = await prepareSandboxClaudeProbeRuntime(
      probeInput({ ANTHROPIC_API_KEY: "sk-ant-api03-remote", CLAUDE_CONFIG_DIR: configDir }, true),
    );

    expect(checks.some((check) => check.code === "claude_managed_config_dir_failed")).toBe(false);
    const seedAsset = captured.assets.find((asset) => asset.key === "config-seed");
    expect(seedAsset).toBeDefined();
    expect(seedAsset?.exclude).toEqual(expect.arrayContaining([".credentials.json", "credentials.json", ".claude.json"]));
    const staged = await listRelative(captured.stagedDirs["config-seed"]!);
    expect(staged).toEqual(["backup", "settings.json"]);
    const archiveText = captured.archives["config-seed"]!.toString("latin1");
    for (const marker of ["HOSTSIGNIN", "HOSTREFRESH", "HOSTCONSOLE", "HOSTBACKUP", "owner@example.test"]) {
      expect(archiveText).not.toContain(marker);
    }
  });

  it("stages the config seed without following a symbolic link planted in it", async () => {
    // The seed is a Paperclip-managed dir of regular files. A link planted in it
    // must not pull the target's content (a host sign-in) into the sandbox.
    const root = await makeRoot("paperclip-claude-seed-symlink-");
    const hostConfigDir = path.join(root, "service-home", ".claude");
    await writeSignedInClaudeConfigDir(hostConfigDir);
    const seedDir = path.join(root, "managed-ai-home", "provider");
    await fs.mkdir(seedDir, { recursive: true });
    await fs.symlink(path.join(hostConfigDir, ".credentials.json"), path.join(seedDir, "notes.md"));
    await fs.symlink(hostConfigDir, path.join(seedDir, "linked-config"));
    const captured = captureStagedAssets(root);

    await prepareSandboxClaudeProbeRuntime(
      probeInput({ ANTHROPIC_API_KEY: "sk-ant-api03-remote", CLAUDE_CONFIG_DIR: seedDir }, true),
    );

    const seedAsset = captured.assets.find((asset) => asset.key === "config-seed");
    expect(seedAsset?.followSymlinks).toBe(false);
    const archiveText = captured.archives["config-seed"]!.toString("latin1");
    for (const marker of ["HOSTSIGNIN", "HOSTREFRESH", "HOSTCONSOLE", "HOSTBACKUP", "theme"]) {
      expect(archiveText).not.toContain(marker);
    }
    const stagedLink = await fs.lstat(path.join(captured.stagedDirs["config-seed"]!, "notes.md"));
    expect(stagedLink.isSymbolicLink()).toBe(true);
  });

  it("stages the sanitized managed seed with the same sign-in excludes and no link following", async () => {
    const root = await makeRoot("paperclip-claude-seed-default-");
    const sourceDir = path.join(root, "service-home", ".claude");
    await writeSignedInClaudeConfigDir(sourceDir);
    process.env.CLAUDE_CONFIG_DIR = sourceDir;
    const captured = captureStagedAssets(root);

    const checks = await prepareSandboxClaudeProbeRuntime(probeInput({ ANTHROPIC_API_KEY: "sk-ant-api03-remote" }));

    expect(checks.some((check) => check.code === "claude_managed_config_dir")).toBe(true);
    const seedAsset = captured.assets.find((asset) => asset.key === "config-seed");
    expect(seedAsset).toMatchObject({ followSymlinks: false });
    expect(seedAsset?.exclude).toEqual(expect.arrayContaining([".credentials.json", "credentials.json", ".claude.json"]));
    expect(await listRelative(captured.stagedDirs["config-seed"]!)).toEqual(["settings.json"]);
  });
});
