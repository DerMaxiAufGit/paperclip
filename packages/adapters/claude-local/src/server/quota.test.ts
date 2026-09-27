import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Paperclip shows no Claude subscription quota. `getQuotaWindows` must not run
// any command, read any file, or call any endpoint. The only command left is
// `claude auth status` for the sign-in panel, and it never reads the Claude
// sign-in itself. Every filesystem API and `fetch` below fails the test if
// touched.
const mocks = vi.hoisted(() => {
  const fsTouches: string[] = [];
  const fsExportNames = [
    "readFile",
    "readFileSync",
    "readdir",
    "readdirSync",
    "stat",
    "statSync",
    "lstat",
    "lstatSync",
    "access",
    "accessSync",
    "open",
    "openSync",
    "existsSync",
    "createReadStream",
    "watch",
  ];
  function fsTrap(moduleName: string) {
    const trap = new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        return (...args: unknown[]) => {
          fsTouches.push(`${moduleName}.${prop}(${String(args[0])})`);
          throw new Error(`Claude quota path touched ${moduleName}.${prop}`);
        };
      },
    });
    return { default: trap, ...Object.fromEntries(fsExportNames.map((name) => [name, trap[name]])) };
  }
  return { exec: vi.fn(), fetch: vi.fn(), fsTouches, fsTrap };
});

vi.mock("node:fs", () => mocks.fsTrap("node:fs"));
vi.mock("node:fs/promises", () => mocks.fsTrap("node:fs/promises"));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.exec }),
}));

import * as quota from "./quota.js";
import { getQuotaWindows } from "./quota.js";

type ExecCall = [file: string, args: string[], options: { env?: Record<string, string | undefined> }];

function execCalls(): ExecCall[] {
  return mocks.exec.mock.calls as ExecCall[];
}

beforeEach(() => {
  mocks.fetch.mockImplementation(() => {
    throw new Error("Claude quota path must not call fetch");
  });
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.exec.mockImplementation(async (file: string, args: string[]) => {
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
});

afterEach(() => {
  mocks.exec.mockReset();
  mocks.fetch.mockReset();
  mocks.fsTouches.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("claude_local quota", () => {
  it("returns ok with no windows, without running, reading or fetching anything", async () => {
    const result = await getQuotaWindows();

    expect(result).toEqual({ provider: "anthropic", ok: true, windows: [] });
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.fsTouches).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns the same empty result for Bedrock and API-key hosts", async () => {
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-fixture");

    await expect(getQuotaWindows()).resolves.toEqual({ provider: "anthropic", ok: true, windows: [] });
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("does not expose the /usage scrape, a sign-in reader, or a direct Anthropic usage call", () => {
    for (const name of [
      "fetchClaudeCliQuota",
      "captureClaudeCliUsageText",
      "parseClaudeCliUsageText",
      "buildClaudeCliShellProbeCommand",
      "readClaudeToken",
      "readIsolatedClaudeKeychainToken",
      "fetchClaudeQuota",
      "fetchWithTimeout",
    ]) {
      expect(quota).not.toHaveProperty(name);
    }
  });
});

describe("claude auth status probe", () => {
  it("reports a missing claude binary, and the status when it is installed", async () => {
    mocks.exec.mockImplementation(async () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    });
    await expect(quota.probeClaudeCliAuth()).resolves.toEqual({ status: null, binaryMissing: true });

    mocks.exec.mockImplementation(async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      stderr: "",
    }));
    await expect(quota.probeClaudeCliAuth()).resolves.toEqual({
      status: { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" },
      binaryMissing: false,
    });

    for (const [file, args] of execCalls()) {
      expect(file).toBe("claude");
      expect(args).toEqual(["auth", "status"]);
    }
    expect(mocks.fsTouches).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reads the signed-out status that claude prints before exiting non-zero", async () => {
    mocks.exec.mockImplementation(async () => {
      throw Object.assign(new Error("Command failed: claude auth status"), {
        code: 1,
        stdout: JSON.stringify({ loggedIn: false }),
        stderr: "",
      });
    });

    await expect(quota.readClaudeAuthStatus()).resolves.toEqual({
      loggedIn: false,
      authMethod: null,
      subscriptionType: null,
    });
  });

  it("never passes a Claude subscription token to claude auth status", async () => {
    mocks.exec.mockImplementation(async () => ({ stdout: JSON.stringify({ loggedIn: true }), stderr: "" }));

    await quota.probeClaudeCliAuth({
      env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fixture" },
    });

    const [, , options] = execCalls()[0]!;
    expect(options.env).toEqual({ PATH: "/usr/bin" });
  });
});
