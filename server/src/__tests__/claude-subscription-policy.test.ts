import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agentWakeupRequests,
  agents,
  authUsers,
  chatActions,
  chatDeliveries,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issues,
  pluginManagedResources,
  plugins,
  routineRevisions,
  routineRuns,
  routineTriggers,
  routines,
  toolApplications,
  toolConnections,
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

  async function insertChatEndpoint(companyId: string, agentId: string, provider: "github" | "slack") {
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: `${provider} bot`, type: "chat" });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: provider,
      uid: `${provider}-${connectionId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider,
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
    });
    return endpointId;
  }

  /** An external chat account, linked to `linkedUserId` on the endpoint when given. */
  async function chatPrincipal(input: {
    companyId: string;
    endpointId: string;
    provider: "github" | "slack";
    externalId: string;
    linkedUserId?: string;
    linkStatus?: "linked" | "pending";
  }) {
    const principalId = randomUUID();
    await db.insert(chatExternalPrincipals).values({
      id: principalId,
      companyId: input.companyId,
      provider: input.provider,
      providerAccountId: "account-1",
      externalId: input.externalId,
    } as never);
    if (input.linkedUserId) {
      await db.insert(chatIdentityLinks).values({
        companyId: input.companyId,
        endpointId: input.endpointId,
        principalId,
        paperclipUserId: input.linkedUserId,
        status: input.linkStatus ?? "linked",
      });
    }
    return principalId;
  }

  /** The normalized event of a signed GitHub pull_request webhook (a GitHub automatic review). */
  function githubAutomaticEvent(input: {
    author: string;
    sender: string;
    guest: boolean;
    responsibleUserId: string;
  }) {
    return {
      kind: "mention",
      githubAutomatic: {
        revision: 1,
        policy: { invocation: "allowed_authors" },
        context: {
          event: "synchronize",
          repository: "acme/app",
          repositoryId: "42",
          pullNumber: 7,
          author: { id: input.author, login: `user-${input.author}`, isBot: false },
          sender: { id: input.sender, login: `user-${input.sender}` },
        },
      },
      githubAuthority: {
        guest: input.guest,
        responsibleUserId: input.responsibleUserId,
        sponsorUserId: null,
      },
      principal: { externalId: input.author },
    };
  }

  /**
   * A chat message's durable wake, as chat-channels stages it: an
   * `inbound_wakeup` chat action for the delivery, and a wake request with the
   * action's id and attribution. Returns the gate's verdict for the run.
   */
  async function chatMessageRun(input: {
    companyId: string;
    agentId: string;
    endpointId: string;
    principalId: string;
    issueId: string;
    requestedByActorType: "user" | "system";
    requestedByActorId: string;
    normalizedEvent: Record<string, unknown>;
  }) {
    const deliveryId = randomUUID();
    await db.insert(chatDeliveries).values({
      id: deliveryId,
      companyId: input.companyId,
      endpointId: input.endpointId,
      principalId: input.principalId,
      providerEventId: `event-${deliveryId}`,
      deduplicationKey: `dedupe-${deliveryId}`,
      eventKind: "mention",
      normalizedEvent: input.normalizedEvent,
      state: "processed",
    });
    const actionId = randomUUID();
    const commentId = randomUUID();
    await db.insert(chatActions).values({
      id: actionId,
      companyId: input.companyId,
      endpointId: input.endpointId,
      deliveryId,
      principalId: input.principalId,
      kind: "inbound_wakeup",
      providerActionId: `inbound_wakeup:${deliveryId}`,
      status: "processed",
      payload: {
        version: 1,
        issueId: input.issueId,
        agentId: input.agentId,
        commentId,
        sessionGeneration: 1,
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
      },
    });
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: actionId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      reason: "issue_commented",
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId,
      payload: { issueId: input.issueId, commentId },
      runId,
    });
    return resolveClaudeSubscriptionTriggerViolation(db, {
      run: {
        id: runId,
        companyId: input.companyId,
        wakeupRequestId: actionId,
        contextSnapshot: { issueId: input.issueId },
      },
      issueId: input.issueId,
    });
  }

  it("refuses GitHub automatic reviews of a guest's pull request that chat attributes to the owner", async () => {
    const { companyId, agentId } = await insertCompany();
    const endpointId = await insertChatEndpoint(companyId, agentId, "github");
    // No sourceTrust on the task: the gate must not depend on the low-trust
    // review policy that chat-channels applies to the task.
    const issueId = await originIssue({
      companyId,
      agentId,
      originKind: "chat_channel",
      originId: `${endpointId}:github:acme/app:7:1`,
    });
    // A configured guest author: not linked to any Paperclip user. The review
    // policy makes the configured responsible user (the owner) the requester.
    const guestPrincipalId = await chatPrincipal({ companyId, endpointId, provider: "github", externalId: "1001" });
    await expect(
      chatMessageRun({
        companyId,
        agentId,
        endpointId,
        principalId: guestPrincipalId,
        issueId,
        requestedByActorType: "user",
        requestedByActorId: "owner",
        normalizedEvent: githubAutomaticEvent({ author: "1001", sender: "1001", guest: true, responsibleUserId: "owner" }),
      }),
    ).resolves.toMatchObject({ kind: "chat_guest", message: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE });

    // The same, without the delivery's guest marker: the author is still not
    // linked to the owner the wake is attributed to.
    await expect(
      chatMessageRun({
        companyId,
        agentId,
        endpointId,
        principalId: guestPrincipalId,
        issueId,
        requestedByActorType: "user",
        requestedByActorId: "owner",
        normalizedEvent: githubAutomaticEvent({ author: "1001", sender: "1001", guest: false, responsibleUserId: "owner" }),
      }),
    ).resolves.toMatchObject({ kind: "chat_guest" });
  });

  it("refuses GitHub automatic reviews an unlinked GitHub account triggered on the owner's pull request", async () => {
    const { companyId, agentId } = await insertCompany();
    const endpointId = await insertChatEndpoint(companyId, agentId, "github");
    const issueId = await originIssue({
      companyId,
      agentId,
      originKind: "chat_channel",
      originId: `${endpointId}:github:acme/app:8:1`,
    });
    const ownerPrincipalId = await chatPrincipal({
      companyId,
      endpointId,
      provider: "github",
      externalId: "2001",
      linkedUserId: "owner",
    });
    const run = (sender: string) =>
      chatMessageRun({
        companyId,
        agentId,
        endpointId,
        principalId: ownerPrincipalId,
        issueId,
        requestedByActorType: "user",
        requestedByActorId: "owner",
        normalizedEvent: githubAutomaticEvent({ author: "2001", sender, guest: false, responsibleUserId: "owner" }),
      });

    // A push (synchronize) or reopen by a GitHub account Paperclip has never seen.
    await expect(run("2999")).resolves.toMatchObject({ kind: "chat_guest" });

    // A GitHub account whose link to the owner was never confirmed.
    await chatPrincipal({
      companyId,
      endpointId,
      provider: "github",
      externalId: "2002",
      linkedUserId: "owner",
      linkStatus: "pending",
    });
    await expect(run("2002")).resolves.toMatchObject({ kind: "chat_guest" });

    // Author and sender are both the owner's linked GitHub account.
    await expect(run("2001")).resolves.toBeNull();
  });

  it("refuses chat wakes attributed to a user the chat account is not linked to", async () => {
    const { companyId, agentId } = await insertCompany();
    const endpointId = await insertChatEndpoint(companyId, agentId, "slack");
    const issueId = await originIssue({
      companyId,
      agentId,
      originKind: "chat_channel",
      originId: `${endpointId}:slack:C1:1`,
    });
    const teammatePrincipalId = await chatPrincipal({
      companyId,
      endpointId,
      provider: "slack",
      externalId: "U-teammate",
      linkedUserId: "teammate",
    });
    await expect(
      chatMessageRun({
        companyId,
        agentId,
        endpointId,
        principalId: teammatePrincipalId,
        issueId,
        requestedByActorType: "user",
        requestedByActorId: "owner",
        normalizedEvent: { kind: "mention", principal: { externalId: "U-teammate" } },
      }),
    ).resolves.toMatchObject({ kind: "chat_guest" });

    // The owner's own linked chat account.
    const ownerPrincipalId = await chatPrincipal({
      companyId,
      endpointId,
      provider: "slack",
      externalId: "U-owner",
      linkedUserId: "owner",
    });
    await expect(
      chatMessageRun({
        companyId,
        agentId,
        endpointId,
        principalId: ownerPrincipalId,
        issueId,
        requestedByActorType: "user",
        requestedByActorId: "owner",
        normalizedEvent: { kind: "mention", principal: { externalId: "U-owner" } },
      }),
    ).resolves.toBeNull();

    // The owner's own linked chat message is the owner's wake, also on a chat
    // conversation an unlinked person started (the owner's comment from the
    // Paperclip UI runs there too).
    const guestIssueId = await originIssue({
      companyId,
      agentId,
      originKind: "chat_channel",
      originId: `${endpointId}:slack:C1:2`,
      sourceTrust: { preset: "low_trust_review", disposition: "quarantined" },
    });
    await expect(
      chatMessageRun({
        companyId,
        agentId,
        endpointId,
        principalId: ownerPrincipalId,
        issueId: guestIssueId,
        requestedByActorType: "user",
        requestedByActorId: "owner",
        normalizedEvent: { kind: "mention", principal: { externalId: "U-owner" } },
      }),
    ).resolves.toBeNull();
    // A chat wake attributed to the owner from an account that is not linked
    // to the owner stays external there.
    await expect(
      chatMessageRun({
        companyId,
        agentId,
        endpointId,
        principalId: teammatePrincipalId,
        issueId: guestIssueId,
        requestedByActorType: "user",
        requestedByActorId: "owner",
        normalizedEvent: { kind: "mention", principal: { externalId: "U-teammate" } },
      }),
    ).resolves.toMatchObject({ kind: "chat_guest" });
  });

  it("checks retried and coalesced chat wakes too", async () => {
    const { companyId, agentId } = await insertCompany();
    const endpointId = await insertChatEndpoint(companyId, agentId, "github");
    const issueId = await originIssue({
      companyId,
      agentId,
      originKind: "chat_channel",
      originId: `${endpointId}:github:acme/app:9:1`,
    });
    const guestPrincipalId = await chatPrincipal({ companyId, endpointId, provider: "github", externalId: "3001" });
    const deliveryId = randomUUID();
    await db.insert(chatDeliveries).values({
      id: deliveryId,
      companyId,
      endpointId,
      principalId: guestPrincipalId,
      providerEventId: `event-${deliveryId}`,
      deduplicationKey: `dedupe-${deliveryId}`,
      eventKind: "mention",
      normalizedEvent: githubAutomaticEvent({ author: "3001", sender: "3001", guest: true, responsibleUserId: "owner" }),
      state: "processed",
    });

    // A board retry of the failed run replays the guest's chat input with the
    // original attribution.
    const retryActionId = randomUUID();
    await db.insert(chatActions).values({
      id: retryActionId,
      companyId,
      endpointId,
      principalId: guestPrincipalId,
      kind: "failed_run_retry",
      providerActionId: `failed_run_retry:${randomUUID()}`,
      status: "issued",
      payload: {
        version: 1,
        issueId,
        agentId,
        principalId: guestPrincipalId,
        requestedByActorType: "user",
        requestedByActorId: "owner",
        sources: [{ actionId: randomUUID(), deliveryId, commentId: randomUUID() }],
        initiatedByUserId: "owner",
      },
    });
    const retryRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: retryActionId,
      companyId,
      agentId,
      source: "on_demand",
      reason: "retry_failed_run",
      requestedByActorType: "user",
      requestedByActorId: "owner",
      payload: { issueId },
      runId: retryRunId,
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: retryRunId, companyId, wakeupRequestId: retryActionId, contextSnapshot: { issueId } },
        issueId,
      }),
    ).resolves.toMatchObject({ kind: "chat_guest" });

    // A chat receipt coalesced into a deferred owner wake (no run id of its own).
    const ownerWakeId = await wake({
      companyId,
      agentId,
      runId: randomUUID(),
      requestedByActorType: "user",
      requestedByActorId: "owner",
      payload: { issueId, mutation: "comment" },
    });
    const coalescedActionId = randomUUID();
    await db.insert(chatActions).values({
      id: coalescedActionId,
      companyId,
      endpointId,
      deliveryId,
      principalId: guestPrincipalId,
      kind: "inbound_wakeup",
      providerActionId: `inbound_wakeup:${deliveryId}`,
      status: "processed",
      payload: {
        version: 1,
        issueId,
        agentId,
        commentId: randomUUID(),
        sessionGeneration: 1,
        requestedByActorType: "user",
        requestedByActorId: "owner",
      },
    });
    await db.insert(agentWakeupRequests).values({
      id: coalescedActionId,
      companyId,
      agentId,
      source: "automation",
      status: "coalesced",
      requestedByActorType: "user",
      requestedByActorId: "owner",
      payload: { issueId, coalescedIntoWakeupRequestId: ownerWakeId },
    });
    const [ownerWake] = await db
      .select({ runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, ownerWakeId));
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: ownerWake!.runId!, companyId, wakeupRequestId: ownerWakeId, contextSnapshot: { issueId } },
        issueId,
      }),
    ).resolves.toMatchObject({ kind: "chat_guest" });
  });

  it("allows retried and coalesced chat wakes from the owner's linked accounts", async () => {
    const { companyId, agentId } = await insertCompany();
    const endpointId = await insertChatEndpoint(companyId, agentId, "github");
    const issueId = await originIssue({
      companyId,
      agentId,
      originKind: "chat_channel",
      originId: `${endpointId}:github:acme/app:10:1`,
    });
    const ownerPrincipalId = await chatPrincipal({
      companyId,
      endpointId,
      provider: "github",
      externalId: "4001",
      linkedUserId: "owner",
    });
    // The owner's own pull request, pushed by the owner's linked account.
    const deliveryId = randomUUID();
    await db.insert(chatDeliveries).values({
      id: deliveryId,
      companyId,
      endpointId,
      principalId: ownerPrincipalId,
      providerEventId: `event-${deliveryId}`,
      deduplicationKey: `dedupe-${deliveryId}`,
      eventKind: "mention",
      normalizedEvent: githubAutomaticEvent({ author: "4001", sender: "4001", guest: false, responsibleUserId: "owner" }),
      state: "processed",
    });

    // A board retry of the owner's failed chat run.
    const retryActionId = randomUUID();
    await db.insert(chatActions).values({
      id: retryActionId,
      companyId,
      endpointId,
      principalId: ownerPrincipalId,
      kind: "failed_run_retry",
      providerActionId: `failed_run_retry:${randomUUID()}`,
      status: "issued",
      payload: {
        version: 1,
        issueId,
        agentId,
        principalId: ownerPrincipalId,
        requestedByActorType: "user",
        requestedByActorId: "owner",
        sources: [{ actionId: randomUUID(), deliveryId, commentId: randomUUID() }],
        initiatedByUserId: "owner",
      },
    });
    const retryRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: retryActionId,
      companyId,
      agentId,
      source: "on_demand",
      reason: "retry_failed_run",
      requestedByActorType: "user",
      requestedByActorId: "owner",
      payload: { issueId },
      runId: retryRunId,
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: retryRunId, companyId, wakeupRequestId: retryActionId, contextSnapshot: { issueId } },
        issueId,
      }),
    ).resolves.toBeNull();

    // The owner's chat receipt coalesced into a deferred owner wake.
    const ownerWakeId = await wake({
      companyId,
      agentId,
      runId: randomUUID(),
      requestedByActorType: "user",
      requestedByActorId: "owner",
      payload: { issueId, mutation: "comment" },
    });
    const coalescedActionId = randomUUID();
    await db.insert(chatActions).values({
      id: coalescedActionId,
      companyId,
      endpointId,
      deliveryId,
      principalId: ownerPrincipalId,
      kind: "inbound_wakeup",
      providerActionId: `inbound_wakeup:${deliveryId}`,
      status: "processed",
      payload: {
        version: 1,
        issueId,
        agentId,
        commentId: randomUUID(),
        sessionGeneration: 1,
        requestedByActorType: "user",
        requestedByActorId: "owner",
      },
    });
    await db.insert(agentWakeupRequests).values({
      id: coalescedActionId,
      companyId,
      agentId,
      source: "automation",
      status: "coalesced",
      requestedByActorType: "user",
      requestedByActorId: "owner",
      payload: { issueId, coalescedIntoWakeupRequestId: ownerWakeId },
    });
    const [ownerWake] = await db
      .select({ runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, ownerWakeId));
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: ownerWake!.runId!, companyId, wakeupRequestId: ownerWakeId, contextSnapshot: { issueId } },
        issueId,
      }),
    ).resolves.toBeNull();
  });

  it("refuses the tasks of a plugin-managed routine, whatever the run source", async () => {
    const { companyId, agentId } = await insertCompany();
    const pluginId = randomUUID();
    const pluginKey = `acme-${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: "@acme/plugin",
      version: "1.0.0",
      manifestJson: {} as never,
    });
    const managedRoutineId = randomUUID();
    await db.insert(routines).values({ id: managedRoutineId, companyId, title: "Managed", assigneeAgentId: agentId });
    await db.insert(pluginManagedResources).values({
      companyId,
      pluginId,
      pluginKey,
      resourceKind: "routine",
      resourceKey: "sync",
      resourceId: managedRoutineId,
    });
    const ownerRoutineId = randomUUID();
    await db.insert(routines).values({ id: ownerRoutineId, companyId, title: "Owner", assigneeAgentId: agentId });

    // A routine run's task (origin routine_execution, as routines.ts creates it
    // when the managed issue template does not mark it as a plugin operation)
    // and its routine.dispatch wake.
    async function routineDispatch(input: {
      routineId: string;
      source: "manual" | "schedule" | "api";
      originId?: string;
      createdByUserId?: string;
    }) {
      const routineRunId = randomUUID();
      await db.insert(routineRuns).values({ id: routineRunId, companyId, routineId: input.routineId, source: input.source });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Routine ${input.source}`,
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "routine_execution",
        originId: input.originId ?? input.routineId,
        originRunId: routineRunId,
        originFingerprint: randomUUID(),
        createdByUserId: input.createdByUserId ?? null,
      } as never);
      const runId = randomUUID();
      await wake({
        companyId,
        agentId,
        runId,
        requestedByActorType: input.source === "schedule" ? "system" : null,
        payload: { issueId, mutation: "create" },
      });
      return resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: runId, companyId, contextSnapshot: { issueId, source: "routine.dispatch" } },
        issueId,
      });
    }

    // ctx.routines.managed.run: a manual run without a user, which a plugin
    // webhook can drive.
    await expect(routineDispatch({ routineId: managedRoutineId, source: "manual" })).resolves.toMatchObject({
      kind: "plugin",
      message: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE,
    });
    // The managed routine's own triggers.
    await expect(routineDispatch({ routineId: managedRoutineId, source: "schedule" })).resolves.toMatchObject({
      kind: "plugin",
    });
    await expect(routineDispatch({ routineId: managedRoutineId, source: "api" })).resolves.toMatchObject({
      kind: "plugin",
    });
    // A managed issue template that sets its own origin id.
    await expect(
      routineDispatch({ routineId: managedRoutineId, source: "manual", originId: `${pluginKey}:sync` }),
    ).resolves.toMatchObject({ kind: "plugin" });
    // The owner running the managed routine by hand from the board.
    await expect(
      routineDispatch({ routineId: managedRoutineId, source: "manual", createdByUserId: "owner" }),
    ).resolves.toBeNull();
    // A routine no plugin manages.
    await expect(routineDispatch({ routineId: ownerRoutineId, source: "manual" })).resolves.toBeNull();
    await expect(routineDispatch({ routineId: ownerRoutineId, source: "api" })).resolves.toBeNull();
  });

  it("refuses wakes that come through a task bridge key", async () => {
    const { companyId, agentId } = await insertCompany();
    async function insertAgent(name: string) {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "hermes_gateway",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return id;
    }
    async function insertKey(input: { agentId: string; scope: Record<string, unknown>; revokedAt?: Date }) {
      const id = randomUUID();
      await db.insert(agentApiKeys).values({
        id,
        agentId: input.agentId,
        companyId,
        name: "key",
        keyHash: `hash-${id}`,
        scopeConfig: input.scope as never,
        revokedAt: input.revokedAt ?? null,
      });
      return id;
    }
    const bridgeAgentId = await insertAgent("Hermes bridge");
    const bridgeKeyId = await insertKey({
      agentId: bridgeAgentId,
      scope: { kind: "task_bridge", projectId: randomUUID(), allowedAssigneeAgentIds: [agentId] },
    });
    const run = async (issueId: string, requestedByActorType: "user" | "agent" | "system", requestedByActorId: string | null) => {
      const runId = randomUUID();
      await wake({
        companyId,
        agentId,
        runId,
        requestedByActorType,
        requestedByActorId,
        payload: { issueId, mutation: "create" },
      });
      return resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: runId, companyId, contextSnapshot: { issueId, source: "issue.create" } },
        issueId,
      });
    };

    // A task the bridge created (routes/issues.ts sets origin task_bridge with
    // the key's id), woken by its assignment, and later by recovery.
    const bridgeIssueId = await originIssue({ companyId, agentId, originKind: "task_bridge", originId: bridgeKeyId });
    await expect(run(bridgeIssueId, "agent", bridgeAgentId)).resolves.toMatchObject({
      kind: "task_bridge",
      message: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE,
    });
    await expect(run(bridgeIssueId, "system", null)).resolves.toMatchObject({ kind: "task_bridge" });
    // The owner's comment on it is owner-driven.
    await expect(run(bridgeIssueId, "user", "owner")).resolves.toBeNull();

    // An owner task that the bridge key reassigned: the key may mutate a task
    // assigned to its own agent and assign it to an allowed agent.
    const ownerIssueId = await originIssue({ companyId, agentId, originKind: "manual" });
    await expect(run(ownerIssueId, "agent", bridgeAgentId)).resolves.toMatchObject({ kind: "task_bridge" });

    // Delegation by agents without a live task bridge key stays allowed.
    const peerAgentId = await insertAgent("Peer");
    await insertKey({ agentId: peerAgentId, scope: { kind: "standard" } });
    await insertKey({
      agentId: peerAgentId,
      scope: { kind: "task_bridge", projectId: randomUUID() },
      revokedAt: new Date(Date.now() - 60_000),
    });
    await expect(run(ownerIssueId, "agent", peerAgentId)).resolves.toBeNull();
  });

  it("refuses wakes no user requested on a task a plugin last assigned or moved", async () => {
    const { companyId, agentId } = await insertCompany();
    const pluginId = randomUUID();
    const issueId = await originIssue({ companyId, agentId, originKind: "manual" });
    let clock = Date.now() - 60_000;
    async function activity(input: { actorType: "plugin" | "user" | "agent"; action: string; details: Record<string, unknown> }) {
      clock += 1_000;
      await db.insert(activityLog).values({
        companyId,
        actorType: input.actorType,
        actorId: input.actorType === "plugin" ? pluginId : input.actorType === "user" ? "owner" : randomUUID(),
        action: input.action,
        entityType: "issue",
        entityId: issueId,
        details: input.details,
        createdAt: new Date(clock),
      });
    }
    // The plugin-host-services issues.update activity row.
    const pluginUpdate = (patch: Record<string, unknown>) =>
      activity({
        actorType: "plugin",
        action: "issue.updated",
        details: {
          identifier: "PAP-1",
          patch,
          _previous: { status: "done", assigneeAgentId: null, assigneeUserId: null },
          sourcePluginId: pluginId,
          sourcePluginKey: "acme",
        },
      });
    const run = async (requestedByActorType: "user" | "agent" | "system", requestedByActorId: string | null) => {
      const runId = randomUUID();
      await wake({
        companyId,
        agentId,
        runId,
        requestedByActorType,
        requestedByActorId,
        payload: { issueId, mutation: "assigned_todo_liveness_dispatch" },
      });
      return resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: runId, companyId, contextSnapshot: { issueId, source: "issue.assigned_todo_liveness_dispatch" } },
        issueId,
      });
    };

    // A plugin edit that neither assigns nor moves the task.
    await pluginUpdate({ title: "Renamed" });
    await expect(run("system", null)).resolves.toBeNull();

    // The plugin assigns the owner's task to the agent; the recovery liveness
    // dispatch, and an agent's wake, only continue that change.
    await pluginUpdate({ assigneeAgentId: agentId, status: "todo" });
    await expect(run("system", null)).resolves.toMatchObject({
      kind: "plugin",
      message: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE,
    });
    await expect(run("agent", randomUUID())).resolves.toMatchObject({ kind: "plugin" });
    // An agent's later activity does not lift it.
    await activity({ actorType: "agent", action: "issue.updated", details: { status: "in_progress" } });
    await expect(run("system", null)).resolves.toMatchObject({ kind: "plugin" });
    // The owner's own wake is owner-driven.
    await expect(run("user", "owner")).resolves.toBeNull();

    // Later owner activity on the task lifts it.
    await activity({ actorType: "user", action: "issue.comment_added", details: { identifier: "PAP-1" } });
    await expect(run("system", null)).resolves.toBeNull();

    // A plugin that only moves the task (or unassigns it) counts again.
    await pluginUpdate({ status: "todo" });
    await expect(run("system", null)).resolves.toMatchObject({ kind: "plugin" });
    await activity({ actorType: "user", action: "issue.updated", details: { status: "todo" } });
    await pluginUpdate({ assigneeAgentId: null });
    await expect(run("system", null)).resolves.toMatchObject({ kind: "plugin" });

    // Any plugin edit beyond the task's text, priority, labels or billing code
    // can start work or rewrite what this gate reads (creator, origin, blockers).
    for (const patch of [{ createdByUserId: "owner" }, { originRunId: randomUUID() }, { blockedByIssueIds: [] }]) {
      await activity({ actorType: "user", action: "issue.updated", details: { status: "todo" } });
      await expect(run("system", null)).resolves.toBeNull();
      await pluginUpdate(patch);
      await expect(run("system", null)).resolves.toMatchObject({ kind: "plugin" });
    }

    // Removing blockers through the relations API can unblock the task; adding
    // one cannot.
    await activity({ actorType: "user", action: "issue.updated", details: { status: "todo" } });
    await activity({
      actorType: "plugin",
      action: "issue.relations.updated",
      details: { mutation: "add", blockedByIssueIds: [randomUUID()], sourcePluginId: pluginId },
    });
    await expect(run("system", null)).resolves.toBeNull();
    await activity({
      actorType: "plugin",
      action: "issue.relations.updated",
      details: { mutation: "remove", blockedByIssueIds: [], sourcePluginId: pluginId },
    });
    await expect(run("system", null)).resolves.toMatchObject({ kind: "plugin" });

    // Opening the task logs the owner's read marker (IssueDetail marks it read
    // on every load) and other passive rows; none of them lifts the refusal.
    await pluginUpdate({ assigneeAgentId: agentId, status: "todo" });
    for (const action of [
      "issue.read_marked",
      "issue.read_unmarked",
      "issue.inbox_archived",
      "issue.inbox_unarchived",
      "issue.inbox_touched",
      "issue.conversation_opened",
      "issue.feedback_vote_saved",
      "issue.file_resource_availability",
      "issue.file_resource_content_read",
      "issue.file_resource_download_denied",
      "issue.tree_control_previewed",
      "issue.attribution_spoof_rejected",
      "external_object.refresh_requested",
    ]) {
      await activity({ actorType: "user", action, details: {} });
      await expect(run("system", null)).resolves.toMatchObject({ kind: "plugin" });
    }
    // The owner's comment does.
    await activity({ actorType: "user", action: "issue.comment_added", details: { identifier: "PAP-1" } });
    await expect(run("system", null)).resolves.toBeNull();
  });

  it("refuses routine runs that a task bridge agent triggered or authored", async () => {
    const { companyId, agentId } = await insertCompany();
    async function insertAgent(name: string) {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "hermes_gateway",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return id;
    }
    async function insertKey(input: { agentId: string; scope: Record<string, unknown>; revokedAt?: Date }) {
      const id = randomUUID();
      await db.insert(agentApiKeys).values({
        id,
        agentId: input.agentId,
        companyId,
        name: "key",
        keyHash: `hash-${id}`,
        scopeConfig: input.scope as never,
        revokedAt: input.revokedAt ?? null,
      });
      return id;
    }
    const bridgeAgentId = await insertAgent("Hermes bridge");
    await insertKey({ agentId: bridgeAgentId, scope: { kind: "task_bridge", projectId: randomUUID() } });
    const peerAgentId = await insertAgent("Peer");
    await insertKey({ agentId: peerAgentId, scope: { kind: "standard" } });

    async function insertRoutine(input: { assigneeAgentId: string; createdByAgentId?: string; createdByUserId?: string }) {
      const id = randomUUID();
      await db.insert(routines).values({
        id,
        companyId,
        title: "Routine",
        assigneeAgentId: input.assigneeAgentId,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      });
      return id;
    }

    // A routine run's task and its routine.dispatch wake. `trigger` is the
    // routine.run_triggered activity row routes/routines.ts writes after the run.
    async function routineDispatch(input: {
      routineId: string;
      source: "manual" | "schedule" | "api";
      triggerId?: string;
      createdByUserId?: string;
      createdByAgentId?: string;
      trigger?: { actorType: "user" | "agent"; actorId: string };
    }) {
      const routineRunId = randomUUID();
      await db.insert(routineRuns).values({
        id: routineRunId,
        companyId,
        routineId: input.routineId,
        triggerId: input.triggerId ?? null,
        source: input.source,
      });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Routine ${input.source}`,
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "routine_execution",
        originId: input.routineId,
        originRunId: routineRunId,
        originFingerprint: randomUUID(),
        createdByUserId: input.createdByUserId ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
      } as never);
      if (input.trigger) {
        await db.insert(activityLog).values({
          companyId,
          actorType: input.trigger.actorType,
          actorId: input.trigger.actorId,
          agentId: input.trigger.actorType === "agent" ? input.trigger.actorId : null,
          action: "routine.run_triggered",
          entityType: "routine_run",
          entityId: routineRunId,
          details: { routineId: input.routineId, source: input.source, status: "issue_created" },
        });
      }
      const runId = randomUUID();
      await wake({
        companyId,
        agentId,
        runId,
        requestedByActorType: input.source === "schedule" ? "system" : null,
        payload: { issueId, mutation: "create" },
      });
      return resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: runId, companyId, contextSnapshot: { issueId, source: "routine.dispatch" } },
        issueId,
      });
    }

    // The bridge agent runs its own routine with the subscription agent as the
    // assignee (runRoutineSchema accepts assigneeAgentId and source).
    const bridgeRunRoutineId = await insertRoutine({ assigneeAgentId: bridgeAgentId, createdByUserId: "owner" });
    await expect(
      routineDispatch({
        routineId: bridgeRunRoutineId,
        source: "api",
        trigger: { actorType: "agent", actorId: bridgeAgentId },
      }),
    ).resolves.toMatchObject({ kind: "task_bridge", message: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE });
    await expect(
      routineDispatch({
        routineId: bridgeRunRoutineId,
        source: "manual",
        trigger: { actorType: "agent", actorId: bridgeAgentId },
      }),
    ).resolves.toMatchObject({ kind: "task_bridge" });
    // A manual run names the agent on its task even before the activity row exists.
    await expect(
      routineDispatch({ routineId: bridgeRunRoutineId, source: "manual", createdByAgentId: bridgeAgentId }),
    ).resolves.toMatchObject({ kind: "task_bridge" });
    // An api run whose trigger is not recorded (yet) is refused while the
    // company holds a live task bridge key.
    await expect(routineDispatch({ routineId: bridgeRunRoutineId, source: "api" })).resolves.toMatchObject({
      kind: "task_bridge",
    });
    await expect(routineDispatch({ routineId: bridgeRunRoutineId, source: "manual" })).resolves.toMatchObject({
      kind: "task_bridge",
    });

    // Owner-driven runs of an owner routine stay allowed.
    const ownerRoutineId = await insertRoutine({ assigneeAgentId: agentId, createdByUserId: "owner" });
    await expect(
      routineDispatch({ routineId: ownerRoutineId, source: "manual", createdByUserId: "owner" }),
    ).resolves.toBeNull();
    await expect(
      routineDispatch({ routineId: ownerRoutineId, source: "api", trigger: { actorType: "user", actorId: "owner" } }),
    ).resolves.toBeNull();
    await expect(routineDispatch({ routineId: ownerRoutineId, source: "schedule" })).resolves.toBeNull();
    // So do runs by an agent without a task bridge key.
    await expect(
      routineDispatch({ routineId: ownerRoutineId, source: "api", trigger: { actorType: "agent", actorId: peerAgentId } }),
    ).resolves.toBeNull();
    await expect(
      routineDispatch({ routineId: ownerRoutineId, source: "manual", createdByAgentId: peerAgentId }),
    ).resolves.toBeNull();

    // A routine the bridge agent created (and the owner later assigned to the
    // subscription agent): every run the owner did not start by hand.
    const bridgeRoutineId = await insertRoutine({ assigneeAgentId: agentId, createdByAgentId: bridgeAgentId });
    await expect(routineDispatch({ routineId: bridgeRoutineId, source: "schedule" })).resolves.toMatchObject({
      kind: "task_bridge",
    });
    await expect(
      routineDispatch({ routineId: bridgeRoutineId, source: "api", trigger: { actorType: "agent", actorId: peerAgentId } }),
    ).resolves.toMatchObject({ kind: "task_bridge" });
    await expect(
      routineDispatch({ routineId: bridgeRoutineId, source: "manual", createdByUserId: "owner" }),
    ).resolves.toBeNull();

    // A routine the bridge agent edited, or whose schedule it added.
    const editedRoutineId = await insertRoutine({ assigneeAgentId: agentId, createdByUserId: "owner" });
    await db.insert(routineRevisions).values({
      companyId,
      routineId: editedRoutineId,
      revisionNumber: 2,
      title: "Routine",
      snapshot: {} as never,
      createdByAgentId: bridgeAgentId,
    });
    await expect(routineDispatch({ routineId: editedRoutineId, source: "schedule" })).resolves.toMatchObject({
      kind: "task_bridge",
    });
    const scheduledRoutineId = await insertRoutine({ assigneeAgentId: agentId, createdByUserId: "owner" });
    const bridgeTriggerId = randomUUID();
    await db.insert(routineTriggers).values({
      id: bridgeTriggerId,
      companyId,
      routineId: scheduledRoutineId,
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      createdByAgentId: bridgeAgentId,
    });
    await expect(
      routineDispatch({ routineId: scheduledRoutineId, source: "schedule", triggerId: bridgeTriggerId }),
    ).resolves.toMatchObject({ kind: "task_bridge" });
  });

  it("counts a task bridge key for routine runs only from when it was created", async () => {
    const { companyId, agentId } = await insertCompany();
    const day = 24 * 60 * 60_000;
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);
    async function insertAgent(name: string) {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "hermes_gateway",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return id;
    }
    async function insertBridgeKey(agentIdForKey: string, createdAt: Date, revokedAt: Date | null = null) {
      await db.insert(agentApiKeys).values({
        agentId: agentIdForKey,
        companyId,
        name: "bridge",
        keyHash: `hash-${randomUUID()}`,
        scopeConfig: { kind: "task_bridge", projectId: randomUUID() } as never,
        createdAt,
        revokedAt,
      });
    }
    // The owner gave the agent a task bridge key ten days ago; another agent
    // held one from 100 to 50 days ago.
    const bridgeAgentId = await insertAgent("Hermes bridge");
    const bridgeKeyCreatedAt = ago(10 * day);
    await insertBridgeKey(bridgeAgentId, bridgeKeyCreatedAt);
    const formerBridgeAgentId = await insertAgent("Former bridge");
    await insertBridgeKey(formerBridgeAgentId, ago(100 * day), ago(50 * day));

    async function insertRoutine(input: { createdByAgentId?: string; createdAt: Date }) {
      const id = randomUUID();
      await db.insert(routines).values({
        id,
        companyId,
        title: "Routine",
        assigneeAgentId: agentId,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByAgentId ? null : "owner",
        createdAt: input.createdAt,
      });
      return id;
    }
    let revisionNumber = 1;
    async function insertRevision(routineId: string, createdByAgentId: string, createdAt: Date) {
      await db.insert(routineRevisions).values({
        companyId,
        routineId,
        revisionNumber: revisionNumber++,
        title: "Routine",
        snapshot: {} as never,
        createdByAgentId,
        createdAt,
      });
    }
    async function routineDispatch(input: {
      routineId: string;
      source: "manual" | "schedule" | "api";
      triggeredAt?: Date;
      triggerId?: string;
      createdByAgentId?: string;
      trigger?: { agentId: string; at: Date };
    }) {
      const routineRunId = randomUUID();
      await db.insert(routineRuns).values({
        id: routineRunId,
        companyId,
        routineId: input.routineId,
        triggerId: input.triggerId ?? null,
        source: input.source,
        triggeredAt: input.triggeredAt ?? new Date(),
      });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Routine ${input.source}`,
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "routine_execution",
        originId: input.routineId,
        originRunId: routineRunId,
        originFingerprint: randomUUID(),
        createdByAgentId: input.createdByAgentId ?? null,
      } as never);
      if (input.trigger) {
        await db.insert(activityLog).values({
          companyId,
          actorType: "agent",
          actorId: input.trigger.agentId,
          agentId: input.trigger.agentId,
          action: "routine.run_triggered",
          entityType: "routine_run",
          entityId: routineRunId,
          details: { routineId: input.routineId, source: input.source, status: "issue_created" },
          createdAt: input.trigger.at,
        });
      }
      const runId = randomUUID();
      await wake({
        companyId,
        agentId,
        runId,
        requestedByActorType: "system",
        requestedByActorId: "recovery",
        payload: { issueId, mutation: "create" },
      });
      return resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: runId, companyId, contextSnapshot: { issueId, source: "routine.dispatch" } },
        issueId,
      });
    }

    // A routine the agent created, edited, or scheduled long before it got a
    // task bridge key keeps running on schedule.
    const earlyRoutineId = await insertRoutine({ createdByAgentId: bridgeAgentId, createdAt: ago(200 * day) });
    await insertRevision(earlyRoutineId, bridgeAgentId, ago(200 * day));
    const earlyTriggerId = randomUUID();
    await db.insert(routineTriggers).values({
      id: earlyTriggerId,
      companyId,
      routineId: earlyRoutineId,
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      createdByAgentId: bridgeAgentId,
      createdAt: ago(200 * day),
    });
    await expect(
      routineDispatch({ routineId: earlyRoutineId, source: "schedule", triggerId: earlyTriggerId }),
    ).resolves.toBeNull();
    // So does one another agent authored while it held a key it no longer holds,
    // before and after that window.
    await expect(
      routineDispatch({
        routineId: await insertRoutine({ createdByAgentId: formerBridgeAgentId, createdAt: ago(200 * day) }),
        source: "schedule",
      }),
    ).resolves.toBeNull();
    await expect(
      routineDispatch({
        routineId: await insertRoutine({ createdByAgentId: formerBridgeAgentId, createdAt: ago(20 * day) }),
        source: "schedule",
      }),
    ).resolves.toBeNull();
    // Runs started before the key existed: a manual run the agent started, an
    // api run whose trigger row names the agent, and an api run that names no
    // one (a pipeline stage entry) while some agent now holds a live key.
    const ownerRoutineId = await insertRoutine({ createdAt: ago(300 * day) });
    await expect(
      routineDispatch({
        routineId: ownerRoutineId,
        source: "manual",
        triggeredAt: ago(200 * day),
        createdByAgentId: bridgeAgentId,
      }),
    ).resolves.toBeNull();
    await expect(
      routineDispatch({
        routineId: ownerRoutineId,
        source: "api",
        triggeredAt: ago(200 * day),
        trigger: { agentId: bridgeAgentId, at: ago(200 * day) },
      }),
    ).resolves.toBeNull();
    await expect(
      routineDispatch({ routineId: ownerRoutineId, source: "api", triggeredAt: ago(200 * day) }),
    ).resolves.toBeNull();

    // Refused: the routine was created, edited or run while the key was live.
    await expect(
      routineDispatch({
        routineId: await insertRoutine({ createdByAgentId: bridgeAgentId, createdAt: ago(day) }),
        source: "schedule",
      }),
    ).resolves.toMatchObject({ kind: "task_bridge" });
    await expect(
      routineDispatch({
        routineId: await insertRoutine({ createdByAgentId: formerBridgeAgentId, createdAt: ago(75 * day) }),
        source: "schedule",
      }),
    ).resolves.toMatchObject({ kind: "task_bridge" });
    const editedRoutineId = await insertRoutine({ createdByAgentId: bridgeAgentId, createdAt: ago(200 * day) });
    await insertRevision(editedRoutineId, bridgeAgentId, ago(day));
    await expect(routineDispatch({ routineId: editedRoutineId, source: "schedule" })).resolves.toMatchObject({
      kind: "task_bridge",
    });
    await expect(
      routineDispatch({ routineId: ownerRoutineId, source: "manual", createdByAgentId: bridgeAgentId }),
    ).resolves.toMatchObject({ kind: "task_bridge" });
    await expect(routineDispatch({ routineId: ownerRoutineId, source: "api" })).resolves.toMatchObject({
      kind: "task_bridge",
    });
    // A key counts from shortly before its created_at, since some of the times
    // checked against it come from the server clock rather than the database's.
    await expect(
      routineDispatch({
        routineId: await insertRoutine({
          createdByAgentId: bridgeAgentId,
          createdAt: new Date(bridgeKeyCreatedAt.getTime() - 60_000),
        }),
        source: "schedule",
      }),
    ).resolves.toMatchObject({ kind: "task_bridge" });

    // The wake rule does not bound a key by its creation: an agent-requested
    // wake is recent when its run starts, so it stays refused.
    const ownerIssueId = await originIssue({ companyId, agentId, originKind: "manual" });
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      requestedByActorType: "agent",
      requestedByActorId: bridgeAgentId,
      payload: { issueId: ownerIssueId, mutation: "update" },
      runId,
      requestedAt: ago(11 * day),
    });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: runId, companyId, contextSnapshot: { issueId: ownerIssueId } },
        issueId: ownerIssueId,
      }),
    ).resolves.toMatchObject({ kind: "task_bridge" });
  });

  it("allows routine runs without a recorded trigger while no task bridge key is live", async () => {
    const { companyId, agentId } = await insertCompany();
    const bridgeAgentId = randomUUID();
    await db.insert(agents).values({
      id: bridgeAgentId,
      companyId,
      name: "Former bridge",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentApiKeys).values({
      agentId: bridgeAgentId,
      companyId,
      name: "key",
      keyHash: `hash-${randomUUID()}`,
      scopeConfig: { kind: "task_bridge", projectId: randomUUID() } as never,
      revokedAt: new Date(Date.now() - 60_000),
    });
    const routineId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, title: "Pipeline stage", assigneeAgentId: agentId });
    // A pipeline stage entry runs its routine with source api and no
    // routine.run_triggered row.
    const routineRunId = randomUUID();
    await db.insert(routineRuns).values({ id: routineRunId, companyId, routineId, source: "api" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pipeline stage",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: routineRunId,
      originFingerprint: randomUUID(),
    } as never);
    const runId = randomUUID();
    await wake({ companyId, agentId, runId, payload: { issueId, mutation: "create" } });
    await expect(
      resolveClaudeSubscriptionTriggerViolation(db, {
        run: { id: runId, companyId, contextSnapshot: { issueId, source: "routine.dispatch" } },
        issueId,
      }),
    ).resolves.toBeNull();
  });
});
