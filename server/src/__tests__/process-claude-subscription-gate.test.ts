import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE,
  CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE,
} from "@paperclipai/shared";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { execute as executeProcess } from "../adapters/process/execute.js";
import { setClaudeSubscriptionDeploymentMode } from "../services/claude-subscription-policy.js";
import { claudeSubscriptionGateInput, isProcessClaudeCommand } from "../services/claude-subscription-target.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("isProcessClaudeCommand", () => {
  it("matches a command whose basename is claude, on any path", () => {
    expect(isProcessClaudeCommand({ command: "claude" })).toBe(true);
    expect(isProcessClaudeCommand({ command: " claude " })).toBe(true);
    expect(isProcessClaudeCommand({ command: "/usr/local/bin/claude", args: ["-p", "hi"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd" })).toBe(true);
    expect(isProcessClaudeCommand({ command: "claude.exe" })).toBe(true);
    expect(isProcessClaudeCommand({ command: "CLAUDE" })).toBe(true);
  });

  it("matches package runners and env that start claude directly", () => {
    expect(isProcessClaudeCommand({ command: "npx", args: ["-y", "@anthropic-ai/claude-code", "-p", "hi"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "npx", args: ["@anthropic-ai/claude-code@2.1.0", "-p"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "npx", args: ["--package=@anthropic-ai/claude-code", "claude"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "bunx", args: ["claude", "-p", "hi"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "pnpm", args: ["dlx", "@anthropic-ai/claude-code", "-p"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "npm", args: ["exec", "--yes", "claude", "--", "-p"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "env", args: ["FOO=bar", "claude", "-p", "hi"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "/usr/bin/env", args: ["-i", "/opt/claude/bin/claude"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "env", args: ["npx", "-y", "@anthropic-ai/claude-code"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "env", args: ["-S", "FOO=bar claude -p"] })).toBe(true);
    expect(isProcessClaudeCommand({ command: "yarn", args: ["claude", "-p"] })).toBe(true);
    expect(
      isProcessClaudeCommand({ command: "node", args: ["/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "-p"] }),
    ).toBe(true);
  });

  it("does not match other commands", () => {
    expect(isProcessClaudeCommand({ command: "echo", args: ["claude"] })).toBe(false);
    expect(isProcessClaudeCommand({ command: "claude-helper" })).toBe(false);
    expect(isProcessClaudeCommand({ command: "npx", args: ["eslint", "src"] })).toBe(false);
    expect(isProcessClaudeCommand({ command: "npx", args: ["tsx", "run.ts", "--", "claude"] })).toBe(false);
    expect(isProcessClaudeCommand({ command: "pnpm", args: ["test"] })).toBe(false);
    expect(isProcessClaudeCommand({ command: "node", args: ["server.js"] })).toBe(false);
    expect(isProcessClaudeCommand({ command: "env", args: ["FOO=bar", "node", "claude.js"] })).toBe(false);
    expect(isProcessClaudeCommand({ command: "" })).toBe(false);
    expect(isProcessClaudeCommand({})).toBe(false);
  });
});

describe("claudeSubscriptionGateInput", () => {
  it("passes a claude_local config through and ignores other adapters", () => {
    const config = { engine: "cli", env: { FOO: "bar" } };
    expect(claudeSubscriptionGateInput("claude_local", config)).toEqual({ config });
    expect(claudeSubscriptionGateInput("codex_local", config)).toBeNull();
    expect(claudeSubscriptionGateInput("process", { command: "echo" })).toBeNull();
  });

  it("classifies a process claude command as a claude CLI run, whatever its engine key says", () => {
    const gate = claudeSubscriptionGateInput("process", {
      command: "claude",
      args: ["-p", "hi"],
      engine: "acp",
      env: { FOO: "bar" },
    });
    expect(gate).toEqual({ config: { env: { FOO: "bar" }, args: ["-p", "hi"] } });
  });

  it("counts env wrapper assignments, and ignores the host env when env may clear it", () => {
    expect(
      claudeSubscriptionGateInput("process", {
        command: "env",
        args: ["ANTHROPIC_BASE_URL=https://evil.example", "claude", "-p"],
        env: { FOO: "bar" },
      }),
    ).toEqual({ config: { env: { FOO: "bar", ANTHROPIC_BASE_URL: "https://evil.example" }, args: ["-p"] } });
    expect(
      claudeSubscriptionGateInput("process", { command: "env", args: ["-u", "ANTHROPIC_API_KEY", "claude"] }),
    ).toEqual({ config: { env: {}, args: [] }, hostEnv: {} });
  });
});

describe("process adapter running claude", () => {
  let root: string;
  let claudePath: string;
  let markerPath: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-claude-"));
    claudePath = path.join(root, "claude");
    markerPath = path.join(root, "spawned");
    await writeFile(claudePath, `#!/bin/sh\ntouch "${markerPath}"\n`);
    await chmod(claudePath, 0o755);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(markerPath, { force: true });
  });

  async function spawned() {
    return access(markerPath).then(
      () => true,
      () => false,
    );
  }

  function run(config: Record<string, unknown>) {
    return executeProcess({
      runId: `run-${randomUUID()}`,
      agent: { id: "agent-1", companyId: "co-1", name: "Process", adapterType: "process", adapterConfig: config },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config,
      context: {},
      onLog: async () => {},
    });
  }

  it("refuses a subscription-lane claude command whose env points it away from api.anthropic.com, before spawning", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    const result = await run({ command: claudePath, cwd: root, env: { ANTHROPIC_BASE_URL: "https://evil.example" } });
    expect(result.errorCode).toBe("adapter_engine_unavailable");
    expect(result.errorMessage).toContain("only sent to api.anthropic.com");
    expect(result.errorMessage).toContain("ANTHROPIC_BASE_URL");
    expect(await spawned()).toBe(false);
  });

  it("refuses an endpoint set through an env wrapper", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    const result = await run({
      command: "env",
      args: ["ANTHROPIC_BASE_URL=https://evil.example", claudePath],
      cwd: root,
    });
    expect(result.errorCode).toBe("adapter_engine_unavailable");
    expect(await spawned()).toBe(false);
  });

  it("runs a claude command with an API key, custom endpoint included", async () => {
    const result = await run({
      command: claudePath,
      cwd: root,
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-fixture", ANTHROPIC_BASE_URL: "https://gateway.example" },
    });
    expect(result.errorCode).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(await spawned()).toBe(true);
  });

  it("runs a subscription-lane claude command without endpoint overrides", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    const result = await run({ command: claudePath, cwd: root, env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } });
    expect(result.exitCode).toBe(0);
    expect(await spawned()).toBe(true);
  });

  it("leaves other commands alone", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const result = await run({
      command: "sh",
      args: ["-c", `touch "${markerPath}"`],
      cwd: root,
      env: { ANTHROPIC_BASE_URL: "https://evil.example" },
    });
    expect(result.exitCode).toBe(0);
    expect(await spawned()).toBe(true);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat Claude subscription gates for process agents that run claude", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const originalProcessAdapter = getServerAdapter("process");

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-claude-gate-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "process-claude-gate");
    // No host API credential: a process agent that runs claude is on the subscription lane.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    database = await startEmbeddedPostgresTestDatabase("paperclip-process-claude-gate-db-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    setClaudeSubscriptionDeploymentMode(null);
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  afterEach(() => {
    unregisterServerAdapter("process");
    registerServerAdapter(originalProcessAdapter);
  });

  async function fixture(input: { humanUsers: number; adapterConfig: Record<string, unknown> }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Process Claude gate",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const now = new Date();
    const userIds: string[] = [];
    for (let index = 0; index < input.humanUsers; index += 1) {
      const userId = `user-${companyId}-${index}`;
      userIds.push(userId);
      await db.insert(authUsers).values({
        id: userId,
        name: userId,
        email: `${userId}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: index === 0 ? "owner" : "operator",
      });
    }
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Process",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { cwd: home, ...input.adapterConfig },
        runtimeConfig: { heartbeat: { enabled: false } },
      })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Process Claude gate task",
        status: "todo",
        assigneeAgentId: agent!.id,
        createdByUserId: userIds[0] ?? null,
      })
      .returning();
    return { companyId, agent: agent!, issue: issue!, ownerUserId: userIds[0] ?? null };
  }

  async function cleanup(heartbeat: ReturnType<typeof heartbeatService>, f: { companyId: string; agent: { id: string } }) {
    await heartbeat.drainActiveRunExecutions();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.agentId, f.agent.id));
    // Later fixtures count every active human user of the instance.
    await db
      .update(companyMemberships)
      .set({ status: "archived" })
      .where(eq(companyMemberships.companyId, f.companyId));
  }

  function fakeExecute(issueId: string) {
    return vi.fn(async () => {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
    });
  }

  async function settle(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
    await expect
      .poll(async () => (await heartbeat.getRun(runId))?.status, { timeout: 20_000 })
      .toMatch(/^(succeeded|failed)$/);
    return heartbeat.getRun(runId);
  }

  async function assignAsOwner(
    heartbeat: ReturnType<typeof heartbeatService>,
    f: { agent: { id: string }; issue: { id: string }; ownerUserId: string | null },
  ) {
    const run = await heartbeat.invoke(
      f.agent.id,
      "assignment",
      { issueId: f.issue.id, wakeReason: "issue_assigned" },
      "system",
      { actorType: "user", actorId: f.ownerUserId },
    );
    expect(run).not.toBeNull();
    return settle(heartbeat, run!.id);
  }

  it.each([
    ["claude", { command: "claude", args: ["-p", "hi"] }],
    ["claude with engine=acp", { command: "claude", args: ["-p", "hi"], engine: "acp" }],
    ["npx @anthropic-ai/claude-code", { command: "npx", args: ["-y", "@anthropic-ai/claude-code", "-p", "hi"] }],
  ])("refuses a process agent running %s on an authenticated instance with other users", async (_label, adapterConfig) => {
    setClaudeSubscriptionDeploymentMode("authenticated");
    const f = await fixture({ humanUsers: 2, adapterConfig });
    const execute = fakeExecute(f.issue.id);
    registerServerAdapter({ ...originalProcessAdapter, execute });
    const heartbeat = heartbeatService(db);
    try {
      const finished = await assignAsOwner(heartbeat, f);
      expect(finished?.status).toBe("failed");
      expect(finished?.errorCode).toBe("configuration_incomplete");
      expect(finished?.error).toContain(CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await cleanup(heartbeat, f);
    }
  });

  it("lets a process agent run claude with an API key on an instance with other users", async () => {
    setClaudeSubscriptionDeploymentMode("authenticated");
    const f = await fixture({
      humanUsers: 2,
      adapterConfig: { command: "claude", args: ["-p", "hi"], env: { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" } },
    });
    const execute = fakeExecute(f.issue.id);
    registerServerAdapter({ ...originalProcessAdapter, execute });
    const heartbeat = heartbeatService(db);
    try {
      const finished = await assignAsOwner(heartbeat, f);
      expect(finished?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup(heartbeat, f);
    }
  });

  it("leaves a process agent running another command alone on an instance with other users", async () => {
    setClaudeSubscriptionDeploymentMode("authenticated");
    const f = await fixture({ humanUsers: 2, adapterConfig: { command: "echo", args: ["claude"] } });
    const execute = fakeExecute(f.issue.id);
    registerServerAdapter({ ...originalProcessAdapter, execute });
    const heartbeat = heartbeatService(db);
    try {
      const finished = await assignAsOwner(heartbeat, f);
      expect(finished?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup(heartbeat, f);
    }
  });

  it("runs the owner's own assignment for a process agent running claude, and refuses a plugin-started one", async () => {
    setClaudeSubscriptionDeploymentMode("authenticated");
    const f = await fixture({ humanUsers: 1, adapterConfig: { command: "claude", args: ["-p", "hi"] } });
    const execute = fakeExecute(f.issue.id);
    registerServerAdapter({ ...originalProcessAdapter, execute });
    const heartbeat = heartbeatService(db);
    try {
      const pluginRun = await heartbeat.wakeup(f.agent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "plugin said so",
        payload: { prompt: "do it" },
        contextSnapshot: {
          wakeReason: "plugin said so",
          paperclipAgentMessage: { text: "do it", source: "plugin_invoke", pluginKey: "acme" },
        },
        requestedByActorType: "system",
        requestedByActorId: randomUUID(),
      });
      expect(pluginRun).not.toBeNull();
      const refused = await settle(heartbeat, pluginRun!.id);
      expect(refused?.status).toBe("failed");
      expect(refused?.errorCode).toBe("configuration_incomplete");
      expect(refused?.error).toContain(CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE);
      expect(execute).not.toHaveBeenCalled();

      const finished = await assignAsOwner(heartbeat, f);
      expect(finished?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup(heartbeat, f);
    }
  });
});
