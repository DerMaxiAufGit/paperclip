import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  chatExternalPrincipals,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issues,
  plugins,
  routineRuns,
  routines,
  type Db,
} from "@paperclipai/db";
import {
  CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE,
  CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE,
} from "@paperclipai/shared";
import {
  countActiveHumanUsers,
  resolveClaudeSubscriptionDeploymentMode,
  resolveClaudeSubscriptionEligibility,
  resolveClaudeSubscriptionTriggerViolation,
  setClaudeSubscriptionDeploymentMode,
} from "../services/claude-subscription-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

afterEach(() => {
  setClaudeSubscriptionDeploymentMode(null);
});

describe("Claude subscription deployment mode", () => {
  it("uses the registered deployment mode", () => {
    setClaudeSubscriptionDeploymentMode("authenticated");
    expect(resolveClaudeSubscriptionDeploymentMode()).toBe("authenticated");
    setClaudeSubscriptionDeploymentMode("local_trusted");
    expect(resolveClaudeSubscriptionDeploymentMode()).toBe("local_trusted");
  });

  it("allows local_trusted without reading any user", async () => {
    const db = {
      select: () => {
        throw new Error("local_trusted must not count users");
      },
    } as unknown as Db;
    await expect(
      resolveClaudeSubscriptionEligibility(db, { deploymentMode: "local_trusted" }),
    ).resolves.toEqual({ allowed: true });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Claude subscription owner-only and trigger-source gates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claude-subscription-policy-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertUser(id: string) {
    const now = new Date();
    await db.insert(authUsers).values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("allows an authenticated instance with at most one human user and refuses more", async () => {
    const authenticated = { deploymentMode: "authenticated" as const };
    // Nobody has claimed the board yet: only the synthetic local-board principal.
    await insertUser("local-board");
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    expect(await countActiveHumanUsers(db)).toBe(0);
    await expect(resolveClaudeSubscriptionEligibility(db, authenticated)).resolves.toEqual({ allowed: true });

    const { companyId } = await insertCompany();
    await insertUser("owner");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "owner",
      status: "active",
      membershipRole: "owner",
    });
    // An agent membership is not a human user.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: randomUUID(),
      status: "active",
    });
    expect(await countActiveHumanUsers(db)).toBe(1);
    await expect(resolveClaudeSubscriptionEligibility(db, authenticated)).resolves.toEqual({ allowed: true });

    // A signed-up account without a role or an active membership cannot use the
    // instance, so it does not count.
    await insertUser("pending");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "pending",
      status: "suspended",
    });
    await expect(resolveClaudeSubscriptionEligibility(db, authenticated)).resolves.toEqual({ allowed: true });

    // A second active human user.
    await insertUser("teammate");
    await db.insert(instanceUserRoles).values({ userId: "teammate", role: "instance_admin" });
    expect(await countActiveHumanUsers(db)).toBe(2);
    await expect(resolveClaudeSubscriptionEligibility(db, authenticated)).resolves.toEqual({
      allowed: false,
      reason: "subscription_not_allowed",
      message: CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE,
    });
    // local_trusted is single-operator by construction.
    await expect(
      resolveClaudeSubscriptionEligibility(db, { deploymentMode: "local_trusted" }),
    ).resolves.toEqual({ allowed: true });
    // The registered mode is used when none is passed.
    setClaudeSubscriptionDeploymentMode("authenticated");
    await expect(resolveClaudeSubscriptionEligibility(db)).resolves.toMatchObject({ allowed: false });
  });

  async function wake(input: {
    companyId: string;
    agentId: string;
    runId: string;
    source?: string;
    requestedByActorType?: "user" | "agent" | "system" | null;
    requestedByActorId?: string | null;
    reason?: string | null;
    payload?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.source ?? "assignment",
      requestedByActorType: input.requestedByActorType ?? null,
      requestedByActorId: input.requestedByActorId ?? null,
      reason: input.reason ?? null,
      payload: input.payload ?? null,
      runId: input.runId,
    });
    return id;
  }

  it("allows owner-driven wakes", async () => {
    const { companyId, agentId } = await insertCompany();
    const cases = [
      { requestedByActorType: "user" as const, requestedByActorId: "owner", source: "assignment" },
      { requestedByActorType: "system" as const, requestedByActorId: "heartbeat", source: "timer" },
      { requestedByActorType: "agent" as const, requestedByActorId: randomUUID(), source: "automation" },
      { requestedByActorType: null, requestedByActorId: null, source: "on_demand" },
    ];
    for (const entry of cases) {
      const runId = randomUUID();
      const wakeupRequestId = await wake({ companyId, agentId, runId, ...entry });
      await expect(
        resolveClaudeSubscriptionTriggerViolation(db, {
          run: { id: runId, companyId, wakeupRequestId, contextSnapshot: { wakeReason: "issue_assigned" } },
        }),
      ).resolves.toBeNull();
    }
  });

  it("refuses wakes started by a plugin", async () => {
    const { companyId, agentId } = await insertCompany();
    // agents.invoke and agent sessions mark the agent message source.
    for (const source of ["plugin_invoke", "plugin_session"]) {
      const runId = randomUUID();
      const wakeupRequestId = await wake({ companyId, agentId, runId, source: "automation" });
      await expect(
        resolveClaudeSubscriptionTriggerViolation(db, {
          run: {
            id: runId,
            companyId,
            wakeupRequestId,
            contextSnapshot: { paperclipAgentMessage: { text: "hi", source, pluginKey: "acme" } },
          },
        }),
      ).resolves.toMatchObject({ kind: "plugin", message: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE });
    }

    // Any other plugin-requested wake names the plugin as its system requester.
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `acme-${pluginId.slice(0, 8)}`,
      packageName: "@acme/plugin",
      version: "1.0.0",
      manifestJson: {} as never,
    });
    const runId = randomUUID();
    const wakeupRequestId = await wake({
      companyId,
      agentId,
      runId,
      requestedByActorType: "system",
      requestedByActorId: pluginId,
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, { run: { id: runId, companyId, wakeupRequestId } }),
    ).resolves.toMatchObject({ kind: "plugin" });

    // A plugin issue wakeup carries the plugin in its payload.
    const payloadRunId = randomUUID();
    await wake({
      companyId,
      agentId,
      runId: payloadRunId,
      requestedByActorType: "system",
      requestedByActorId: "not-a-uuid",
      payload: { mutation: "plugin_wakeup", pluginId },
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, { run: { id: payloadRunId, companyId } }),
    ).resolves.toMatchObject({ kind: "plugin" });
  });

  it("refuses a chat message from a person not linked to a Paperclip user", async () => {
    const { companyId, agentId } = await insertCompany();
    const principalId = randomUUID();
    await db.insert(chatExternalPrincipals).values({
      id: principalId,
      companyId,
      provider: "telegram",
      providerAccountId: "bot",
      externalId: "guest-1",
    } as never);
    const guestRunId = randomUUID();
    const guestWake = await wake({
      companyId,
      agentId,
      runId: guestRunId,
      requestedByActorType: "system",
      requestedByActorId: principalId,
      payload: { mutation: "chat_message_received" },
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: guestRunId, companyId, wakeupRequestId: guestWake, contextSnapshot: { source: "chat:telegram" } },
      }),
    ).resolves.toMatchObject({ kind: "chat_guest", message: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE });

    // A linked chat user's wake is requested by the Paperclip user.
    const linkedRunId = randomUUID();
    const linkedWake = await wake({
      companyId,
      agentId,
      runId: linkedRunId,
      requestedByActorType: "user",
      requestedByActorId: "owner",
      payload: { mutation: "chat_message_received" },
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: linkedRunId, companyId, wakeupRequestId: linkedWake, contextSnapshot: { source: "chat:telegram" } },
      }),
    ).resolves.toBeNull();
  });

  it("refuses a routine task created by the routine's public webhook trigger", async () => {
    const { companyId, agentId } = await insertCompany();
    const routineId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, title: "Webhook routine", assigneeAgentId: agentId });

    async function routineIssue(source: "webhook" | "schedule") {
      const routineRunId = randomUUID();
      await db.insert(routineRuns).values({ id: routineRunId, companyId, routineId, source });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Routine ${source}`,
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "routine_execution",
        originId: routineId,
        originRunId: routineRunId,
        originFingerprint: randomUUID(),
      } as never);
      return issueId;
    }

    const webhookIssueId = await routineIssue("webhook");
    const dispatchRunId = randomUUID();
    await wake({ companyId, agentId, runId: dispatchRunId, payload: { issueId: webhookIssueId, mutation: "create" } });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: dispatchRunId, companyId, contextSnapshot: { issueId: webhookIssueId, source: "routine.dispatch" } },
        issueId: webhookIssueId,
      }),
    ).resolves.toMatchObject({ kind: "routine_webhook" });

    // The owner commenting on that task later is owner-driven.
    const commentRunId = randomUUID();
    await wake({
      companyId,
      agentId,
      runId: commentRunId,
      requestedByActorType: "user",
      requestedByActorId: "owner",
      payload: { issueId: webhookIssueId, mutation: "comment" },
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: commentRunId, companyId, contextSnapshot: { issueId: webhookIssueId } },
        issueId: webhookIssueId,
      }),
    ).resolves.toBeNull();

    // A routine on a schedule keeps working.
    const scheduleIssueId = await routineIssue("schedule");
    const scheduleRunId = randomUUID();
    await wake({
      companyId,
      agentId,
      runId: scheduleRunId,
      requestedByActorType: "system",
      payload: { issueId: scheduleIssueId, mutation: "create" },
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: scheduleRunId, companyId, contextSnapshot: { issueId: scheduleIssueId, source: "routine.dispatch" } },
        issueId: scheduleIssueId,
      }),
    ).resolves.toBeNull();
  });

  async function originIssue(input: {
    companyId: string;
    agentId: string;
    originKind: string;
    originId?: string | null;
    originRunId?: string | null;
    sourceTrust?: Record<string, unknown> | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Origin ${input.originKind}`,
      status: "todo",
      assigneeAgentId: input.agentId,
      originKind: input.originKind,
      originId: input.originId ?? null,
      originRunId: input.originRunId ?? null,
      sourceTrust: input.sourceTrust ?? null,
    } as never);
    return issueId;
  }

  it("refuses plugin-relayed wakes that a plugin attributes to a user", async () => {
    const { companyId, agentId } = await insertCompany();
    // Comments, interaction responses and approval decisions a plugin relays
    // carry `plugin:<pluginKey>…` as their context source.
    for (const source of ["plugin:acme", "plugin:acme:approval.approve"]) {
      const runId = randomUUID();
      const wakeupRequestId = await wake({
        companyId,
        agentId,
        runId,
        source: "automation",
        requestedByActorType: "user",
        requestedByActorId: "owner",
        payload: { mutation: "comment" },
      });
      await expect(
        resolveClaudeSubscriptionTriggerViolation(db, {
          run: { id: runId, companyId, wakeupRequestId, contextSnapshot: { source, wakeReason: "issue_commented" } },
        }),
      ).resolves.toMatchObject({ kind: "plugin" });
    }
  });

  it("refuses inbound email wakes and system wakes on email conversations", async () => {
    const { companyId, agentId } = await insertCompany();
    const emailIssueId = await originIssue({
      companyId,
      agentId,
      originKind: "chat_channel",
      originId: `email:${randomUUID()}:thread-1`,
    });

    // The inbound email wake itself.
    const emailRunId = randomUUID();
    const emailWake = await wake({
      companyId,
      agentId,
      runId: emailRunId,
      source: "automation",
      requestedByActorType: "system",
      requestedByActorId: "agentmail",
      reason: "email_received",
      payload: { issueId: emailIssueId },
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: {
          id: emailRunId,
          companyId,
          wakeupRequestId: emailWake,
          contextSnapshot: { issueId: emailIssueId, emailEndpointId: randomUUID() },
        },
        issueId: emailIssueId,
      }),
    ).resolves.toMatchObject({ kind: "email", message: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE });

    // A recovery liveness dispatch on the email task.
    const recoveryRunId = randomUUID();
    await wake({
      companyId,
      agentId,
      runId: recoveryRunId,
      requestedByActorType: "system",
      payload: { issueId: emailIssueId, mutation: "assigned_todo_liveness_dispatch" },
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: {
          id: recoveryRunId,
          companyId,
          contextSnapshot: { issueId: emailIssueId, source: "issue.assigned_todo_liveness_dispatch" },
        },
        issueId: emailIssueId,
      }),
    ).resolves.toMatchObject({ kind: "email" });

    // The owner commenting on the email task is owner-driven.
    const ownerRunId = randomUUID();
    await wake({
      companyId,
      agentId,
      runId: ownerRunId,
      requestedByActorType: "user",
      requestedByActorId: "owner",
      payload: { issueId: emailIssueId, mutation: "comment" },
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: ownerRunId, companyId, contextSnapshot: { issueId: emailIssueId } },
        issueId: emailIssueId,
      }),
    ).resolves.toBeNull();
  });

  it("refuses system wakes on plugin tasks and unlinked-guest chat tasks", async () => {
    const { companyId, agentId } = await insertCompany();
    const recoveryWake = async (issueId: string) => {
      const runId = randomUUID();
      await wake({
        companyId,
        agentId,
        runId,
        requestedByActorType: "system",
        payload: { issueId, mutation: "assigned_todo_liveness_dispatch" },
      });
      return resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: runId, companyId, contextSnapshot: { issueId, source: "issue.assigned_todo_liveness_dispatch" } },
        issueId,
      });
    };

    // A plugin's own task, and a plugin-managed routine's task (whatever its trigger).
    for (const originKind of ["plugin:acme", "plugin:acme:operation"]) {
      const issueId = await originIssue({ companyId, agentId, originKind });
      await expect(recoveryWake(issueId)).resolves.toMatchObject({ kind: "plugin" });
    }

    // A chat conversation an unlinked person started is marked low trust.
    const guestIssueId = await originIssue({
      companyId,
      agentId,
      originKind: "chat_channel",
      originId: `${randomUUID()}:thread:1`,
      sourceTrust: { preset: "low_trust_review", disposition: "quarantined" },
    });
    await expect(recoveryWake(guestIssueId)).resolves.toMatchObject({ kind: "chat_guest" });

    // A chat conversation a linked Paperclip user started keeps its follow-ups.
    const linkedIssueId = await originIssue({
      companyId,
      agentId,
      originKind: "chat_channel",
      originId: `${randomUUID()}:thread:2`,
    });
    await expect(recoveryWake(linkedIssueId)).resolves.toBeNull();

    // An ordinary board task keeps its follow-ups.
    const manualIssueId = await originIssue({ companyId, agentId, originKind: "manual" });
    await expect(recoveryWake(manualIssueId)).resolves.toBeNull();
  });
});
