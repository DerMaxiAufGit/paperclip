import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Claude quota path may only run the `claude` binary and parse its output.
// It must never read the Claude sign-in (files under the Claude config dir or
// the macOS Keychain) and never call an Anthropic endpoint itself. Every
// filesystem API and `fetch` below fails the test if the quota path touches it.
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

const USAGE_PANEL = `
  Settings:  Status   Config   Usage
  Current session
  2% used
  Resets 5pm (America/Chicago)

  Current week (all models)
  47% used
  Resets Mar 18 at 7:59am (America/Chicago)
`;

type ExecCall = [file: string, args: string[], options: { env?: Record<string, string | undefined> }];

function authStatusJson(status: Record<string, unknown>): string {
  return JSON.stringify(status);
}

function mockCli(handlers: {
  authStatus: () => Promise<{ stdout: string; stderr: string }>;
  usage?: () => Promise<{ stdout: string; stderr: string }>;
}) {
  mocks.exec.mockImplementation(async (file: string, args: string[]) => {
    if (file === "claude" && args[0] === "auth" && args[1] === "status") return handlers.authStatus();
    if (file === "sh" && handlers.usage) return handlers.usage();
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
}

function execCalls(): ExecCall[] {
  return mocks.exec.mock.calls as ExecCall[];
}

function expectOnlyClaudeBinaryWasRun() {
  for (const [file, args] of execCalls()) {
    if (file === "claude") {
      expect(args).toEqual(["auth", "status"]);
      continue;
    }
    expect(file).toBe("sh");
    const command = args[1] ?? "";
    expect(command).toContain("claude");
    expect(command).toContain("/usage");
    expect(command).not.toMatch(/credentials|security|keychain|\.claude/i);
  }
}

beforeEach(() => {
  mocks.fetch.mockImplementation(() => {
    throw new Error("Claude quota path must not call fetch");
  });
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
  vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", "");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/home/paperclip/.claude");
});

afterEach(() => {
  mocks.exec.mockReset();
  mocks.fetch.mockReset();
  mocks.fsTouches.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("claude_local quota", () => {
  it("reads quota only from the claude CLI /usage panel, without touching the Claude config dir", async () => {
    mockCli({
      authStatus: async () => ({
        stdout: authStatusJson({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
        stderr: "",
      }),
      usage: async () => ({ stdout: USAGE_PANEL, stderr: "" }),
    });

    const result = await getQuotaWindows();

    expect(result).toMatchObject({ provider: "anthropic", source: "claude-cli", ok: true });
    expect(result.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Current session", 2],
      ["Current week (all models)", 47],
    ]);
    expect(mocks.fsTouches).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(execCalls().map(([file]) => file)).toEqual(["claude", "sh"]);
    expectOnlyClaudeBinaryWasRun();
  });

  it("runs both claude commands without ANTHROPIC_* env so the CLI uses its own sign-in", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-fixture");
    mockCli({
      authStatus: async () => ({
        stdout: authStatusJson({ loggedIn: true, authMethod: "claude.ai" }),
        stderr: "",
      }),
      usage: async () => ({ stdout: USAGE_PANEL, stderr: "" }),
    });

    const result = await getQuotaWindows();

    expect(result.ok).toBe(true);
    expect(execCalls()).toHaveLength(2);
    for (const [, , options] of execCalls()) {
      expect(options.env).toBeDefined();
      expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    }
  });

  it("shows no quota and no error when the CLI reports it is signed out", async () => {
    mockCli({
      // `claude auth status` exits non-zero when signed out but still prints JSON.
      authStatus: async () => {
        throw Object.assign(new Error("Command failed: claude auth status"), {
          code: 1,
          stdout: authStatusJson({ loggedIn: false }),
          stderr: "",
        });
      },
    });

    const result = await getQuotaWindows();

    expect(result).toEqual({ provider: "anthropic", source: "claude-cli", ok: true, windows: [] });
    expect(execCalls().map(([file]) => file)).toEqual(["claude"]);
    expect(mocks.fsTouches).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("shows no quota and no error when the CLI uses API-key auth", async () => {
    mockCli({
      authStatus: async () => ({
        stdout: authStatusJson({ loggedIn: true, authMethod: "api_key" }),
        stderr: "",
      }),
    });

    const result = await getQuotaWindows();

    expect(result).toEqual({ provider: "anthropic", source: "claude-cli", ok: true, windows: [] });
    expect(execCalls().map(([file]) => file)).toEqual(["claude"]);
  });

  it("shows no quota and no error when the claude binary is not installed", async () => {
    mockCli({
      authStatus: async () => {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      },
    });

    const result = await getQuotaWindows();

    expect(result).toEqual({ provider: "anthropic", source: "claude-cli", ok: true, windows: [] });
    expect(execCalls().map(([file]) => file)).toEqual(["claude"]);
    expect(mocks.fsTouches).toEqual([]);
  });

  it("still probes /usage when auth status is unreadable", async () => {
    mockCli({
      authStatus: async () => ({ stdout: "not json", stderr: "" }),
      usage: async () => ({ stdout: USAGE_PANEL, stderr: "" }),
    });

    const result = await getQuotaWindows();

    expect(result).toMatchObject({ source: "claude-cli", ok: true });
    expect(result.windows).toHaveLength(2);
    expect(mocks.fsTouches).toEqual([]);
  });

  it("reports a CLI /usage failure for a claude.ai sign-in without falling back to the sign-in files", async () => {
    mockCli({
      authStatus: async () => ({
        stdout: authStatusJson({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
        stderr: "",
      }),
      usage: async () => {
        throw Object.assign(new Error("Command failed"), { stdout: "Failed to load usage data", stderr: "" });
      },
    });

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.source).toBe("claude-cli");
    expect(result.error).toBe(
      "Claude is logged in via claude.ai (max), but quota polling failed "
        + "(Claude CLI /usage: Claude CLI could not load usage data. Open the CLI and retry `/usage`.)",
    );
    expect(mocks.fsTouches).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expectOnlyClaudeBinaryWasRun();
  });

  it("returns no quota for Bedrock without running anything", async () => {
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");

    const result = await getQuotaWindows();

    expect(result).toEqual({ provider: "anthropic", source: "bedrock", ok: true, windows: [] });
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("reports a missing claude binary from probeClaudeCliAuth, and the status when it is installed", async () => {
    mockCli({
      authStatus: async () => {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(quota.probeClaudeCliAuth()).resolves.toEqual({ status: null, binaryMissing: true });

    mockCli({
      authStatus: async () => ({
        stdout: authStatusJson({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
        stderr: "",
      }),
    });
    await expect(quota.probeClaudeCliAuth()).resolves.toEqual({
      status: { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" },
      binaryMissing: false,
    });
    expectOnlyClaudeBinaryWasRun();
    expect(mocks.fsTouches).toEqual([]);
  });

  it("does not expose any sign-in reader or direct Anthropic usage call", () => {
    expect(quota).not.toHaveProperty("readClaudeToken");
    expect(quota).not.toHaveProperty("readIsolatedClaudeKeychainToken");
    expect(quota).not.toHaveProperty("fetchClaudeQuota");
    expect(quota).not.toHaveProperty("fetchWithTimeout");
  });
});
