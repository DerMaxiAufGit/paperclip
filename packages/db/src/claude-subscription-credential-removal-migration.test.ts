import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0282_remove_claude_subscription_credentials.sql";
const migrationSql = fs.readFileSync(
  path.join(import.meta.dirname, "migrations", MIGRATION_FILE),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown>;

// Tables the migration may delete from or leave alone. Surviving rows must be
// byte-for-byte unchanged, including updated_at.
const ID_TABLES = [
  "tool_connections",
  "connection_grants",
  "connection_grant_members",
  "connection_grant_delegations",
  "tool_connection_installs",
  "company_secrets",
  "company_secret_versions",
  "company_secret_bindings",
  "company_secret_proposals",
  "user_secret_definitions",
  "user_secret_declarations",
  "ai_connection_defaults",
  "ai_provider_defaults",
  "adapter_auth_sessions",
  "routine_triggers",
  "tool_applications",
] as const;

// Tables whose rows the migration may edit in place.
const EDITED_TABLES = ["agents", "environments", "projects", "routines", "routine_revisions"] as const;

function migrationHash() {
  return createHash("sha256").update(migrationSql).digest("hex");
}

async function snapshotTable(sql: Sql, table: string): Promise<Map<string, Json>> {
  const rows = await sql.unsafe<{ id: string; row: Json }[]>(
    `SELECT t."id"::text AS "id", to_jsonb(t) AS "row" FROM "${table}" t ORDER BY t."id"`,
  );
  return new Map(rows.map((r) => [r.id, r.row]));
}

async function snapshotAll(sql: Sql) {
  const out: Record<string, Map<string, Json>> = {};
  for (const table of [...ID_TABLES, ...EDITED_TABLES]) out[table] = await snapshotTable(sql, table);
  return out;
}

function idIn(ids: ReadonlyArray<string | null>, value: unknown): boolean {
  return ids.includes(String(value));
}

function withoutIds(rows: Map<string, Json>, ids: string[]): Json[] {
  return [...rows.entries()].filter(([id]) => !ids.includes(id)).map(([, row]) => row);
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("claude subscription credential removal migration", () => {
  it("only changes data", () => {
    const statements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .toUpperCase();
    expect(statements).not.toMatch(/\bALTER\s+(TABLE|TYPE)\b/);
    expect(statements).not.toMatch(/\bDROP\s+(COLUMN|TYPE|INDEX|CONSTRAINT)\b/);
    // Every table it drops is a pg_temp work table.
    for (const match of statements.matchAll(/DROP TABLE IF EXISTS ([^;]+);/g)) {
      expect(match[1]).toMatch(/^PG_TEMP\./);
    }
    // Every function it creates or drops lives in pg_temp.
    for (const match of statements.matchAll(/(?:CREATE OR REPLACE|DROP) FUNCTION (?:IF EXISTS )?(\S+)/g)) {
      expect(match[1]).toMatch(/^PG_TEMP\./);
    }
  });
});

describeEmbeddedPostgres("claude subscription credential removal executable migration", () => {
  it(
    "deletes exactly the Claude subscription data and is idempotent",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-claude-sub-removal-migration-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });

      // The database already ran every migration, including this one, on an
      // empty schema. Rewinding its history row replays it over seeded rows.
      async function rewindMigration() {
        await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash()}`;
        expect(await inspectMigrations(database.connectionString)).toMatchObject({
          status: "needsMigrations",
          pendingMigrations: [MIGRATION_FILE],
        });
      }

      const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);

      async function company(label: string) {
        const id = randomUUID();
        await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${id}, ${label}, ${`C${id.slice(0, 5)}`})`;
        return id;
      }
      async function application(companyId: string, provider: string) {
        const id = randomUUID();
        await sql`
          INSERT INTO "tool_applications" ("id", "company_id", "application_key", "name", "type", "metadata")
          VALUES (${id}, ${companyId}, ${`app-gallery:${provider}`}, ${provider}, 'mcp_http', ${json({ sourceTemplateKey: provider })})
        `;
        return id;
      }
      async function agent(companyId: string, adapterType: string, adapterConfig: Json, runtimeConfig: Json) {
        const id = randomUUID();
        await sql`
          INSERT INTO "agents" ("id", "company_id", "name", "adapter_type", "adapter_config", "runtime_config")
          VALUES (${id}, ${companyId}, ${`Agent ${id.slice(0, 8)}`}, ${adapterType}, ${json(adapterConfig)}, ${json(runtimeConfig)})
        `;
        return id;
      }
      async function secret(
        companyId: string,
        input: { key: string; owner?: string; definitionId?: string; providerMetadata?: Json },
      ) {
        const id = randomUUID();
        await sql`
          INSERT INTO "company_secrets" (
            "id", "company_id", "name", "key", "scope", "owner_user_id", "user_secret_definition_id", "provider_metadata"
          ) VALUES (
            ${id}, ${companyId}, ${input.key}, ${input.key},
            ${input.owner ? "user" : "company"}, ${input.owner ?? null}, ${input.definitionId ?? null},
            ${input.providerMetadata ? json(input.providerMetadata) : null}
          )
        `;
        await sql`
          INSERT INTO "company_secret_versions" ("secret_id", "version", "material", "value_sha256", "fingerprint_sha256")
          VALUES (${id}, 1, ${json({ ciphertext: `ct-${id}` })}, ${`sha-${id}`}, ${`fp-${id}`})
        `;
        return id;
      }
      async function definition(companyId: string, key: string) {
        const id = randomUUID();
        await sql`
          INSERT INTO "user_secret_definitions" ("id", "company_id", "key", "name")
          VALUES (${id}, ${companyId}, ${key}, ${key})
        `;
        return id;
      }
      async function declaration(
        companyId: string,
        definitionId: string,
        targetType: string,
        targetId: string,
        configPath: string,
        envKey: string,
      ) {
        const id = randomUUID();
        await sql`
          INSERT INTO "user_secret_declarations" (
            "id", "company_id", "user_secret_definition_id", "target_type", "target_id", "config_path", "env_key"
          ) VALUES (${id}, ${companyId}, ${definitionId}, ${targetType}, ${targetId}, ${configPath}, ${envKey})
        `;
        return id;
      }
      async function binding(companyId: string, secretId: string, targetType: string, targetId: string, configPath: string) {
        const id = randomUUID();
        await sql`
          INSERT INTO "company_secret_bindings" ("id", "company_id", "secret_id", "target_type", "target_id", "config_path")
          VALUES (${id}, ${companyId}, ${secretId}, ${targetType}, ${targetId}, ${configPath})
        `;
        return id;
      }
      /** Mirrors ai-connections.ts save(): connection, grant, credential slot, bindings, default. */
      async function aiConnection(input: {
        companyId: string;
        applicationId: string;
        provider: string;
        method: "subscription" | "api_key";
        ownership: "personal" | "shared";
        userId: string;
        setDefault?: boolean;
      }) {
        const connectionId = randomUUID();
        const grantId = randomUUID();
        await sql`
          INSERT INTO "tool_connections" (
            "id", "company_id", "application_id", "name", "uid", "connection_purpose", "transport",
            "auth_kind", "credential_policy", "status", "enabled", "health_status", "config", "created_by_user_id"
          ) VALUES (
            ${connectionId}, ${input.companyId}, ${input.applicationId}, ${`${input.provider} ${input.method}`},
            ${`ai-${connectionId}`}, 'ai', 'runtime_auth',
            ${input.method === "api_key" ? "api_key" : "oauth"},
            ${input.ownership === "personal" ? "per_user" : "shared"}, 'active', true, 'ok',
            ${json({ sourceTemplateKey: input.provider, ai: { provider: input.provider, method: input.method } })},
            ${input.userId}
          )
        `;
        let definitionId: string | null = null;
        let secretId: string;
        let bindingId: string | null = null;
        let declarationId: string | null = null;
        if (input.ownership === "personal") {
          definitionId = await definition(input.companyId, `ai_${grantId.replaceAll("-", "_")}`);
          secretId = await secret(input.companyId, {
            key: `user-${grantId}`,
            owner: input.userId,
            definitionId,
          });
          declarationId = await declaration(
            input.companyId, definitionId, "tool_connection", connectionId, "ai.credential", "ai.credential",
          );
        } else {
          secretId = await secret(input.companyId, { key: `ai-${grantId}` });
          bindingId = await binding(input.companyId, secretId, "tool_connection", connectionId, "ai.credential");
        }
        await sql`
          INSERT INTO "connection_grants" (
            "id", "company_id", "connection_id", "kind", "subject_user_id", "is_default", "credential_secret_refs", "created_by_user_id"
          ) VALUES (
            ${grantId}, ${input.companyId}, ${connectionId},
            ${input.ownership === "personal" ? "user" : "organization"},
            ${input.ownership === "personal" ? input.userId : null},
            ${input.ownership === "shared"},
            ${json([{ secretId, configPath: "ai.credential", required: true, versionSelector: "latest" }])},
            ${input.userId}
          )
        `;
        if (input.setDefault) {
          // The sync trigger also writes the matching ai_provider_defaults row.
          await sql`
            INSERT INTO "ai_connection_defaults" ("company_id", "user_id", "provider", "method", "grant_id")
            VALUES (${input.companyId}, ${input.userId}, ${input.provider}, ${input.method}, ${grantId})
          `;
        }
        return { connectionId, grantId, secretId, definitionId, bindingId, declarationId };
      }
      async function environment(envVars: Json) {
        const id = randomUUID();
        await sql`INSERT INTO "environments" ("id", "name", "driver", "env_vars") VALUES (${id}, ${`Env ${id.slice(0, 8)}`}, 'ssh', ${json(envVars)})`;
        return id;
      }
      async function authSession(companyId: string, environmentId: string, input: {
        adapterType: string;
        status: string;
        userId: string;
        connectionMethod?: string;
        connectionId?: string;
        grantId?: string;
      }) {
        const id = randomUUID();
        await sql`
          INSERT INTO "adapter_auth_sessions" (
            "id", "company_id", "environment_id", "adapter_type", "started_by_user_id", "public_session_id",
            "status", "connection_method", "connection_id", "connection_grant_id"
          ) VALUES (
            ${id}, ${companyId}, ${environmentId}, ${input.adapterType}, ${input.userId}, ${`pub-${id}`},
            ${input.status}, ${input.connectionMethod ?? null}, ${input.connectionId ?? null}, ${input.grantId ?? null}
          )
        `;
        return id;
      }

      try {
        // ---- Company 1: subscriptions, an Anthropic API key, OpenAI, setup token.
        const c1 = await company("Main");
        const anthropicApp = await application(c1, "anthropic");
        const openaiApp = await application(c1, "openai");
        const env1 = await environment({
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-plain",
          OPENAI_API_KEY: "sk-openai-env",
        });

        const subPersonal = await aiConnection({
          companyId: c1, applicationId: anthropicApp, provider: "anthropic", method: "subscription",
          ownership: "personal", userId: "alice", setDefault: true,
        });
        const subShared = await aiConnection({
          companyId: c1, applicationId: anthropicApp, provider: "anthropic", method: "subscription",
          ownership: "shared", userId: "alice",
        });
        const apiKey = await aiConnection({
          companyId: c1, applicationId: anthropicApp, provider: "anthropic", method: "api_key",
          ownership: "personal", userId: "bob", setDefault: true,
        });
        const openaiSub = await aiConnection({
          companyId: c1, applicationId: openaiApp, provider: "openai", method: "subscription",
          ownership: "personal", userId: "alice", setDefault: true,
        });

        // Fixed CLAUDE_CODE_OAUTH_TOKEN user secret from `claude setup-token`.
        const fixedDefinition = await definition(c1, "CLAUDE_CODE_OAUTH_TOKEN");
        const fixedSecret = await secret(c1, {
          key: "user-claude-oauth-alice",
          owner: "alice",
          definitionId: fixedDefinition,
          providerMetadata: { claudeSetupTokenSessionId: "setup-session-1" },
        });
        // A company secret bound only as the Claude token env var.
        const claudeCompanySecret = await secret(c1, { key: "claude-token" });
        // A company secret bound both as the Claude token and a kept env var.
        const dualSecret = await secret(c1, { key: "anthropic-auth" });
        // A Claude-keyed secret still used by a routine webhook trigger.
        const triggerSecret = await secret(c1, { key: "CLAUDE_CODE_OAUTH_TOKEN" });

        const a1 = await agent(c1, "claude_local", {
          model: "claude-sonnet",
          env: {
            CLAUDE_CODE_OAUTH_TOKEN: { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" },
            OPENAI_API_KEY: { type: "plain", value: "sk-openai" },
          },
        }, {
          heartbeat: { enabled: true },
          aiConnection: {
            provider: "anthropic", method: "subscription", mode: "shared",
            connectionId: subShared.connectionId, grantId: subShared.grantId,
          },
        });
        const a2 = await agent(c1, "claude_local", {
          env: {
            Claude_Code_OAuth_Token: { type: "secret_ref", secretId: claudeCompanySecret, version: "latest" },
            ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: dualSecret, version: "latest" },
          },
        }, { aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } });
        const a3 = await agent(c1, "claude_local", {
          env: {
            ANTHROPIC_AUTH_TOKEN: { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" },
            ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api03-kept" },
          },
        }, { aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } });
        const a4 = await agent(c1, "codex_local", { env: { OPENAI_API_KEY: "sk-openai-inline" } }, {
          aiConnection: {
            provider: "openai", method: "subscription", mode: "shared",
            connectionId: openaiSub.connectionId, grantId: openaiSub.grantId,
          },
        });

        await declaration(c1, fixedDefinition, "agent", a1, "env.CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN");
        await declaration(c1, fixedDefinition, "agent", a3, "env.ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN");
        const claudeCompanyBinding = await binding(c1, claudeCompanySecret, "agent", a2, "env.Claude_Code_OAuth_Token");
        const dualAgentBinding = await binding(c1, dualSecret, "agent", a2, "env.ANTHROPIC_AUTH_TOKEN");

        const project = randomUUID();
        await sql`
          INSERT INTO "projects" ("id", "company_id", "name", "env")
          VALUES (${project}, ${c1}, 'Project', ${json({
            CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: dualSecret },
            KEEP_ME: { type: "plain", value: "x" },
          })})
        `;
        const dualProjectBinding = await binding(c1, dualSecret, "project", project, "env.CLAUDE_CODE_OAUTH_TOKEN");

        const routineEnv = {
          " claude_code_oauth_token ": { type: "plain", value: "sk-ant-oat-routine" },
          KEEP_ME: { type: "plain", value: "y" },
        };
        const routine = randomUUID();
        await sql`
          INSERT INTO "routines" ("id", "company_id", "title", "env")
          VALUES (${routine}, ${c1}, 'Routine', ${json(routineEnv)})
        `;
        const revision = randomUUID();
        await sql`
          INSERT INTO "routine_revisions" ("id", "company_id", "routine_id", "revision_number", "title", "snapshot")
          VALUES (${revision}, ${c1}, ${routine}, 1, 'Routine', ${json({
            version: 1,
            routine: { title: "Routine", env: routineEnv },
            triggers: [],
          })})
        `;
        const trigger = randomUUID();
        await sql`
          INSERT INTO "routine_triggers" ("id", "company_id", "routine_id", "kind", "secret_id")
          VALUES (${trigger}, ${c1}, ${routine}, 'webhook', ${triggerSecret})
        `;

        // Grant fan-out rows that cascade with a deleted subscription grant.
        await sql`
          INSERT INTO "connection_grant_members" ("company_id", "grant_id", "subject_type", "subject_id")
          VALUES (${c1}, ${subPersonal.grantId}, 'user', 'bob'), (${c1}, ${apiKey.grantId}, 'user', 'carol')
        `;
        await sql`
          INSERT INTO "connection_grant_delegations" ("company_id", "grant_id", "agent_id", "created_by_user_id")
          VALUES (${c1}, ${subPersonal.grantId}, ${a1}, 'alice'), (${c1}, ${apiKey.grantId}, ${a2}, 'bob')
        `;
        await sql`
          INSERT INTO "tool_connection_installs" ("company_id", "connection_id", "target_type", "target_id")
          VALUES
            (${c1}, ${subPersonal.connectionId}, 'agent', ${a1}),
            (${c1}, ${subShared.connectionId}, 'company', ${c1}),
            (${c1}, ${apiKey.connectionId}, 'agent', ${a2}),
            (${c1}, ${openaiSub.connectionId}, 'agent', ${a4})
        `;

        const claudeLoginSession = await authSession(c1, env1, {
          adapterType: "claude_local", status: "authenticated", userId: "alice",
          connectionMethod: "subscription", connectionId: subPersonal.connectionId, grantId: subPersonal.grantId,
        });
        const setupTokenSession = await authSession(c1, env1, {
          adapterType: "claude_local", status: "stored", userId: "bob",
        });
        const codexSession = await authSession(c1, env1, {
          adapterType: "codex_local", status: "authenticated", userId: "alice",
          connectionMethod: "local_subscription", connectionId: openaiSub.connectionId, grantId: openaiSub.grantId,
        });

        const run = randomUUID();
        await sql`INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id") VALUES (${run}, ${c1}, ${a1})`;
        const expires = new Date(Date.now() + 86_400_000);
        const bindingProposal = randomUUID();
        const claudeSecretProposal = randomUUID();
        const keptProposal = randomUUID();
        await sql`
          INSERT INTO "company_secret_proposals" (
            "id", "company_id", "kind", "status", "proposed_name", "proposed_key", "justification",
            "value_ciphertext", "secret_id", "target_type", "target_id", "config_path",
            "proposed_by_agent_id", "origin_run_id", "expires_at"
          ) VALUES
            (${bindingProposal}, ${c1}, 'binding', 'pending', NULL, NULL, 'bind it',
              NULL, ${claudeCompanySecret}, 'agent', ${a3}, 'env.OTHER', ${a1}, ${run}, ${expires}),
            (${claudeSecretProposal}, ${c1}, 'secret', 'pending', 'Claude', 'CLAUDE_CODE_OAUTH_TOKEN', 'store it',
              ${json({ ciphertext: "sk-ant-oat-proposal" })}, NULL, NULL, NULL, NULL, ${a1}, ${run}, ${expires}),
            (${keptProposal}, ${c1}, 'secret', 'pending', 'GitHub', 'GITHUB_TOKEN', 'store it',
              ${json({ ciphertext: "ghp" })}, NULL, NULL, NULL, NULL, ${a1}, ${run}, ${expires})
        `;

        // ---- Company 2: the only Anthropic default was a subscription.
        const c2 = await company("Lost default");
        const c2App = await application(c2, "anthropic");
        const c2Sub = await aiConnection({
          companyId: c2, applicationId: c2App, provider: "anthropic", method: "subscription",
          ownership: "personal", userId: "alice", setDefault: true,
        });
        const b1 = await agent(c2, "claude_local", {}, {
          aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
        });
        const b2 = await agent(c2, "codex_local", {}, {
          aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" },
        });

        // ---- Company 3: never had a Claude subscription connection.
        const c3 = await company("No accounts");
        const d1 = await agent(c3, "claude_local", {}, {
          aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
        });
        const d2 = await agent(c3, "claude_local", {}, {
          aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" },
        });

        const before = await snapshotAll(sql);
        expect(before.ai_provider_defaults.size).toBe(4);

        await rewindMigration();
        await applyPendingMigrations(database.connectionString);
        const after = await snapshotAll(sql);

        const deleted: Record<(typeof ID_TABLES)[number], string[]> = {
          tool_connections: [subPersonal.connectionId, subShared.connectionId, c2Sub.connectionId],
          connection_grants: [subPersonal.grantId, subShared.grantId, c2Sub.grantId],
          connection_grant_members: [...before.connection_grant_members.values()]
            .filter((r) => r.grant_id === subPersonal.grantId).map((r) => String(r.id)),
          connection_grant_delegations: [...before.connection_grant_delegations.values()]
            .filter((r) => r.grant_id === subPersonal.grantId).map((r) => String(r.id)),
          tool_connection_installs: [...before.tool_connection_installs.values()]
            .filter((r) => idIn([subPersonal.connectionId, subShared.connectionId], r.connection_id))
            .map((r) => String(r.id)),
          company_secrets: [subPersonal.secretId, subShared.secretId, c2Sub.secretId, fixedSecret, claudeCompanySecret],
          company_secret_versions: [...before.company_secret_versions.values()]
            .filter((r) => idIn(
              [subPersonal.secretId, subShared.secretId, c2Sub.secretId, fixedSecret, claudeCompanySecret],
              r.secret_id,
            ))
            .map((r) => String(r.id)),
          company_secret_bindings: [subShared.bindingId!, claudeCompanyBinding, dualProjectBinding],
          company_secret_proposals: [bindingProposal, claudeSecretProposal],
          user_secret_definitions: [subPersonal.definitionId!, c2Sub.definitionId!, fixedDefinition],
          user_secret_declarations: [...before.user_secret_declarations.values()]
            .filter((r) => idIn(
              [subPersonal.definitionId, c2Sub.definitionId, fixedDefinition],
              r.user_secret_definition_id,
            ))
            .map((r) => String(r.id)),
          ai_connection_defaults: [...before.ai_connection_defaults.values()]
            .filter((r) => idIn([subPersonal.grantId, c2Sub.grantId], r.grant_id))
            .map((r) => String(r.id)),
          ai_provider_defaults: [...before.ai_provider_defaults.values()]
            .filter((r) => idIn([subPersonal.grantId, c2Sub.grantId], r.grant_id))
            .map((r) => String(r.id)),
          adapter_auth_sessions: [claudeLoginSession, setupTokenSession],
          routine_triggers: [],
          tool_applications: [],
        };

        // Exactly the expected rows are gone; every other row is unchanged.
        for (const table of ID_TABLES) {
          for (const id of deleted[table]) {
            expect(before[table].has(id), `${table} ${id} was seeded`).toBe(true);
            expect(after[table].has(id), `${table} ${id} was deleted`).toBe(false);
          }
          expect(withoutIds(after[table], []), `${table} survivors unchanged`)
            .toEqual(withoutIds(before[table], deleted[table]));
        }
        expect(deleted.connection_grant_members).toHaveLength(1);
        expect(deleted.connection_grant_delegations).toHaveLength(1);
        expect(deleted.tool_connection_installs).toHaveLength(2);
        expect(deleted.company_secret_versions).toHaveLength(5);
        expect(deleted.user_secret_declarations).toHaveLength(4);
        expect(deleted.ai_connection_defaults).toHaveLength(2);
        expect(deleted.ai_provider_defaults).toHaveLength(2);

        // Kept: API-key and OpenAI connections with their credentials, the dual
        // secret and its non-Claude binding, the trigger secret and the codex login.
        for (const [table, id] of [
          ["tool_connections", apiKey.connectionId],
          ["tool_connections", openaiSub.connectionId],
          ["company_secrets", apiKey.secretId],
          ["company_secrets", openaiSub.secretId],
          ["company_secrets", dualSecret],
          ["company_secrets", triggerSecret],
          ["company_secret_bindings", dualAgentBinding],
          ["user_secret_definitions", apiKey.definitionId!],
          ["user_secret_definitions", openaiSub.definitionId!],
          ["adapter_auth_sessions", codexSession],
          ["company_secret_proposals", keptProposal],
          ["routine_triggers", trigger],
        ] as const) {
          expect(after[table].get(id), `${table} ${id} kept`).toEqual(before[table].get(id));
        }

        // Agents: Claude env entries and subscription-only bindings removed.
        const agentRow = (id: string) => after.agents.get(id)!;
        expect(agentRow(a1).adapter_config).toEqual({
          model: "claude-sonnet",
          env: { OPENAI_API_KEY: { type: "plain", value: "sk-openai" } },
        });
        expect(agentRow(a1).runtime_config).toEqual({ heartbeat: { enabled: true } });
        expect(agentRow(a2).adapter_config).toEqual({
          env: { ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: dualSecret, version: "latest" } },
        });
        // Two members: Alice's Anthropic default was her subscription, Bob's is
        // an API key. The responsible-user binding stays for the company, Bob's
        // provider default stays, and Alice's is gone, so her runs of the agent
        // fall back to the server's claude CLI at run time.
        const anthropicProviderDefaults = (rows: Map<string, Json>) =>
          [...rows.values()]
            .filter((r) => r.company_id === c1 && r.provider === "anthropic")
            .map((r) => ({ user: r.user_id, grant: r.grant_id }));
        expect(anthropicProviderDefaults(before.ai_provider_defaults)).toEqual(
          expect.arrayContaining([
            { user: "alice", grant: subPersonal.grantId },
            { user: "bob", grant: apiKey.grantId },
          ]),
        );
        expect(anthropicProviderDefaults(after.ai_provider_defaults)).toEqual([
          { user: "bob", grant: apiKey.grantId },
        ]);
        // Bob still has an Anthropic API-key default in company 1.
        expect(agentRow(a2).runtime_config).toEqual(before.agents.get(a2)!.runtime_config);
        expect(agentRow(a3).runtime_config).toEqual(before.agents.get(a3)!.runtime_config);
        expect(agentRow(a3).adapter_config).toEqual({
          env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api03-kept" } },
        });
        expect(agentRow(a4)).toEqual(before.agents.get(a4));
        // Company 2 lost its only Anthropic default: fall back to the server CLI.
        expect(agentRow(b1).runtime_config).toEqual({});
        expect(agentRow(b2)).toEqual(before.agents.get(b2));
        // Company 3 never had subscriptions: only the subscription binding goes.
        expect(agentRow(d1)).toEqual(before.agents.get(d1));
        expect(agentRow(d2).runtime_config).toEqual({});
        for (const id of [a1, a2, a3, b1, d2]) {
          expect(agentRow(id).updated_at).not.toEqual(before.agents.get(id)!.updated_at);
        }

        expect(after.environments.get(env1)!.env_vars).toEqual({ OPENAI_API_KEY: "sk-openai-env" });
        expect(after.projects.get(project)!.env).toEqual({ KEEP_ME: { type: "plain", value: "x" } });
        expect(after.routines.get(routine)!.env).toEqual({ KEEP_ME: { type: "plain", value: "y" } });
        // routines.updated_at is user-visible; the backfill must not bump it.
        expect(after.routines.get(routine)!.updated_at).toEqual(before.routines.get(routine)!.updated_at);
        expect(after.routine_revisions.get(revision)!.snapshot).toEqual({
          version: 1,
          routine: { title: "Routine", env: { KEEP_ME: { type: "plain", value: "y" } } },
          triggers: [],
        });
        for (const table of EDITED_TABLES) {
          expect(after[table].size, `${table} row count`).toBe(before[table].size);
        }

        // Nothing is left that names the Claude subscription token.
        const leftovers = await sql<{ count: number }[]>`
          SELECT (
            (SELECT count(*) FROM "user_secret_definitions" WHERE upper("key") = 'CLAUDE_CODE_OAUTH_TOKEN')
            + (SELECT count(*) FROM "user_secret_declarations" WHERE upper("env_key") = 'CLAUDE_CODE_OAUTH_TOKEN')
            + (SELECT count(*) FROM "company_secret_bindings" WHERE upper("config_path") = 'ENV.CLAUDE_CODE_OAUTH_TOKEN')
            + (SELECT count(*) FROM "company_secrets" WHERE "provider_metadata" ? 'claudeSetupTokenSessionId')
            + (SELECT count(*) FROM "adapter_auth_sessions" WHERE "adapter_type" = 'claude_local')
            + (SELECT count(*) FROM "tool_connections" WHERE "config" -> 'ai' ->> 'provider' = 'anthropic'
                AND "config" -> 'ai' ->> 'method' = 'subscription')
            + (SELECT count(*) FROM "ai_connection_defaults" WHERE "provider" = 'anthropic' AND "method" = 'subscription')
          )::int AS "count"
        `;
        expect(leftovers).toEqual([{ count: 0 }]);

        // Replaying the migration changes nothing.
        await rewindMigration();
        await applyPendingMigrations(database.connectionString);
        const replayed = await snapshotAll(sql);
        for (const table of [...ID_TABLES, ...EDITED_TABLES]) {
          expect([...replayed[table].values()], `${table} unchanged by replay`).toEqual([...after[table].values()]);
        }

        // The work tables and helper functions did not outlive the migration.
        const temps = await sql<{ count: number }[]>`
          SELECT (
            (SELECT count(*) FROM pg_class WHERE relname LIKE 'claude_sub_%')
            + (SELECT count(*) FROM pg_proc WHERE proname LIKE 'paperclip_%claude%')
          )::int AS "count"
        `;
        expect(temps).toEqual([{ count: 0 }]);
      } finally {
        await sql.end();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
