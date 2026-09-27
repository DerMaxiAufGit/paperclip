import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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
  plugins,
  routineRuns,
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

    // A linked user's chat message does not lift the origin check: a chat
    // conversation an unlinked person started stays external.
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
});
