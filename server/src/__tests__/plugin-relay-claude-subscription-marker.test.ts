import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Capture the wakes the plugin relays request; the run bookkeeping below
// replays them the way the heartbeat records a queued run and a later
// coalesced wake.
const mockWakeup = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/heartbeat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/heartbeat.js")>()),
  heartbeatService: () => ({ wakeup: mockWakeup }),
}));

import { mergeCoalescedContextSnapshot } from "../services/heartbeat.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { resolveClaudeSubscriptionTriggerViolation } from "../services/claude-subscription-policy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type CapturedWake = {
  source: string;
  triggerDetail: string;
  reason: string;
  payload: Record<string, unknown>;
  requestedByActorType: "user";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
};

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as never;
}

describeEmbeddedPostgres("plugin-relayed wakes keep their plugin marker through coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const pluginId = randomUUID();
  const pluginKey = "paperclip.gateway";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-relay-marker-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    mockWakeup.mockClear();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
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
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs the owner",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const services = buildHostServices(db, pluginId, pluginKey, createEventBusStub());
    return { companyId, agentId, ownerUserId, issueId, services };
  }

  function capturedWake(agentId: string): CapturedWake {
    expect(mockWakeup).toHaveBeenCalledTimes(1);
    const [wokenAgentId, wake] = mockWakeup.mock.calls[0] as unknown as [string, CapturedWake];
    expect(wokenAgentId).toBe(agentId);
    // The plugin attributes the wake to the paired user, and only the context
    // source names the plugin.
    expect(wake.requestedByActorType).toBe("user");
    expect(String(wake.contextSnapshot.source)).toMatch(/^plugin:/);
    return wake;
  }

  /**
   * Record the relay's wake as the one that created a queued run, then let a
   * later scheduler wake coalesce into that run, as the heartbeat does: the
   * run's context is merged (the later source wins) and the later wake is
   * recorded against the same run.
   */
  async function triggerViolationAfterLaterWake(input: {
    companyId: string;
    agentId: string;
    wake: CapturedWake;
    laterContext: Record<string, unknown>;
  }) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.wake.source,
      triggerDetail: input.wake.triggerDetail,
      reason: input.wake.reason,
      payload: input.wake.payload,
      status: "queued",
      requestedByActorType: input.wake.requestedByActorType,
      requestedByActorId: input.wake.requestedByActorId,
      runId,
    });
    await db.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      payload: null,
      status: "coalesced",
      coalescedCount: 1,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      runId,
    });
    const contextSnapshot = mergeCoalescedContextSnapshot(input.wake.contextSnapshot, input.laterContext, {
      preserveExistingInteractionContinuation: true,
    });
    // The context marker is gone after the merge; only the wake payload can
    // still show the plugin.
    expect(String(contextSnapshot.source)).not.toMatch(/^plugin/);
    return resolveClaudeSubscriptionTriggerViolation(db, {
      run: { id: runId, companyId: input.companyId, wakeupRequestId, contextSnapshot },
      issueId: typeof contextSnapshot.issueId === "string" ? contextSnapshot.issueId : null,
    });
  }

  it("refuses a plugin-relayed comment wake after a later scheduler wake coalesces into its run", async () => {
    const { companyId, agentId, ownerUserId, issueId, services } = await seed();
    await services.issues.createComment({ issueId, companyId, body: "Go ahead", actorUserId: ownerUserId });
    const wake = capturedWake(agentId);
    await expect(
      triggerViolationAfterLaterWake({
        companyId,
        agentId,
        wake,
        laterContext: { issueId, taskId: issueId, wakeReason: "issue_monitor_due", source: "issue.monitor" },
      }),
    ).resolves.toMatchObject({ kind: "plugin" });
  });

  it("refuses a plugin-relayed interaction resolution wake after a later scheduler wake coalesces into its run", async () => {
    const { companyId, agentId, ownerUserId, issueId, services } = await seed();
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Proceed?" } as never,
    });
    const result = await services.issues.respondInteraction({
      issueId,
      interactionId,
      companyId,
      action: "accept",
      actorUserId: ownerUserId,
    });
    expect(result.applied).toBe(true);
    const wake = capturedWake(agentId);
    await expect(
      triggerViolationAfterLaterWake({
        companyId,
        agentId,
        wake,
        laterContext: { issueId, taskId: issueId, wakeReason: "issue_monitor_due", source: "issue.monitor" },
      }),
    ).resolves.toMatchObject({ kind: "plugin" });
  });

  it("refuses a plugin-relayed approval decision wake after a timer wake coalesces into its run", async () => {
    const { companyId, agentId, ownerUserId, services } = await seed();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: agentId,
      payload: { title: "Ship it" },
    });
    const result = await services.approvals.decide({
      approvalId,
      companyId,
      action: "approve",
      actorUserId: ownerUserId,
    });
    expect(result.applied).toBe(true);
    const wake = capturedWake(agentId);
    // An approval wake names no task, so the agent's unscoped timer wake
    // coalesces into its queued run.
    await expect(
      triggerViolationAfterLaterWake({
        companyId,
        agentId,
        wake,
        laterContext: { source: "scheduler", reason: "interval_elapsed", now: new Date().toISOString() },
      }),
    ).resolves.toMatchObject({ kind: "plugin" });
  });
});
