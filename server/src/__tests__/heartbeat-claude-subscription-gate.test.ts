import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import { setClaudeSubscriptionDeploymentMode } from "../services/claude-subscription-policy.js";
import {
  heartbeatService,
  resolveExecutionRunAdapterConfig,
  runnerClaudeAcpxHasApiKey,
} from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("Paperclip Runner Claude ACPX lane API key", () => {
  it("needs a non-subscription ANTHROPIC_API_KEY in the run env", () => {
    expect(runnerClaudeAcpxHasApiKey({ ANTHROPIC_API_KEY: "sk-ant-api03-x" })).toBe(true);
    expect(runnerClaudeAcpxHasApiKey({})).toBe(false);
    expect(runnerClaudeAcpxHasApiKey({ ANTHROPIC_API_KEY: "  " })).toBe(false);
    expect(runnerClaudeAcpxHasApiKey({ ANTHROPIC_API_KEY: "sk-ant-oat01-subscription" })).toBe(false);
    // Only ANTHROPIC_API_KEY crosses the runner's ACPX allowlist.
    expect(runnerClaudeAcpxHasApiKey({ ANTHROPIC_AUTH_TOKEN: "gateway" })).toBe(false);
    expect(runnerClaudeAcpxHasApiKey({ ANTHROPIC_API_KEY: { type: "secret_ref" } })).toBe(false);
  });
});

describe("stored managed AI connection marker", () => {
  it("drops a managedAiConnection stored in the agent's adapter config", async () => {
    // Only prepareManagedAiRuntime marks a run as a managed AI connection. A
    // stored marker would make claude_local trust the agent's CLAUDE_CONFIG_DIR
    // as the managed credential home and stage it into a sandbox.
    const passConfig = vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({
      config: { ...config },
      secretKeys: new Set<string>(),
      manifest: [],
    }));
    const { resolvedConfig } = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "claude_local",
      executionRunConfig: {
        env: { CLAUDE_CONFIG_DIR: "/home/owner/.claude" },
        managedAiConnection: { provider: "anthropic", method: "api_key", identity: "forged" },
      },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime: passConfig,
        resolveEnvBindings: vi.fn(async () => ({ env: {}, secretKeys: new Set<string>(), manifest: [] })),
      } as any,
    });
    expect(resolvedConfig).not.toHaveProperty("managedAiConnection");
    expect(resolvedConfig.env).toEqual({ CLAUDE_CONFIG_DIR: "/home/owner/.claude" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat Claude subscription lane gates", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-subscription-gate-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "claude-subscription-gate");
    // No host API credential: a claude_local CLI run is on the subscription lane.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    database = await startEmbeddedPostgresTestDatabase("paperclip-claude-subscription-gate-db-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    setClaudeSubscriptionDeploymentMode(null);
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  afterEach(() => {
    unregisterServerAdapter("claude_local");
    registerServerAdapter(originalClaudeAdapter);
  });

  const originalClaudeAdapter = getServerAdapter("claude_local");

  async function fixture(input: { humanUsers: number; env?: Record<string, unknown> }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Subscription gate",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
        name: "Claude",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: { cwd: home, engine: "cli", ...(input.env ? { env: input.env } : {}) },
        runtimeConfig: { heartbeat: { enabled: false } },
      })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Subscription gate task",
        status: "todo",
        assigneeAgentId: agent!.id,
        createdByUserId: userIds[0] ?? null,
      })
      .returning();
    return { companyId, agent: agent!, issue: issue!, ownerUserId: userIds[0] ?? null };
  }

  async function removeCompanyUsers(companyId: string) {
    // Later fixtures count every active human user of the instance.
    await db
      .update(companyMemberships)
      .set({ status: "archived" })
      .where(eq(companyMemberships.companyId, companyId));
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

  it("refuses a subscription-lane run before launch on an authenticated instance with other users", async () => {
    setClaudeSubscriptionDeploymentMode("authenticated");
    const f = await fixture({ humanUsers: 2 });
    const execute = fakeExecute(f.issue.id);
    registerServerAdapter({ ...originalClaudeAdapter, execute });
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.invoke(
        f.agent.id,
        "assignment",
        { issueId: f.issue.id, wakeReason: "issue_assigned" },
        "system",
        { actorType: "user", actorId: f.ownerUserId },
      );
      expect(run).not.toBeNull();
      const finished = await settle(heartbeat, run!.id);
      expect(finished?.status).toBe("failed");
      expect(finished?.errorCode).toBe("configuration_incomplete");
      expect(finished?.error).toContain(CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await removeCompanyUsers(f.companyId);
    }
  });

  it("lets an API-key agent run on an instance with other users", async () => {
    setClaudeSubscriptionDeploymentMode("authenticated");
    const f = await fixture({ humanUsers: 2, env: { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" } });
    const execute = fakeExecute(f.issue.id);
    registerServerAdapter({ ...originalClaudeAdapter, execute });
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.invoke(
        f.agent.id,
        "assignment",
        { issueId: f.issue.id, wakeReason: "issue_assigned" },
        "system",
        { actorType: "user", actorId: f.ownerUserId },
      );
      const finished = await settle(heartbeat, run!.id);
      expect(finished?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await removeCompanyUsers(f.companyId);
    }
  });

  it("runs the owner's own subscription-lane assignment, and refuses a plugin-started one", async () => {
    setClaudeSubscriptionDeploymentMode("authenticated");
    const f = await fixture({ humanUsers: 1 });
    const execute = fakeExecute(f.issue.id);
    registerServerAdapter({ ...originalClaudeAdapter, execute });
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

      const ownerRun = await heartbeat.invoke(
        f.agent.id,
        "assignment",
        { issueId: f.issue.id, wakeReason: "issue_assigned" },
        "system",
        { actorType: "user", actorId: f.ownerUserId },
      );
      const finished = await settle(heartbeat, ownerRun!.id);
      expect(finished?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.agentId, f.agent.id));
      await removeCompanyUsers(f.companyId);
    }
  });
});
