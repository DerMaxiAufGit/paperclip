import express from "express";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

// Only `spawn` is replaced: the claude-local endpoint check the route imports
// pulls in modules that use the rest of node:child_process.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));

// assertBoard stays real: the route must refuse non-board actors itself.
vi.mock("../routes/authz.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routes/authz.js")>()),
  getActorInfo: () => ({ actorId: "user-1", agentId: null, runId: null }),
  assertCompanyAccess: () => {},
}));

const boardActor = { type: "board", userId: "local-board", source: "local_implicit" };

// Env that moves the claude CLI off the owner's sign-in or away from
// api.anthropic.com. Cleared so the spawn tests do not depend on the machine
// that runs them; a test sets what it needs.
const CLAUDE_ROUTING_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_API_BASE_URL",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "LD_PRELOAD",
  "LD_AUDIT",
  "BUN_OPTIONS",
];

const TEST_INSTANCE_ID = "board-chat-test";
let paperclipHome: string;

beforeEach(() => {
  paperclipHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-board-chat-home-"));
  vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", TEST_INSTANCE_ID);
  for (const key of CLAUDE_ROUTING_ENV_KEYS) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(paperclipHome, { recursive: true, force: true });
});

function makeFakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

function mockStandingIssue() {
  mockIssueService.list.mockResolvedValue([
    { id: "issue-1", title: "Board Operations", status: "todo" },
  ]);
  mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
  mockIssueService.listComments.mockResolvedValue([]);
}

async function createApp(
  deploymentMode: "local_trusted" | "authenticated" = "local_trusted",
  actor: Record<string, unknown> = boardActor,
) {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const { errorHandler } = await import("../middleware/error-handler.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", boardChatRoutes({} as any, { deploymentMode }));
  app.use(errorHandler);
  return app;
}

describe("POST /api/board/chat/stream feature flag guard (PAP-137)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 FEATURE_DISABLED when enableConferenceRoomChat is off", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: false });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Conference Room Chat is not enabled",
      code: "FEATURE_DISABLED",
    });
    // The guard must fire before anything is persisted.
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 403 DEPLOYMENT_MODE_UNSUPPORTED outside local_trusted even with the flag on", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp("authenticated");

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DEPLOYMENT_MODE_UNSUPPORTED");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("lets requests past the guard when the flag is on (400 on missing body, not 403)", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp();

    // Omit the body so the request stops at validation — proves the guard
    // admitted it without spawning the chat subprocess.
    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "companyId and message are required" });
  });

  it("refuses an agent key before spawning claude on the server's own sign-in", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([
      { id: "issue-1", title: "Board Operations", status: "todo" },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.listComments.mockResolvedValue([]);
    const app = await createApp("local_trusted", {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});

describe("board-chat client disconnect", () => {
  it("kills the spawned subprocess when the client disconnects mid-stream", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockStandingIssue();
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc);
    const app = await createApp();

    const req = request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });
    // Start the request without awaiting the (never-ending) SSE response.
    const pending = req.then(
      () => undefined,
      () => undefined,
    );

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    expect(fakeProc.kill).not.toHaveBeenCalled();

    // Client walks away mid-stream.
    req.abort();
    await vi.waitFor(() => expect(fakeProc.kill).toHaveBeenCalledWith("SIGTERM"));

    // Let the subprocess close handler run so the slot is released.
    fakeProc.exitCode = 143;
    fakeProc.emit("close", 143);
    await pending;
  });
});

describe("board-chat claude CLI isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockStandingIssue();
  });

  function startChat(app: express.Express) {
    const req = request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });
    return req.then(
      (res) => res,
      () => undefined,
    );
  }

  it("runs claude in a private per-request dir under the instance root, with user settings only and no MCP servers, and removes the dir afterwards", async () => {
    const fakeProc = makeFakeProc();
    let cwdAtSpawn: { isDirectory: boolean; mode: number; entries: string[] } | null = null;
    mockSpawn.mockImplementation((_command: string, _args: string[], options: { cwd: string }) => {
      const stat = fs.statSync(options.cwd);
      cwdAtSpawn = {
        isDirectory: stat.isDirectory(),
        mode: stat.mode & 0o777,
        entries: fs.readdirSync(options.cwd),
      };
      return fakeProc;
    });
    const app = await createApp();

    const pending = startChat(app);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    const [command, args, options] = mockSpawn.mock.calls[0]!;
    expect(command).toBe("claude");
    // A shared dir such as /tmp lets any OS user plant .claude/settings.json,
    // .mcp.json or CLAUDE.md for a CLI that runs on the owner's sign-in.
    const instanceRoot = path.join(paperclipHome, "instances", TEST_INSTANCE_ID);
    const relativeToInstance = path.relative(instanceRoot, options.cwd);
    expect(options.cwd).not.toBe("/tmp");
    expect(relativeToInstance).not.toBe("");
    expect(relativeToInstance.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relativeToInstance)).toBe(false);
    expect(cwdAtSpawn).toEqual({ isDirectory: true, mode: 0o700, entries: [] });
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    expect(args).toContain("--strict-mcp-config");
    expect(options.env.PAPERCLIP_COMPANY_ID).toBe("company-1");

    fakeProc.exitCode = 0;
    fakeProc.emit("close", 0);
    await vi.waitFor(() => expect(fs.existsSync(options.cwd)).toBe(false));
    const res = await pending;
    expect(res?.status).toBe(200);
  });

  it("gives each request its own dir and removes it when claude cannot start", async () => {
    const procs = [makeFakeProc(), makeFakeProc()];
    mockSpawn.mockReturnValueOnce(procs[0]).mockReturnValueOnce(procs[1]);
    const app = await createApp();

    const first = startChat(app);
    const second = startChat(app);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    const firstCwd = mockSpawn.mock.calls[0]![2].cwd as string;
    const secondCwd = mockSpawn.mock.calls[1]![2].cwd as string;
    expect(firstCwd).not.toBe(secondCwd);

    const spawnError = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    procs[0].emit("error", spawnError);
    procs[1].emit("error", spawnError);
    await vi.waitFor(() => {
      expect(fs.existsSync(firstCwd)).toBe(false);
      expect(fs.existsSync(secondCwd)).toBe(false);
    });
    await Promise.all([first, second]);
    consoleError.mockRestore();
  });

  it("refuses before spawning when the server env would send the owner's sign-in away from api.anthropic.com", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.test");
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CLAUDE_SUBSCRIPTION_ENDPOINT_REFUSED");
    expect(res.body.error).toContain("api.anthropic.com");
    expect(res.body.error).toContain("ANTHROPIC_BASE_URL");
    expect(res.body.error).toContain("Paperclip server env");
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("refuses before spawning when the server env lets another program read the claude CLI's requests", async () => {
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/etc/ssl/proxy-ca.pem");
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CLAUDE_SUBSCRIPTION_ENDPOINT_REFUSED");
    expect(res.body.error).toContain("NODE_EXTRA_CA_CERTS");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("keeps a custom endpoint when the server env bills an Anthropic API key", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-test");
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc);
    const app = await createApp();

    const pending = startChat(app);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    expect(mockSpawn.mock.calls[0]![2].env.ANTHROPIC_BASE_URL).toBe("https://proxy.example.test");

    fakeProc.exitCode = 0;
    fakeProc.emit("close", 0);
    const res = await pending;
    expect(res?.status).toBe(200);
  });
});

describe("board-chat history role classification", () => {
  it("treats only board-concierge comments as assistant turns", async () => {
    const { isConciergeReply } = await import("../routes/board-chat.js");

    // The relay's own persisted replies.
    expect(
      isConciergeReply({ authorAgentId: null, authorUserId: "board-concierge" }),
    ).toBe(true);

    // A human board user.
    expect(isConciergeReply({ authorAgentId: null, authorUserId: "user-1" })).toBe(
      false,
    );

    // An agent commenting on the standing issue is NOT this assistant — its
    // words must not be serialized as the assistant's own prior turns.
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: null }),
    ).toBe(false);

    // Defensive: an agent comment can never impersonate the concierge even if
    // both author fields are somehow set.
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: "board-concierge" }),
    ).toBe(false);
  });
});
