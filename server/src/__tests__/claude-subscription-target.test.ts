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
  environments,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE } from "@paperclipai/shared";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { setClaudeSubscriptionDeploymentMode } from "../services/claude-subscription-policy.js";
import { claudeSubscriptionTargetIsRemote } from "../services/claude-subscription-target.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("claudeSubscriptionTargetIsRemote", () => {
  it("is true only for drivers that give claude_local a remote execution target", () => {
    expect(claudeSubscriptionTargetIsRemote("ssh", "claude_local")).toBe(true);
    expect(claudeSubscriptionTargetIsRemote("sandbox", "claude_local")).toBe(true);
    expect(claudeSubscriptionTargetIsRemote("local", "claude_local")).toBe(false);
    expect(claudeSubscriptionTargetIsRemote(null, "claude_local")).toBe(false);
    expect(claudeSubscriptionTargetIsRemote(undefined, "claude_local")).toBe(false);
  });

  it("counts every other driver as local, since the run then executes on this server", () => {
    // resolveEnvironmentExecutionTarget returns no target for these, and the
    // heartbeat runs the adapter locally.
    expect(claudeSubscriptionTargetIsRemote("plugin", "claude_local")).toBe(false);
    expect(claudeSubscriptionTargetIsRemote("kubernetes", "claude_local")).toBe(false);
    expect(claudeSubscriptionTargetIsRemote("", "claude_local")).toBe(false);
    // An adapter without remote managed environment support gets no remote
    // target even on an SSH or sandbox environment.
    expect(claudeSubscriptionTargetIsRemote("ssh", "process")).toBe(false);
    expect(claudeSubscriptionTargetIsRemote("sandbox", "http")).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat Claude subscription gates on non-remote environment drivers", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const originalClaudeAdapter = getServerAdapter("claude_local");

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-subscription-target-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "claude-subscription-target");
    // No host API credential: a claude_local CLI run is on the subscription lane.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    database = await startEmbeddedPostgresTestDatabase("paperclip-claude-subscription-target-db-");
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

  it("refuses a subscription-lane run on a plugin-driver environment, which runs on this server", async () => {
    setClaudeSubscriptionDeploymentMode("authenticated");
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Subscription target",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // Two human users: the owner-only gate refuses the subscription lane.
    const now = new Date();
    const userIds = [`owner-${companyId}`, `teammate-${companyId}`];
    for (const [index, userId] of userIds.entries()) {
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
    const [environment] = await db
      .insert(environments)
      .values({
        name: `Plugin environment ${companyId}`,
        driver: "plugin",
        config: { pluginKey: "acme.environments", driverKey: "acme-box", driverConfig: {} },
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Claude",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: { cwd: home, engine: "cli" },
        runtimeConfig: { heartbeat: { enabled: false } },
        defaultEnvironmentId: environment!.id,
      })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Plugin environment task",
        status: "todo",
        assigneeAgentId: agent!.id,
        createdByUserId: userIds[0],
      })
      .returning();
    const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, resultJson: {} }));
    registerServerAdapter({ ...originalClaudeAdapter, execute });
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.invoke(
        agent!.id,
        "assignment",
        { issueId: issue!.id, wakeReason: "issue_assigned" },
        "system",
        { actorType: "user", actorId: userIds[0] },
      );
      expect(run).not.toBeNull();
      await expect
        .poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 })
        .toMatch(/^(succeeded|failed)$/);
      const finished = await heartbeat.getRun(run!.id);
      expect(finished?.status).toBe("failed");
      expect(finished?.errorCode).toBe("configuration_incomplete");
      expect(finished?.error).toContain(CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.agentId, agent!.id));
      await db
        .update(companyMemberships)
        .set({ status: "archived" })
        .where(eq(companyMemberships.companyId, companyId));
    }
  });
});
