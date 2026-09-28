import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  assertConfiguredLocalFolder,
  assertPluginLocalFolderOutsideClaudeConfig,
  assertWritableConfiguredLocalFolder,
  inspectPluginLocalFolder,
  listPluginLocalFolderEntries,
  preparePluginLocalFolder,
  readPluginLocalFolderText,
  resolvePluginLocalFolderPath,
  deletePluginLocalFolderFile,
  writePluginLocalFolderTextAtomic,
} from "../services/plugin-local-folders.js";

describe("plugin local folders", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-folder-"));
    tempRoots.push(root);
    return root;
  }

  it("reports a healthy generic folder when required paths exist", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "sources"));
    await fs.writeFile(path.join(root, "schema.md"), "schema", "utf8");

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredDirectories: ["sources"],
        requiredFiles: ["schema.md"],
      },
    });

    expect(status.healthy).toBe(true);
    expect(status.problems).toEqual([]);
    expect(status.requiredDirectories).toEqual(["sources"]);
    expect(status.requiredFiles).toEqual(["schema.md"]);
  });

  it("reports missing required folders and files without using product-specific branches", async () => {
    const root = await makeRoot();

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        requiredDirectories: ["sources"],
        requiredFiles: ["schema.md"],
      },
    });

    expect(status.healthy).toBe(false);
    expect(status.missingDirectories).toEqual(["sources"]);
    expect(status.missingFiles).toEqual(["schema.md"]);
    expect(status.problems.map((item) => item.code)).toEqual(
      expect.arrayContaining(["missing_directory", "missing_file"]),
    );
  });

  it("reports all required paths as missing when the configured root does not exist", async () => {
    const root = await makeRoot();
    const missingRoot = path.join(root, "missing-root");

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: missingRoot,
        requiredDirectories: ["sources"],
        requiredFiles: ["schema.md"],
      },
    });

    expect(status.healthy).toBe(false);
    expect(status.configured).toBe(true);
    expect(status.readable).toBe(false);
    expect(status.missingDirectories).toEqual(["sources"]);
    expect(status.missingFiles).toEqual(["schema.md"]);
    expect(status.problems.map((item) => item.code)).toContain("missing");
  });

  it("uses manifest declaration access and required paths over stored or caller overrides", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "manifest-dir"));
    await fs.writeFile(path.join(root, "manifest.md"), "schema", "utf8");

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      declaration: {
        folderKey: "content-root",
        displayName: "Content root",
        access: "read",
        requiredDirectories: ["manifest-dir"],
        requiredFiles: ["manifest.md"],
      },
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredDirectories: ["stored-dir"],
        requiredFiles: ["stored.md"],
      },
      overrideConfig: {
        access: "readWrite",
        requiredDirectories: ["override-dir"],
        requiredFiles: ["override.md"],
      },
    });

    expect(status.access).toBe("read");
    expect(status.writable).toBe(false);
    expect(status.requiredDirectories).toEqual(["manifest-dir"]);
    expect(status.requiredFiles).toEqual(["manifest.md"]);
    expect(status.healthy).toBe(true);
  });

  it("prepares required directories for a read-write folder without creating required files", async () => {
    const root = await makeRoot();

    await preparePluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredDirectories: ["sources", "wiki/concepts"],
        requiredFiles: ["schema.md"],
      },
    });

    await expect(fs.stat(path.join(root, "sources"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(root, "wiki/concepts"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(root, "schema.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredDirectories: ["sources", "wiki/concepts"],
        requiredFiles: ["schema.md"],
      },
    });
    expect(status.missingDirectories).toEqual([]);
    expect(status.missingFiles).toEqual(["schema.md"]);
  });

  it("allows write access to repair folders that are only missing required paths", async () => {
    const root = await makeRoot();
    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredFiles: ["schema.md"],
      },
    });

    expect(status.healthy).toBe(false);
    expect(() => assertConfiguredLocalFolder(status)).toThrow("Local folder is not healthy");
    expect(() => assertWritableConfiguredLocalFolder(status)).not.toThrow();

    await writePluginLocalFolderTextAtomic(root, "schema.md", "schema");
    const repaired = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredFiles: ["schema.md"],
      },
    });
    expect(repaired.healthy).toBe(true);
  });

  it("rejects traversal outside the configured folder", async () => {
    const root = await makeRoot();

    await expect(resolvePluginLocalFolderPath(root, "../outside.txt")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("detects required symlinks that escape the configured folder", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fs.writeFile(path.join(outside, "secret.txt"), "nope", "utf8");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        requiredFiles: ["linked.txt"],
      },
    });

    expect(status.healthy).toBe(false);
    expect(status.problems.some((item) => item.code === "symlink_escape")).toBe(true);
  });

  it("writes files atomically under the root and can read them back", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "nested"));

    await writePluginLocalFolderTextAtomic(root, "nested/page.md", "hello");
    await writePluginLocalFolderTextAtomic(root, "nested/page.md", "updated");

    await expect(readPluginLocalFolderText(root, "nested/page.md")).resolves.toBe("updated");
    const leftovers = await fs.readdir(path.join(root, "nested"));
    expect(leftovers.filter((name) => name.includes(".paperclip-"))).toEqual([]);
  });

  it("creates missing nested parent directories for atomic writes", async () => {
    const root = await makeRoot();

    await writePluginLocalFolderTextAtomic(root, "cases/active/smoke/README.md", "hello");

    await expect(readPluginLocalFolderText(root, "cases/active/smoke/README.md")).resolves.toBe("hello");
  });

  it("returns the real folder key after deleting a file", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "stale.md"), "delete me", "utf8");

    const status = await deletePluginLocalFolderFile(root, "stale.md", "content-root");

    expect(status.folderKey).toBe("content-root");
    await expect(fs.stat(path.join(root, "stale.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists nested local folder entries without following symlink escapes", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fs.mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await fs.writeFile(path.join(root, "wiki/concepts/live.md"), "# Live\n", "utf8");
    await fs.writeFile(path.join(outside, "secret.md"), "# Secret\n", "utf8");
    await fs.symlink(outside, path.join(root, "wiki/outside"));

    const listing = await listPluginLocalFolderEntries(root, {
      relativePath: "wiki",
      recursive: true,
      maxEntries: 20,
    });

    expect(listing.entries.map((entry) => entry.path)).toContain("wiki/concepts/live.md");
    expect(listing.entries.map((entry) => entry.path)).not.toContain("wiki/outside/secret.md");
    expect(listing.truncated).toBe(false);
  });

  it("revalidates temp-file containment before writing atomic contents", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open");
    openSpy.mockImplementationOnce(async (file, flags, mode) => {
      await fs.rm(nested, { recursive: true, force: true });
      await fs.symlink(outside, nested);
      return originalOpen(file, flags, mode);
    });

    try {
      await expect(writePluginLocalFolderTextAtomic(root, "nested/page.md", "secret")).rejects.toMatchObject({
        status: 403,
      });
      await expect(fs.readFile(path.join(outside, "page.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("never reads, lists, writes or deletes a Claude sign-in file inside a local folder", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, ".claude", "backups"), { recursive: true });
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    const signInFiles = [
      ".claude/.credentials.json",
      ".claude/credentials.json",
      ".claude/backups/credentials.json",
      "home/.claude.json",
    ];
    for (const filePath of signInFiles) {
      await fs.writeFile(path.join(root, filePath), '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x"}}', "utf8");
    }
    await fs.writeFile(path.join(root, ".claude", "settings.json"), "{}", "utf8");
    await fs.writeFile(path.join(root, "notes.md"), "# Notes\n", "utf8");
    await fs.symlink(path.join(root, ".claude", ".credentials.json"), path.join(root, "linked.json"));

    for (const filePath of [...signInFiles, "linked.json"]) {
      await expect(readPluginLocalFolderText(root, filePath), filePath).rejects.toMatchObject({ status: 403 });
    }
    await expect(readPluginLocalFolderText(root, ".claude/settings.json")).resolves.toBe("{}");
    await expect(readPluginLocalFolderText(root, "notes.md")).resolves.toBe("# Notes\n");

    const listing = await listPluginLocalFolderEntries(root, { recursive: true, maxEntries: 100 });
    const listedPaths = listing.entries.map((entry) => entry.path);
    expect(listedPaths).toEqual(expect.arrayContaining([".claude/settings.json", "notes.md"]));
    for (const filePath of [...signInFiles, "linked.json"]) expect(listedPaths).not.toContain(filePath);

    await expect(writePluginLocalFolderTextAtomic(root, ".claude/.credentials.json", "planted")).rejects.toMatchObject({
      status: 403,
    });
    await expect(fs.readFile(path.join(root, ".claude", ".credentials.json"), "utf8")).resolves.toContain("sk-ant-oat01-x");

    for (const filePath of signInFiles) {
      await expect(deletePluginLocalFolderFile(root, filePath, "content-root"), filePath).rejects.toMatchObject({
        status: 403,
      });
      await expect(fs.stat(path.join(root, filePath)), filePath).resolves.toBeTruthy();
    }
    await deletePluginLocalFolderFile(root, "notes.md", "content-root");
    await expect(fs.stat(path.join(root, "notes.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never reads or lists the sign-in files of the server's CLAUDE_CONFIG_DIR inside a local folder", async () => {
    const root = await makeRoot();
    const configDir = path.join(root, "claude-config");
    await fs.mkdir(configDir);
    await fs.writeFile(path.join(configDir, ".credentials.json"), "{}", "utf8");
    await fs.writeFile(path.join(configDir, "settings.json"), "{}", "utf8");
    await fs.writeFile(path.join(root, "page.md"), "# Page\n", "utf8");
    await fs.symlink(path.join(configDir, ".credentials.json"), path.join(root, "notes.json"));

    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    try {
      for (const filePath of ["claude-config/.credentials.json", "notes.json"]) {
        await expect(readPluginLocalFolderText(root, filePath), filePath).rejects.toMatchObject({ status: 403 });
      }
      await expect(readPluginLocalFolderText(root, "page.md")).resolves.toBe("# Page\n");
      const listing = await listPluginLocalFolderEntries(root, { recursive: true, maxEntries: 100 });
      const listedPaths = listing.entries.map((entry) => entry.path);
      expect(listedPaths).toEqual(expect.arrayContaining(["page.md", "claude-config/settings.json"]));
      expect(listedPaths).not.toContain("claude-config/.credentials.json");
      expect(listedPaths).not.toContain("notes.json");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a Claude config dir, a folder inside one, or a folder that holds one", async () => {
    const root = await makeRoot();
    const configDir = path.join(root, "claude-config");
    await fs.mkdir(path.join(configDir, "wiki"), { recursive: true });
    const namedConfigDir = path.join(root, "other", ".claude");
    await fs.mkdir(namedConfigDir, { recursive: true });
    const plainFolder = path.join(root, "plain");
    await fs.mkdir(plainFolder);

    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    try {
      for (const folder of [configDir, path.join(configDir, "wiki"), root, namedConfigDir]) {
        expect(() => assertPluginLocalFolderOutsideClaudeConfig(folder), folder).toThrow(
          expect.objectContaining({ status: 403 }),
        );
        await preparePluginLocalFolder({
          folderKey: "content-root",
          storedConfig: { path: folder, access: "readWrite", requiredDirectories: ["raw"] },
        });
        const status = await inspectPluginLocalFolder({
          folderKey: "content-root",
          storedConfig: { path: folder, access: "readWrite", requiredDirectories: ["raw"] },
        });
        expect(status.healthy, folder).toBe(false);
        expect(status.readable, folder).toBe(false);
        expect(status.writable, folder).toBe(false);
        expect(status.problems.some((item) => item.code === "not_readable" && item.message.includes("Claude")), folder)
          .toBe(true);
        expect(() => assertConfiguredLocalFolder(status)).toThrow();
        expect(() => assertWritableConfiguredLocalFolder(status)).toThrow();
        // Neither the probe file nor the required directory was written there.
        const names = await fs.readdir(folder);
        expect(names.filter((name) => name === "raw" || name.startsWith(".paperclip-local-folder-probe")), folder)
          .toEqual([]);
      }

      expect(() => assertPluginLocalFolderOutsideClaudeConfig(plainFolder)).not.toThrow();
      const plain = await inspectPluginLocalFolder({
        folderKey: "content-root",
        storedConfig: { path: plainFolder, access: "readWrite" },
      });
      expect(plain.healthy).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
