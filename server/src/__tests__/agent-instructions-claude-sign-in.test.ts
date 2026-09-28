import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentInstructionsService,
  syncInstructionsBundleConfigFromFilePath,
} from "../services/agent-instructions.js";

// Fork policy (doc/plans/2026-09-24-claude-cli-only-auth.md): the instructions
// bundle API never lists, reads, exports, writes or deletes a Claude sign-in
// file, and a Claude config dir (or a folder that holds one) is never set as a
// bundle root.

const SIGN_IN = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-bundle"}}\n';

function makeAgent(adapterConfig: Record<string, unknown>) {
  return { id: "agent-1", companyId: "company-1", name: "Agent 1", adapterConfig };
}

function externalAgent(rootPath: string, entryFile = "AGENTS.md") {
  return makeAgent({
    instructionsBundleMode: "external",
    instructionsRootPath: rootPath,
    instructionsEntryFile: entryFile,
    instructionsFilePath: path.join(rootPath, entryFile),
  });
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [relativePath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await fs.writeFile(path.join(root, relativePath), content, "utf8");
  }
}

describe("agent instructions never hand out a Claude sign-in", () => {
  const savedEnv = {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    PAPERCLIP_HOME: process.env.PAPERCLIP_HOME,
    PAPERCLIP_INSTANCE_ID: process.env.PAPERCLIP_INSTANCE_ID,
  };
  let sandbox: string;
  let homeDir: string;
  let configDir: string;

  beforeEach(async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-instructions-sign-in-")));
    homeDir = path.join(sandbox, "home");
    configDir = path.join(sandbox, "claude-cfg");
    await fs.mkdir(path.join(homeDir, ".claude"), { recursive: true });
    await writeFiles(configDir, {
      ".credentials.json": SIGN_IN,
      ".claude.json": SIGN_IN,
      "backups/.claude.json.backup.1790000000000": SIGN_IN,
      "CLAUDE.md": "# Claude memory\n",
    });
    process.env.HOME = homeDir;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.PAPERCLIP_HOME = path.join(sandbox, "paperclip");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("leaves sign-in files out of an external bundle's listing and export, and refuses to read them", async () => {
    const root = path.join(sandbox, "bundle");
    await writeFiles(root, {
      "AGENTS.md": "# Agent\n",
      "docs/TOOLS.md": "## Tools\n",
      ".claude/.credentials.json": SIGN_IN,
      ".claude/backups/.claude.json.backup.1790000000000": SIGN_IN,
      ".claude.json": SIGN_IN,
      "home/.claude.json.backup.1780000000000": SIGN_IN,
    });
    await fs.symlink(path.join(configDir, ".credentials.json"), path.join(root, "linked-sign-in.json"));
    await fs.symlink(configDir, path.join(root, "cfg-link"));

    const svc = agentInstructionsService();
    const agent = externalAgent(root);

    const bundle = await svc.getBundle(agent);
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "docs/TOOLS.md"]);

    const exported = await svc.exportFiles(agent);
    expect(Object.keys(exported.files).sort()).toEqual(["AGENTS.md", "docs/TOOLS.md"]);
    expect(JSON.stringify(exported)).not.toContain("sk-ant-oat01");

    for (const relativePath of [
      ".claude/.credentials.json",
      ".claude/backups/.claude.json.backup.1790000000000",
      ".claude.json",
      ".CLAUDE.JSON",
      "home/.claude.json.backup.1780000000000",
      "linked-sign-in.json",
      "cfg-link/.credentials.json",
      "cfg-link/backups/.claude.json.backup.1790000000000",
    ]) {
      await expect(svc.readFile(agent, relativePath), relativePath).rejects.toMatchObject({ status: 403 });
    }
    await expect(svc.readFile(agent, "docs/TOOLS.md")).resolves.toMatchObject({ content: "## Tools\n" });
  });

  it("hides the sign-in of a bundle root stored earlier that is the server's config dir, directly or through a link", async () => {
    const svc = agentInstructionsService();
    const linkedRoot = path.join(sandbox, "instructions-link");
    await fs.symlink(configDir, linkedRoot);

    for (const root of [configDir, linkedRoot]) {
      const agent = externalAgent(root, "CLAUDE.md");
      const bundle = await svc.getBundle(agent);
      expect(bundle.files.map((file) => file.path), root).toEqual(["CLAUDE.md"]);
      const exported = await svc.exportFiles(agent);
      expect(Object.keys(exported.files), root).toEqual(["CLAUDE.md"]);
      for (const relativePath of [".credentials.json", ".claude.json", "backups/.claude.json.backup.1790000000000"]) {
        await expect(svc.readFile(agent, relativePath), `${root} ${relativePath}`).rejects.toMatchObject({ status: 403 });
      }
      await expect(svc.readFile(agent, "CLAUDE.md")).resolves.toMatchObject({ content: "# Claude memory\n" });
    }
  });

  it("never falls back to reading a legacy instructions file that is a sign-in file", async () => {
    // A folder that holds nothing but the sign-in, so the export falls back to
    // the legacy file itself.
    await writeFiles(path.join(homeDir, ".claude"), { ".credentials.json": SIGN_IN });
    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsFilePath: path.join(homeDir, ".claude", ".credentials.json"),
      promptTemplate: "fallback prompt",
    });
    const exported = await svc.exportFiles(agent);
    expect(JSON.stringify(exported)).not.toContain("sk-ant-oat01");
    expect(Object.values(exported.files)).toEqual(["fallback prompt"]);
  });

  it("refuses to write or delete a sign-in file in the bundle, also through a linked folder", async () => {
    const root = path.join(sandbox, "bundle");
    await writeFiles(root, { "AGENTS.md": "# Agent\n", ".claude.json": SIGN_IN });
    await fs.symlink(configDir, path.join(root, "cfg-link"));
    const svc = agentInstructionsService();
    const agent = externalAgent(root);

    for (const relativePath of [".claude/.credentials.json", "cfg-link/.credentials.json", "cfg-link/.claude.json"]) {
      await expect(svc.writeFile(agent, relativePath, "overwritten"), relativePath).rejects.toMatchObject({ status: 403 });
    }
    await expect(fs.stat(path.join(root, ".claude", ".credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(configDir, ".credentials.json"), "utf8")).resolves.toBe(SIGN_IN);

    for (const relativePath of [".claude.json", "cfg-link/.credentials.json", "cfg-link/backups/.claude.json.backup.1790000000000"]) {
      await expect(svc.deleteFile(agent, relativePath), relativePath).rejects.toMatchObject({ status: 403 });
    }
    await expect(fs.readFile(path.join(root, ".claude.json"), "utf8")).resolves.toBe(SIGN_IN);
    await expect(fs.readFile(path.join(configDir, ".credentials.json"), "utf8")).resolves.toBe(SIGN_IN);
    await expect(fs.readFile(path.join(configDir, "backups", ".claude.json.backup.1790000000000"), "utf8")).resolves.toBe(SIGN_IN);

    // An ordinary file still writes and deletes.
    await expect(svc.writeFile(agent, "docs/NOTES.md", "# Notes\n")).resolves.toMatchObject({ file: { content: "# Notes\n" } });
    await expect(svc.deleteFile(agent, "docs/NOTES.md")).resolves.toBeTruthy();
  });

  it("refuses to materialize a managed bundle that carries a sign-in file, before touching the managed root", async () => {
    const svc = agentInstructionsService();
    const agent = makeAgent({});
    const first = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Managed\n" });
    const managedRoot = first.bundle.managedRootPath;
    await fs.symlink(configDir, path.join(managedRoot, "cfg-link"));

    for (const files of [
      { "AGENTS.md": "# Replaced\n", ".claude.json": SIGN_IN },
      { "AGENTS.md": "# Replaced\n", "home/.claude/.credentials.json": SIGN_IN },
      { "AGENTS.md": "# Replaced\n", ".claude/backups/.claude.json.backup.1": SIGN_IN },
    ]) {
      await expect(svc.materializeManagedBundle(agent, files, { replaceExisting: true })).rejects.toMatchObject({ status: 403 });
      await expect(fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8")).resolves.toBe("# Managed\n");
    }
    // A planted link in the managed root never carries a write into a config dir.
    await expect(
      svc.materializeManagedBundle(agent, { "cfg-link/.credentials.json": "overwritten" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(fs.readFile(path.join(configDir, ".credentials.json"), "utf8")).resolves.toBe(SIGN_IN);
  });

  it("refuses an external bundle root that is, lies inside or holds a Claude config dir, before creating anything", async () => {
    const svc = agentInstructionsService();
    const agent = externalAgent(path.join(sandbox, "ordinary"));
    await fs.mkdir(path.join(sandbox, "ordinary"), { recursive: true });

    for (const rootPath of [
      configDir,
      path.join(configDir, "instructions"),
      sandbox,
      homeDir,
      path.join(homeDir, ".claude"),
      path.join(sandbox, "repo", ".claude"),
    ]) {
      await expect(svc.updateBundle(agent, { mode: "external", rootPath }), rootPath).rejects.toMatchObject({ status: 422 });
    }
    await expect(fs.stat(path.join(configDir, "instructions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(sandbox, "repo"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(configDir, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const ordinary = await svc.updateBundle(agent, { mode: "external", rootPath: path.join(sandbox, "elsewhere") });
    expect(ordinary.bundle.rootPath).toBe(path.join(sandbox, "elsewhere"));
  });

  it("keeps a bundle root stored earlier inside a config dir working, with its sign-in hidden", async () => {
    const svc = agentInstructionsService();
    const agent = externalAgent(configDir, "CLAUDE.md");
    const result = await svc.updateBundle(agent, { mode: "external", entryFile: "CLAUDE.md" });
    expect(result.bundle.rootPath).toBe(configDir);
    expect(result.bundle.files.map((file) => file.path)).toEqual(["CLAUDE.md"]);
  });

  it("refuses a new legacy instructionsFilePath inside a Claude config dir, and keeps one stored earlier", () => {
    const current = makeAgent({ instructionsFilePath: path.join(sandbox, "ordinary", "AGENTS.md") });
    for (const filePath of [
      path.join(configDir, "CLAUDE.md"),
      path.join(homeDir, ".claude", "CLAUDE.md"),
      path.join(homeDir, "AGENTS.md"),
    ]) {
      expect(
        thrownBy(() => syncInstructionsBundleConfigFromFilePath(current, { instructionsFilePath: filePath })),
        filePath,
      ).toMatchObject({ status: 422 });
    }

    const stored = makeAgent({ instructionsFilePath: path.join(configDir, "CLAUDE.md") });
    expect(
      syncInstructionsBundleConfigFromFilePath(stored, { instructionsFilePath: path.join(configDir, "CLAUDE.md"), model: "x" }),
    ).toMatchObject({ instructionsRootPath: configDir, instructionsEntryFile: "CLAUDE.md" });

    expect(
      syncInstructionsBundleConfigFromFilePath(current, { instructionsFilePath: path.join(sandbox, "repo", "AGENTS.md") }),
    ).toMatchObject({ instructionsRootPath: path.join(sandbox, "repo") });
  });
});
