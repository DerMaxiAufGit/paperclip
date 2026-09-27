import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  authUsers,
  chatActions,
  chatDeliveries,
  chatExternalPrincipals,
  chatIdentityLinks,
  companyMemberships,
  instanceUserRoles,
  issues,
  plugins,
  routineRuns,
  type Db,
} from "@paperclipai/db";
import {
  CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE,
  CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE,
  DEPLOYMENT_MODES,
  type DeploymentMode,
} from "@paperclipai/shared";
import { readConfigFile } from "../config-file.js";

/**
 * Who may use the Claude subscription lane.
 *
 * The subscription lane is a claude_local run on this server with no API
 * credential: the official `claude` CLI runs as the user Paperclip runs as and
 * uses that user's own Claude sign-in (see `isClaudeSubscriptionLaneRun` in
 * the claude-local adapter). Anthropic's terms allow that sign-in only for the
 * owner's own use, so this module holds the two server-side gates:
 *
 * 1. Owner only. The lane is allowed when the deployment mode is
 *    `local_trusted` (loopback, single operator by construction), or when the
 *    mode is `authenticated` and the whole instance has at most one active
 *    human user account. Agents and the synthetic `local-board` principal do
 *    not count.
 * 2. Trigger source. Even for the owner, a run whose wake came from outside
 *    Paperclip is refused: a chat message from a person not linked to the
 *    Paperclip user the wake is attributed to (including a GitHub review of a
 *    guest's pull request, or one an unlinked GitHub account pushed or
 *    reopened), an inbound email, a plugin (agents.invoke, agent sessions,
 *    plugin issue wakeups, plugin-relayed comments, interactions and approval
 *    decisions, which is also how plugin webhooks reach agents), or a routine's
 *    public webhook trigger. A system follow-up wake (recovery, liveness
 *    dispatch) on a task that one of these created is refused too, unless a
 *    Paperclip user requested the wake outside chat.
 */

export const CLAUDE_SUBSCRIPTION_NOT_ALLOWED_REASON = "subscription_not_allowed" as const;
export const CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_REASON = "claude_subscription_external_trigger" as const;

/** The synthetic board principal of a `local_trusted` instance. It is not a person. */
const LOCAL_BOARD_USER_ID = "local-board";

let registeredDeploymentMode: DeploymentMode | null = null;

/**
 * Record the deployment mode the server runs in. The server calls this once at
 * startup, after its config is final. Services that are constructed without the
 * config (the heartbeat is built in many places) read it from here.
 */
export function setClaudeSubscriptionDeploymentMode(mode: DeploymentMode | null): void {
  registeredDeploymentMode = mode;
}

function isDeploymentMode(value: unknown): value is DeploymentMode {
  return typeof value === "string" && (DEPLOYMENT_MODES as readonly string[]).includes(value);
}

/**
 * The deployment mode: the registered one, else the same sources the server
 * config reads (env, then config file), else the config default.
 */
export function resolveClaudeSubscriptionDeploymentMode(): DeploymentMode {
  if (registeredDeploymentMode) return registeredDeploymentMode;
  const fromEnv = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  if (isDeploymentMode(fromEnv)) return fromEnv;
  try {
    const fromFile = readConfigFile()?.server.deploymentMode;
    if (isDeploymentMode(fromFile)) return fromFile;
  } catch {
    // An unreadable config file fails server startup on its own; the default
    // below matches the server config default.
  }
  return "local_trusted";
}

/**
 * Count the instance's active human user accounts, up to `limit`. A human user
 * is an auth user (not the synthetic `local-board` principal) that holds an
 * instance role or an active company membership. Agents are not auth users.
 * A signed-up account with no role and no active membership cannot use the
 * instance, so it does not count.
 */
export async function countActiveHumanUsers(db: Db, limit = 2): Promise<number> {
  const rows = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(
      and(
        ne(authUsers.id, LOCAL_BOARD_USER_ID),
        or(
          sql`exists (select 1 from ${instanceUserRoles} where ${instanceUserRoles.userId} = ${authUsers.id})`,
          sql`exists (select 1 from ${companyMemberships} where ${companyMemberships.principalType} = 'user' and ${companyMemberships.principalId} = ${authUsers.id} and ${companyMemberships.status} = 'active')`,
        ),
      ),
    )
    .limit(limit);
  return rows.length;
}

export type ClaudeSubscriptionEligibility =
  | { allowed: true }
  | {
      allowed: false;
      reason: typeof CLAUDE_SUBSCRIPTION_NOT_ALLOWED_REASON;
      message: string;
    };

/**
 * Whether this instance may use the Claude subscription lane at all (gate 1).
 *
 * Decided differently from "exactly one": an `authenticated` instance with no
 * human user yet (nobody has claimed the board) is allowed too, since nobody but
 * the server operator can use it.
 */
export async function resolveClaudeSubscriptionEligibility(
  db: Db,
  options: { deploymentMode?: DeploymentMode } = {},
): Promise<ClaudeSubscriptionEligibility> {
  const mode = options.deploymentMode ?? resolveClaudeSubscriptionDeploymentMode();
  if (mode === "local_trusted") return { allowed: true };
  const humanUsers = await countActiveHumanUsers(db, 2);
  if (humanUsers <= 1) return { allowed: true };
  return {
    allowed: false,
    reason: CLAUDE_SUBSCRIPTION_NOT_ALLOWED_REASON,
    message: CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE,
  };
}

export type ClaudeSubscriptionExternalTriggerKind = "chat_guest" | "email" | "plugin" | "routine_webhook";

export interface ClaudeSubscriptionTriggerViolation {
  reason: typeof CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_REASON;
  kind: ClaudeSubscriptionExternalTriggerKind;
  message: string;
}

/** Message sources that mark a wake a plugin started (see plugin-host-services). */
const PLUGIN_AGENT_MESSAGE_SOURCES = new Set(["plugin_invoke", "plugin_session"]);

/**
 * The requester id and reason of an inbound email wake (see email-channels).
 * Anyone can send an email to an agent's inbox, so it is always external.
 */
const EMAIL_WAKE_ACTOR_ID = "agentmail";
const EMAIL_WAKE_REASON = "email_received";

/** originId prefixes of the tasks an email conversation creates (inbound and outbound). */
const EMAIL_ISSUE_ORIGIN_ID_PREFIXES = ["email:", "email-send:"];

/**
 * Plugin wake sources: `plugin.issue.requestWakeup(s)` for plugin issue
 * wakeups, and `plugin:<pluginKey>…` for comments, interaction responses and
 * approval decisions a plugin relays on behalf of a user.
 */
function isPluginSource(source: string | null): boolean {
  return source !== null && (source.startsWith("plugin.") || source.startsWith("plugin:"));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

interface WakeRequestFacts {
  id: string;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
}

/** Context and payload markers a plugin-started wake always carries. */
function hasPluginMarker(context: Record<string, unknown>, wakes: WakeRequestFacts[]): boolean {
  const agentMessageSource = readString(asRecord(context.paperclipAgentMessage).source);
  if (agentMessageSource && PLUGIN_AGENT_MESSAGE_SOURCES.has(agentMessageSource)) return true;
  if (isPluginSource(readString(context.source))) return true;
  return wakes.some(
    (wake) =>
      readString(wake.payload.pluginId) !== null ||
      wake.payload.mutation === "plugin_wakeup" ||
      isPluginSource(readString(wake.payload.contextSource)),
  );
}

/** An inbound email wake, or a run whose context names an email endpoint. */
function hasEmailMarker(context: Record<string, unknown>, wakes: WakeRequestFacts[], userRequested: boolean): boolean {
  const emailWake = wakes.some(
    (wake) =>
      (wake.requestedByActorType === "system" && wake.requestedByActorId === EMAIL_WAKE_ACTOR_ID) ||
      wake.reason === EMAIL_WAKE_REASON,
  );
  if (emailWake) return true;
  return readString(context.emailEndpointId) !== null && !userRequested;
}

/**
 * Chat actions whose id is the id of the wake request they started (see
 * durable-chat-wakeup): a chat message's wake, and a board retry of a failed
 * chat run, which replays the original messages with their attribution.
 */
const CHAT_WAKE_ACTION_KINDS = ["inbound_wakeup", "failed_run_retry"];

/** A provider account id; GitHub ids can arrive as numbers. */
function readExternalId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return readString(value);
}

/** The deliveries a failed-run retry replays; null for an entry that names none. */
function retrySourceDeliveryIds(payload: Record<string, unknown>): Array<string | null> {
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  return sources.map((source) => {
    const deliveryId = readString(asRecord(source).deliveryId);
    return deliveryId && UUID_RE.test(deliveryId) ? deliveryId : null;
  });
}

interface ChatDeliveryFacts {
  endpointId: string;
  principalId: string | null;
  normalizedEvent: Record<string, unknown>;
}

/** A chat wake attributed to `userId`: each chat account in it must be linked to that user. */
interface ChatWakeLinkCheck {
  endpointId: string;
  userId: string;
  principalId: string;
  githubAccountIds: string[];
}

/**
 * The chat wakes among a run's wake requests, and whether any of them came
 * from outside the owner.
 *
 * chat-channels attributes a chat message's wake to a Paperclip user when the
 * message's chat account is linked to that user, but not only then: a GitHub
 * automatic review is attributed to the configured responsible user, whoever
 * authored the pull request or pushed to it. So the attribution alone does not
 * show who sent the message. A chat wake is external unless it is attributed
 * to a Paperclip user and its chat account has a confirmed link to that same
 * user on the endpoint; for a GitHub automatic review, both the pull request's
 * author and the event's sender must have one. A delivery chat-channels marked
 * as a guest's, and a delivery that is missing or no longer matches its action,
 * are external too.
 */
async function resolveChatWakes(
  db: Db,
  companyId: string,
  wakeIds: string[],
): Promise<{ ids: Set<string>; external: boolean }> {
  if (wakeIds.length === 0) return { ids: new Set(), external: false };
  const actions = await db
    .select({
      id: chatActions.id,
      kind: chatActions.kind,
      endpointId: chatActions.endpointId,
      principalId: chatActions.principalId,
      payload: chatActions.payload,
      deliveryId: chatDeliveries.id,
      deliveryEndpointId: chatDeliveries.endpointId,
      deliveryPrincipalId: chatDeliveries.principalId,
      normalizedEvent: chatDeliveries.normalizedEvent,
    })
    .from(chatActions)
    .leftJoin(
      chatDeliveries,
      and(eq(chatDeliveries.companyId, chatActions.companyId), eq(chatDeliveries.id, chatActions.deliveryId)),
    )
    .where(
      and(
        eq(chatActions.companyId, companyId),
        inArray(chatActions.id, wakeIds),
        inArray(chatActions.kind, CHAT_WAKE_ACTION_KINDS),
      ),
    );
  const ids = new Set(actions.map((action) => action.id));
  if (actions.length === 0) return { ids, external: false };
  const external = { ids, external: true };

  const retryDeliveryIds = [
    ...new Set(
      actions
        .filter((action) => action.kind === "failed_run_retry")
        .flatMap((action) => retrySourceDeliveryIds(asRecord(action.payload)))
        .filter((id): id is string => id !== null),
    ),
  ];
  const retryDeliveries = new Map<string, ChatDeliveryFacts>(
    retryDeliveryIds.length === 0
      ? []
      : (
          await db
            .select({
              id: chatDeliveries.id,
              endpointId: chatDeliveries.endpointId,
              principalId: chatDeliveries.principalId,
              normalizedEvent: chatDeliveries.normalizedEvent,
            })
            .from(chatDeliveries)
            .where(and(eq(chatDeliveries.companyId, companyId), inArray(chatDeliveries.id, retryDeliveryIds)))
        ).map((row) => [row.id, row]),
  );

  const checks: ChatWakeLinkCheck[] = [];
  for (const action of actions) {
    const payload = asRecord(action.payload);
    // A message from an unlinked person is attributed to its chat account (a
    // system wake), never to a Paperclip user.
    const userId = payload.requestedByActorType === "user" ? readString(payload.requestedByActorId) : null;
    if (!userId || !action.principalId) return external;
    const deliveries: Array<ChatDeliveryFacts | null> =
      action.kind === "inbound_wakeup"
        ? [
            action.deliveryId && action.deliveryEndpointId && action.normalizedEvent
              ? {
                  endpointId: action.deliveryEndpointId,
                  principalId: action.deliveryPrincipalId,
                  normalizedEvent: action.normalizedEvent,
                }
              : null,
          ]
        : retrySourceDeliveryIds(payload).map((id) => (id ? (retryDeliveries.get(id) ?? null) : null));
    if (deliveries.length === 0) return external;
    const githubAccountIds: string[] = [];
    for (const delivery of deliveries) {
      if (!delivery || delivery.endpointId !== action.endpointId || delivery.principalId !== action.principalId) {
        return external;
      }
      const event = asRecord(delivery.normalizedEvent);
      if (asRecord(event.githubAuthority).guest === true) return external;
      if (event.githubAutomatic !== undefined) {
        const context = asRecord(asRecord(event.githubAutomatic).context);
        const authorId = readExternalId(asRecord(context.author).id);
        const senderId = readExternalId(asRecord(context.sender).id);
        if (!authorId || !senderId) return external;
        githubAccountIds.push(authorId, senderId);
      }
    }
    checks.push({ endpointId: action.endpointId, userId, principalId: action.principalId, githubAccountIds });
  }

  const principalIds = [...new Set(checks.map((check) => check.principalId))];
  const githubAccountIds = [...new Set(checks.flatMap((check) => check.githubAccountIds))];
  const principalFilter = inArray(chatIdentityLinks.principalId, principalIds);
  const links = await db
    .select({
      endpointId: chatIdentityLinks.endpointId,
      principalId: chatIdentityLinks.principalId,
      userId: chatIdentityLinks.paperclipUserId,
      provider: chatExternalPrincipals.provider,
      externalId: chatExternalPrincipals.externalId,
    })
    .from(chatIdentityLinks)
    .innerJoin(
      chatExternalPrincipals,
      and(
        eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId),
        eq(chatExternalPrincipals.id, chatIdentityLinks.principalId),
      ),
    )
    .where(
      and(
        eq(chatIdentityLinks.companyId, companyId),
        eq(chatIdentityLinks.status, "linked"),
        inArray(chatIdentityLinks.endpointId, [...new Set(checks.map((check) => check.endpointId))]),
        githubAccountIds.length > 0
          ? or(
              principalFilter,
              and(
                eq(chatExternalPrincipals.provider, "github"),
                inArray(chatExternalPrincipals.externalId, githubAccountIds),
              ),
            )
          : principalFilter,
      ),
    );
  const linkedTo = (check: ChatWakeLinkCheck, matches: (link: (typeof links)[number]) => boolean) =>
    links.some((link) => link.endpointId === check.endpointId && link.userId === check.userId && matches(link));
  for (const check of checks) {
    if (!linkedTo(check, (link) => link.principalId === check.principalId)) return external;
    for (const accountId of check.githubAccountIds) {
      if (!linkedTo(check, (link) => link.provider === "github" && link.externalId === accountId)) return external;
    }
  }
  return { ids, external: false };
}

/**
 * Whether a run's wake came from outside the owner (gate 2). Reads the wake
 * requests recorded for the run (the one that created it and any coalesced into
 * it), the chat messages behind them, the run's context snapshot, and the
 * origin of the run's task (for a routine task, the routine run that created
 * it). Returns null for owner-driven wakes: assignments and comments by a
 * Paperclip user, timers and heartbeats, scheduled routines, agent delegation,
 * and chat messages from accounts linked to the user the wake is attributed to.
 *
 * A system or agent wake on a task that came from outside Paperclip (a plugin's
 * task, an email conversation, a chat conversation an unlinked person started,
 * or a routine's public webhook) is refused, because such a wake (for example
 * the recovery liveness dispatch of a stranded task) only continues the
 * outside trigger. A wake a Paperclip user requested outside chat is
 * owner-driven. A chat wake is checked against the task's origin even when it
 * is attributed to a user, since chat-channels attributes some wakes to a
 * responsible user rather than to the person who wrote the message.
 */
export async function resolveClaudeSubscriptionTriggerViolation(
  db: Db,
  input: {
    run: {
      id: string;
      companyId: string;
      wakeupRequestId?: string | null;
      contextSnapshot?: Record<string, unknown> | null;
    };
    issueId?: string | null;
  },
): Promise<ClaudeSubscriptionTriggerViolation | null> {
  const context = asRecord(input.run.contextSnapshot);
  // A durable chat receipt coalesced into a deferred wake names that wake in
  // its payload instead of carrying a run id.
  const wakeFilter = input.run.wakeupRequestId
    ? or(
        eq(agentWakeupRequests.runId, input.run.id),
        eq(agentWakeupRequests.id, input.run.wakeupRequestId),
        sql`${agentWakeupRequests.payload}->>'coalescedIntoWakeupRequestId' = ${input.run.wakeupRequestId}`,
      )
    : eq(agentWakeupRequests.runId, input.run.id);
  const wakes: WakeRequestFacts[] = (
    await db
      .select({
        id: agentWakeupRequests.id,
        requestedByActorType: agentWakeupRequests.requestedByActorType,
        requestedByActorId: agentWakeupRequests.requestedByActorId,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, input.run.companyId), wakeFilter))
  ).map((row) => ({
    id: row.id,
    requestedByActorType: row.requestedByActorType ?? null,
    requestedByActorId: row.requestedByActorId ?? null,
    reason: row.reason ?? null,
    payload: asRecord(row.payload),
  }));

  const violation = (kind: ClaudeSubscriptionExternalTriggerKind): ClaudeSubscriptionTriggerViolation => ({
    reason: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_REASON,
    kind,
    message: CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE,
  });

  if (hasPluginMarker(context, wakes)) return violation("plugin");

  const chatWakes = await resolveChatWakes(db, input.run.companyId, wakes.map((wake) => wake.id));
  const userRequested = wakes.some((wake) => wake.requestedByActorType === "user" && !chatWakes.ids.has(wake.id));

  if (hasEmailMarker(context, wakes, userRequested)) return violation("email");
  if (chatWakes.external) return violation("chat_guest");

  // A system-requested wake names its requester by id. Plugins request wakes
  // with their plugin id; an unlinked chat guest's wake carries the id of the
  // guest's external chat principal.
  const systemActorIds = [
    ...new Set(
      wakes
        .filter((wake) => wake.requestedByActorType === "system")
        .map((wake) => wake.requestedByActorId)
        .filter((id): id is string => typeof id === "string" && UUID_RE.test(id)),
    ),
  ];
  if (systemActorIds.length > 0) {
    const pluginRows = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(inArray(plugins.id, systemActorIds))
      .limit(1);
    if (pluginRows.length > 0) return violation("plugin");
    const principalRows = await db
      .select({ id: chatExternalPrincipals.id })
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, input.run.companyId),
          inArray(chatExternalPrincipals.id, systemActorIds),
        ),
      )
      .limit(1);
    if (principalRows.length > 0) return violation("chat_guest");
  }

  // The origin of the run's task. A plugin's task, an email conversation, a
  // chat conversation an unlinked person started, and a task a routine's public
  // webhook created all come from outside Paperclip; a system or agent wake on
  // them (such as the recovery liveness dispatch) only continues that trigger.
  // A later wake by a Paperclip user (the owner commenting on the task) is
  // owner-driven and allowed.
  const issueId = readString(input.issueId) ?? readString(context.issueId);
  if (issueId && UUID_RE.test(issueId) && !userRequested) {
    const origin = await db
      .select({
        originKind: issues.originKind,
        originId: issues.originId,
        originRunId: issues.originRunId,
        sourceTrust: issues.sourceTrust,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, input.run.companyId)))
      .then((rows) => rows[0] ?? null);
    const originKind = readString(origin?.originKind);
    if (originKind?.startsWith("plugin:")) return violation("plugin");
    if (originKind === "chat_channel") {
      const originId = readString(origin?.originId) ?? "";
      if (EMAIL_ISSUE_ORIGIN_ID_PREFIXES.some((prefix) => originId.startsWith(prefix))) return violation("email");
      // chat-channels marks a conversation an unlinked person started as low trust.
      if (origin?.sourceTrust) return violation("chat_guest");
    }
    const originRunId = readString(origin?.originRunId);
    if (originKind === "routine_execution" && originRunId && UUID_RE.test(originRunId)) {
      const routineRun = await db
        .select({ source: routineRuns.source })
        .from(routineRuns)
        .where(and(eq(routineRuns.id, originRunId), eq(routineRuns.companyId, input.run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (routineRun?.source === "webhook") return violation("routine_webhook");
    }
  }

  return null;
}
