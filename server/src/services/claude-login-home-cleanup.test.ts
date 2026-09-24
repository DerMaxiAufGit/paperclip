import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOCAL_AI_LOGIN_HOMES_DIRNAME,
  removeLeftoverClaudeLoginHomes,
  removeStaleClaudeConfigSeeds,
} from "./claude-login-home-cleanup.js";

function createLoggerSpy() {
  return { info: vi.fn(), warn: vi.fn() };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeHome(root: string, name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), content);
  }
  return dir;
}

const claudeCredentials = JSON.stringify({
  claudeAiOauth: { accessToken: "sk-ant-oat-test", refreshToken: "sk-ant-ort-test" },
});

describe("removeLeftoverClaudeLoginHomes", () => {
  let tempRoot: string;
  let instanceRoot: string;
  let loginsDir: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-login-cleanup-"));
    instanceRoot = path.join(tempRoot, "instance");
    loginsDir = path.join(instanceRoot, LOCAL_AI_LOGIN_HOMES_DIRNAME);
    await fs.mkdir(instanceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("returns quietly when the login homes directory does not exist", async () => {
    const logger = createLoggerSpy();
    await expect(removeLeftoverClaudeLoginHomes({ instanceRoot, logger })).resolves.toEqual({
      removed: 0,
      failed: 0,
    });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await exists(loginsDir)).toBe(false);
  });

  it("removes a home whose .credentials.json holds claudeAiOauth and drops the emptied parent", async () => {
    const logger = createLoggerSpy();
    const home = await writeHome(loginsDir, "claude-oauth", { ".credentials.json": claudeCredentials });

    const result = await removeLeftoverClaudeLoginHomes({ instanceRoot, logger });

    expect(result).toEqual({ removed: 1, failed: 0 });
    expect(await exists(home)).toBe(false);
    expect(await exists(loginsDir)).toBe(false);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[1]).toBe(`Removed 1 leftover Claude login home(s) from ${loginsDir}`);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("removes a home that only contains .claude.json and one with credentials.json", async () => {
    const logger = createLoggerSpy();
    const configOnly = await writeHome(loginsDir, "claude-config-only", { ".claude.json": "{}" });
    const plainCredentials = await writeHome(loginsDir, "claude-plain-credentials", {
      "credentials.json": claudeCredentials,
    });

    const result = await removeLeftoverClaudeLoginHomes({ instanceRoot, logger });

    expect(result).toEqual({ removed: 2, failed: 0 });
    expect(await exists(configOnly)).toBe(false);
    expect(await exists(plainCredentials)).toBe(false);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[1]).toBe(`Removed 2 leftover Claude login home(s) from ${loginsDir}`);
  });

  it("keeps Codex and Grok homes, top-level files, and non-Claude credential files", async () => {
    const logger = createLoggerSpy();
    const claude = await writeHome(loginsDir, "claude", { ".credentials.json": claudeCredentials });
    const codex = await writeHome(loginsDir, "codex", {
      "config.toml": 'cli_auth_credentials_store = "file"\n',
      "auth.json": JSON.stringify({ tokens: { access_token: "codex" } }),
    });
    const grok = await writeHome(loginsDir, "grok", {
      "settings.json": "{}",
      "credentials.json": JSON.stringify({ xaiOauth: { accessToken: "grok" } }),
    });
    const invalidJson = await writeHome(loginsDir, "invalid-json", { ".credentials.json": "{not json" });
    const nestedKey = await writeHome(loginsDir, "nested-key", {
      ".credentials.json": JSON.stringify({ wrapper: { claudeAiOauth: {} } }),
    });
    const empty = await writeHome(loginsDir, "empty-attempt", {});
    const topLevelFile = path.join(loginsDir, ".claude.json");
    await fs.writeFile(topLevelFile, "{}");

    const result = await removeLeftoverClaudeLoginHomes({ instanceRoot, logger });

    expect(result).toEqual({ removed: 1, failed: 0 });
    expect(await exists(claude)).toBe(false);
    for (const kept of [codex, grok, invalidJson, nestedKey, empty, topLevelFile]) {
      expect(await exists(kept)).toBe(true);
    }
    expect(await fs.readFile(path.join(codex, "auth.json"), "utf8")).toContain("codex");
    expect(await exists(loginsDir)).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not follow symlinked children or delete their targets", async () => {
    const logger = createLoggerSpy();
    const outside = await writeHome(tempRoot, "outside-claude-home", {
      ".claude.json": "{}",
      ".credentials.json": claudeCredentials,
    });
    await fs.mkdir(loginsDir, { recursive: true });
    const link = path.join(loginsDir, "linked-home");
    await fs.symlink(outside, link, "dir");

    const result = await removeLeftoverClaudeLoginHomes({ instanceRoot, logger });

    expect(result).toEqual({ removed: 0, failed: 0 });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await exists(path.join(outside, ".claude.json"))).toBe(true);
    expect(await exists(path.join(outside, ".credentials.json"))).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not treat symlinked marker files as Claude evidence or delete through nested symlinks", async () => {
    const logger = createLoggerSpy();
    const outside = await writeHome(tempRoot, "outside", {
      ".claude.json": "{}",
      "keep.txt": "keep",
    });
    const symlinkMarkerHome = await writeHome(loginsDir, "symlink-marker", {});
    await fs.symlink(path.join(outside, ".claude.json"), path.join(symlinkMarkerHome, ".claude.json"));
    const claudeWithNestedLink = await writeHome(loginsDir, "claude-nested-link", { ".claude.json": "{}" });
    await fs.symlink(outside, path.join(claudeWithNestedLink, "outside-link"), "dir");

    const result = await removeLeftoverClaudeLoginHomes({ instanceRoot, logger });

    expect(result).toEqual({ removed: 1, failed: 0 });
    expect(await exists(symlinkMarkerHome)).toBe(true);
    expect(await exists(claudeWithNestedLink)).toBe(false);
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await exists(path.join(outside, ".claude.json"))).toBe(true);
  });

  it("leaves an already-empty login homes directory alone", async () => {
    const logger = createLoggerSpy();
    await fs.mkdir(loginsDir, { recursive: true });

    const result = await removeLeftoverClaudeLoginHomes({ instanceRoot, logger });

    expect(result).toEqual({ removed: 0, failed: 0 });
    expect(await exists(loginsDir)).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ignores a login homes path that is a symlink to a directory", async () => {
    const logger = createLoggerSpy();
    const outside = path.join(tempRoot, "outside-logins");
    const claudeHome = await writeHome(outside, "claude", { ".claude.json": "{}" });
    await fs.symlink(outside, loginsDir, "dir");

    const result = await removeLeftoverClaudeLoginHomes({ instanceRoot, logger });

    expect(result).toEqual({ removed: 0, failed: 0 });
    expect(await exists(claudeHome)).toBe(true);
  });

  it("warns once and never throws when the directory cannot be read", async () => {
    const logger = createLoggerSpy();
    const fileAsInstanceRoot = path.join(tempRoot, "not-a-directory");
    await fs.writeFile(fileAsInstanceRoot, "file");

    const result = await removeLeftoverClaudeLoginHomes({ instanceRoot: fileAsInstanceRoot, logger });

    expect(result).toEqual({ removed: 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[1]).toBe("Failed to clean up leftover Claude login homes");
    expect(logger.info).not.toHaveBeenCalled();
    expect(await fs.readFile(fileAsInstanceRoot, "utf8")).toBe("file");
  });

  it("never throws even when the logger itself throws", async () => {
    const logger = {
      info: vi.fn(() => {
        throw new Error("logger broke");
      }),
      warn: vi.fn(() => {
        throw new Error("logger broke");
      }),
    };
    await writeHome(loginsDir, "claude", { ".claude.json": "{}" });
    const fileAsInstanceRoot = path.join(tempRoot, "not-a-directory");
    await fs.writeFile(fileAsInstanceRoot, "file");

    await expect(removeLeftoverClaudeLoginHomes({ instanceRoot, logger })).resolves.toEqual({
      removed: 1,
      failed: 0,
    });
    await expect(
      removeLeftoverClaudeLoginHomes({ instanceRoot: fileAsInstanceRoot, logger }),
    ).resolves.toEqual({ removed: 0, failed: 1 });
  });
});

describe("removeStaleClaudeConfigSeeds", () => {
  let instanceRoot: string;

  beforeEach(async () => {
    instanceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-seed-cleanup-"));
  });

  afterEach(async () => {
    await fs.rm(instanceRoot, { recursive: true, force: true });
  });

  it("removes only seed snapshots whose settings still carry credential keys", async () => {
    const companySeeds = path.join(instanceRoot, "companies", "company-1", "claude-config-seed");
    const stale = await writeHome(companySeeds, "stale", {
      "settings.json": JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } }),
    });
    const helper = await writeHome(path.join(instanceRoot, "claude-config-seed"), "helper", {
      "settings.json": JSON.stringify({ apiKeyHelper: "/bin/print-key" }),
    });
    const clean = await writeHome(companySeeds, "clean", {
      "settings.json": JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }),
      "CLAUDE.md": "instructions",
    });
    const logger = createLoggerSpy();

    const result = await removeStaleClaudeConfigSeeds({ instanceRoot, logger });

    expect(result).toEqual({ removed: 2, failed: 0 });
    expect(await exists(stale)).toBe(false);
    expect(await exists(helper)).toBe(false);
    expect(await exists(clean)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does nothing when no seed directory exists", async () => {
    await expect(removeStaleClaudeConfigSeeds({ instanceRoot, logger: createLoggerSpy() })).resolves.toEqual({
      removed: 0,
      failed: 0,
    });
  });
});
