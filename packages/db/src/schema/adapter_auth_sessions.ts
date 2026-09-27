import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import type { AdapterAuthSessionInternalStatus, AgentAdapterType } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

// The state set of the login-session table. The table serves the device-login
// flows only: the Codex (`codex_local`) and Grok (`grok_local`) CLI logins, in a
// sandbox or on the server itself. Claude subscriptions never use this table: a
// Claude subscription runs only through the `claude` CLI signed in on the
// server, and Paperclip never captures a Claude sign-in
// (doc/plans/2026-09-24-claude-cli-only-auth.md).
//
// The active states hold the company credential slot for one company, owner, and
// adapter. The partial unique index applies to the active states only.
//   - `starting`, `waiting_for_user`, `promoting`: the device-login active states.
// The non-active states do not hold the slot:
//   - `authenticated`: the device-login terminal success state.
//   - `cleanup_pending`: the terminal state whose sandbox delete failed.
//   - `failed`, `timed_out`, `cancelled`: the terminal failure states.
//
// Legacy values of the removed Claude `claude setup-token` flow. No current flow
// writes them, and migration 0282 deleted every Claude login row. They stay in
// the union and in the partial unique index so the column type and the index
// definition do not change:
//   - `awaiting_code`, `submitting`: the former setup-token active states.
//   - `stored`: the former one-time setup-token claim, consumed through
//     `bound_at`.
//   - `completed`: the former setup-token terminal success state.
// The dead `persisting` state of the earlier login unions is not in the set.
export type AdapterAuthSessionState =
  | AdapterAuthSessionInternalStatus
  | "awaiting_code"
  | "submitting"
  | "stored"
  | "completed";

// The active states of the set. The partial unique index and the store use this
// list. The list excludes every terminal state. `awaiting_code` and
// `submitting` are legacy setup-token values (see above); they stay so the list
// keeps matching the index predicate.
export const ADAPTER_AUTH_SESSION_ACTIVE_STATES = [
  "starting",
  "waiting_for_user",
  "promoting",
  "awaiting_code",
  "submitting",
] as const satisfies readonly AdapterAuthSessionState[];

// The durable store for a device-login session. One row tracks one login
// attempt for one adapter in one environment. The row keeps the owner principal,
// the public session id, the provider lease reference, the status, and the
// finish times. The row never stores the prompt, a credential byte, or the raw
// provider secret.
export const adapterAuthSessions = pgTable(
  "adapter_auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    aiConnection: jsonb("ai_connection").$type<import("@paperclipai/shared").AiConnectionLoginIntent>(),
    connectionId: uuid("connection_id"),
    connectionGrantId: uuid("connection_grant_id"),
    connectionMethod: text("connection_method"),
    adapterType: text("adapter_type").$type<AgentAdapterType>().notNull(),
    // The immutable owner principal. The service sets this column one time at
    // create and never updates it. The service returns the prompt only to this
    // owner. The active-slot index includes this column, so the column stays
    // non-null; a null owner escapes a partial unique index.
    startedByUserId: text("started_by_user_id").notNull(),
    // The opaque public session id. The public API returns this id, and the
    // store keys its lookups by it. The column is non-null, length-bounded, and
    // unique. The store fills it at create with a CSPRNG value.
    publicSessionId: varchar("public_session_id", { length: 128 }).notNull(),
    // The provider lease reference for the sandbox. The reaper reads it to retry
    // a failed sandbox delete. It is not a public field.
    providerLeaseId: text("provider_lease_id"),
    // The login state. The column is `text`, so it stores every value of the
    // `AdapterAuthSessionState` set, the legacy setup-token values included. The
    // compile-time `$type` is that union.
    status: text("status").$type<AdapterAuthSessionState>().notNull().default("starting"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // The promotion claim deadline. The service sets this column when it moves the
    // row to `promoting`. While the deadline is in the future, the claim is live,
    // so the reaper does not terminate the session or release the company slot.
    // A null or past deadline means no live claim, so the reaper can reclaim a
    // stalled `promoting` row. The service clears the column on every terminal
    // transition.
    promotionExpiresAt: timestamp("promotion_expires_at", { withTimezone: true }),
    // Legacy: the claim-consumption marker of a `stored` row from the removed
    // Claude setup-token flow. No current flow writes it, and a device-login row
    // never sets it. The column stays so the table shape does not change.
    boundAt: timestamp("bound_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // The fixed, non-secret failure code. The public response reads it.
    failureReason: text("failure_reason"),
    // The non-secret result claim of a terminal success, written in the SAME
    // conditional write that records the terminal status, so a claim can never
    // exist for a session that did not authenticate and a restart never loses
    // it. For a Codex device login this holds the account-binding claim: the
    // opaque company secret id that names the login's account home, and
    // whether the company default home stayed on a different account. Never a
    // credential byte, never an account identifier. Null for every failure
    // and for flows that produce no claim.
    resultClaim: jsonb("result_claim").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("adapter_auth_sessions_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    // Serialize on the company credential slot. Only one active session can hold
    // the slot per company, owner, and adapter. The index applies to the active
    // states, the legacy setup-token ones included. It does not include the
    // environment; the board rule scopes the slot to the owner, not the
    // environment.
    companyOwnerAdapterActiveUq: uniqueIndex("adapter_auth_sessions_company_owner_adapter_active_uq")
      .on(table.companyId, table.startedByUserId, table.adapterType)
      .where(
        sql`${table.status} IN ('starting', 'waiting_for_user', 'promoting', 'awaiting_code', 'submitting')`,
      ),
    // The public session id is unique across the table. The store keys its
    // lookups by this id.
    publicSessionIdUq: uniqueIndex("adapter_auth_sessions_public_session_id_uq").on(
      table.publicSessionId,
    ),
    environmentIdx: index("adapter_auth_sessions_environment_idx").on(table.environmentId),
    expiresIdx: index("adapter_auth_sessions_expires_idx").on(table.expiresAt),
    providerLeaseIdx: index("adapter_auth_sessions_provider_lease_idx").on(table.providerLeaseId),
  }),
);
