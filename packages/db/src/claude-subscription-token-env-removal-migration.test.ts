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

const MIGRATION_FILE = "0283_remove_claude_subscription_tokens_from_env.sql";
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
  "company_secrets",
  "company_secret_versions",
  "company_secret_bindings",
  "company_secret_proposals",
  "user_secret_definitions",
  "user_secret_declarations",
] as const;

// Tables whose rows the migration may edit in place.
const EDITED_TABLES = [
  "issues",
  "approvals",
  "agents",
  "environments",
  "projects",
  "routines",
  "routine_revisions",
] as const;

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

function withoutIds(rows: Map<string, Json>, ids: string[]): Json[] {
  return [...rows.entries()].filter(([id]) => !ids.includes(id)).map(([, row]) => row);
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("claude subscription token env removal migration", () => {
  it("only changes data", () => {
    const statements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .toUpperCase();
    expect(statements).not.toMatch(/\bALTER\s+(TABLE|TYPE)\b/);
    expect(statements).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT)\b/);
    expect(statements).not.toMatch(/\bCREATE\s+(TABLE|TYPE|INDEX)\b/);
    // Every function it creates lives in pg_temp and is dropped at the end.
    const created = [...statements.matchAll(/CREATE OR REPLACE FUNCTION ([^\s(]+)\(/g)].map((m) => m[1]);
    const dropped = [...statements.matchAll(/DROP FUNCTION IF EXISTS ([^\s(]+)\(/g)].map((m) => m[1]);
    expect(created.length).toBeGreaterThan(0);
    for (const name of created) expect(name).toMatch(/^PG_TEMP\./);
    expect([...dropped].sort()).toEqual([...created].sort());
    // Each drop comes after the last statement that uses the function.
    const lastUse = Math.max(
      statements.lastIndexOf("UPDATE \""),
      statements.lastIndexOf("DELETE FROM \""),
    );
    expect(statements.indexOf("DROP FUNCTION")).toBeGreaterThan(lastUse);
  });
});

describeEmbeddedPostgres("claude subscription token env removal executable migration", () => {
  it(
    "removes exactly the Claude subscription token env entries and is idempotent",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-claude-token-env-removal-migration-");
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
      async function agent(companyId: string, adapterType: string, adapterConfig: Json) {
        const id = randomUUID();
        await sql`
          INSERT INTO "agents" ("id", "company_id", "name", "adapter_type", "adapter_config")
          VALUES (${id}, ${companyId}, ${`Agent ${id.slice(0, 8)}`}, ${adapterType}, ${json(adapterConfig)})
        `;
        return id;
      }
      async function secret(companyId: string, key: string) {
        const id = randomUUID();
        await sql`
          INSERT INTO "company_secrets" ("id", "company_id", "name", "key", "scope")
          VALUES (${id}, ${companyId}, ${key}, ${key}, 'company')
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
        envKey: string,
      ) {
        const id = randomUUID();
        await sql`
          INSERT INTO "user_secret_declarations" (
            "id", "company_id", "user_secret_definition_id", "target_type", "target_id", "config_path", "env_key"
          ) VALUES (${id}, ${companyId}, ${definitionId}, ${targetType}, ${targetId}, ${`env.${envKey}`}, ${envKey})
        `;
        return id;
      }
      async function binding(companyId: string, secretId: string, targetType: string, targetId: string, envKey: string) {
        const id = randomUUID();
        await sql`
          INSERT INTO "company_secret_bindings" ("id", "company_id", "secret_id", "target_type", "target_id", "config_path")
          VALUES (${id}, ${companyId}, ${secretId}, ${targetType}, ${targetId}, ${`env.${envKey}`})
        `;
        return id;
      }
      async function issue(companyId: string, overrides: Json | null) {
        const id = randomUUID();
        await sql`
          INSERT INTO "issues" ("id", "company_id", "title", "assignee_adapter_overrides")
          VALUES (${id}, ${companyId}, ${`Issue ${id.slice(0, 8)}`}, ${overrides === null ? null : json(overrides)})
        `;
        return id;
      }
      async function approval(companyId: string, type: string, status: string, payload: Json) {
        const id = randomUUID();
        await sql`
          INSERT INTO "approvals" ("id", "company_id", "type", "status", "payload")
          VALUES (${id}, ${companyId}, ${type}, ${status}, ${json(payload)})
        `;
        return id;
      }

      try {
        const c1 = await company("Main");
        const gatewaySecret = await secret(c1, "gateway-token");
        const oauthSecret = await secret(c1, "anthropic-oauth");
        const apiKeySecret = await secret(c1, "anthropic-api-key");
        const githubSecret = await secret(c1, "github-token");
        const personalDefinition = await definition(c1, "MY_ANTHROPIC");
        const gatewayDefinition = await definition(c1, "ANTHROPIC_TOKEN");

        // Env entries every map keeps: other providers, API credentials, a
        // gateway token that is not a subscription token, cloud providers.
        const keptEnv = {
          OPENAI_API_KEY: "sk-openai-inline",
          ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api03-kept" },
          ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: gatewaySecret, version: "latest" },
          ANTHROPIC_BASE_URL: "https://gateway.example.com",
          CLAUDE_CODE_USE_BEDROCK: "1",
          GITHUB_TOKEN: { type: "secret_ref", secretId: githubSecret },
          NOTE: "mentions sk-ant-oat in the middle, not as a prefix",
        };

        // ---- Agents (0282 scrubbed CLAUDE_CODE_OAUTH_TOKEN; now the wider rules).
        const a1 = await agent(c1, "claude_local", {
          model: "claude-sonnet",
          env: {
            ...keptEnv,
            ANTHROPIC_OAUTH_TOKEN: { type: "user_secret_ref", key: "MY_ANTHROPIC" },
            " Anthropic_Token ": { type: "secret_ref", secretId: oauthSecret },
            CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-left-over",
            MY_TOKEN: { type: "plain", value: "  SK-ANT-OAT01-agent" },
            // The refresh-token sign-in and the other sign-in handoffs.
            claude_code_oauth_refresh_token: { type: "secret_ref", secretId: oauthSecret },
            CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
            CCR_OAUTH_TOKEN_FILE: "/run/ccr/token",
            CLAUDE_CODE_HOST_CREDS_FILE: "/home/svc/.claude/.credentials.json",
            CLAUDE_CODE_SESSION_ACCESS_TOKEN: "session-token",
            MY_REFRESH: "sk-ant-ort01-agent",
            MY_SESSION: { type: "plain", value: " sk-ant-sid01-agent" },
          },
        });
        const a2 = await agent(c1, "codex_local", { env: { OPENAI_API_KEY: "sk-openai" } });
        // A gateway token held in a user secret named ANTHROPIC_TOKEN stays: only
        // the env key and the plain value decide.
        const a3 = await agent(c1, "claude_local", {
          env: { ANTHROPIC_AUTH_TOKEN: { type: "user_secret_ref", key: "ANTHROPIC_TOKEN" } },
        });
        const a4 = await agent(c1, "claude_local", {
          env: {
            ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-as-gateway",
            OLD: { type: "user_secret_ref", key: " claude_code_oauth_token " },
          },
        });
        const a5 = await agent(c1, "process", { command: "echo" });

        // ---- Issue assignee overrides (missed by 0282).
        const i1 = await issue(c1, {
          useProjectWorkspace: true,
          adapterConfig: {
            model: "claude-opus",
            env: {
              ...keptEnv,
              CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-issue",
              anthropic_oauth_token: { type: "plain", value: "not-even-a-token" },
              ANTHROPIC_TOKEN: { type: "secret_ref", secretId: oauthSecret },
              SESSION: "\tsk-ant-oat01-issue-value",
              OLD: { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" },
            },
          },
        });
        const i2 = await issue(c1, { adapterConfig: { env: { OPENAI_API_KEY: "sk-openai" } } });
        const i3 = await issue(c1, { useProjectWorkspace: false });
        const i4 = await issue(c1, null);
        const i5 = await issue(c1, { adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-only" } } });

        // ---- hire_agent approvals (missed by 0282).
        const hireEnv = {
          ANTHROPIC_TOKEN: { type: "secret_ref", secretId: oauthSecret },
          ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-hire",
          CLAUDE_CODE_OAUTH_TOKEN: "***REDACTED***",
          KEEP: "v",
        };
        const ap1 = await approval(c1, "hire_agent", "pending", {
          name: "Claude hire",
          adapterType: "claude_local",
          adapterConfig: { model: "claude-sonnet", env: hireEnv },
          runtimeConfig: {},
          agentId: a1,
          requestedConfigurationSnapshot: {
            adapterType: "claude_local",
            adapterConfig: { model: "claude-sonnet", env: hireEnv },
            runtimeConfig: {},
          },
        });
        // An approved hire without a snapshot (built-in agent path).
        const ap2 = await approval(c1, "hire_agent", "approved", {
          name: "Built-in",
          adapterType: "claude_local",
          adapterConfig: { env: { anthropic_oauth_token: "sk-ant-oat01-built-in", ...keptEnv } },
        });
        const ap3 = await approval(c1, "hire_agent", "pending", {
          name: "Codex hire",
          adapterType: "codex_local",
          adapterConfig: { env: { OPENAI_API_KEY: "sk-openai" } },
          requestedConfigurationSnapshot: { adapterConfig: { env: { OPENAI_API_KEY: "sk-openai" } } },
        });
        const ap4 = await approval(c1, "approve_ceo_strategy", "pending", { plan: "Grow" });

        // ---- Environments, projects, routines and revisions.
        const e1 = randomUUID();
        await sql`
          INSERT INTO "environments" ("id", "name", "driver", "env_vars")
          VALUES (${e1}, 'Env 1', 'ssh', ${json({ anthropic_token: "abc", GITHUB_TOKEN: "ghp" })})
        `;
        const e2 = randomUUID();
        await sql`
          INSERT INTO "environments" ("id", "name", "driver", "env_vars")
          VALUES (${e2}, 'Env 2', 'ssh', ${json({ OPENAI_API_KEY: "sk-openai-env" })})
        `;
        const p1 = randomUUID();
        await sql`
          INSERT INTO "projects" ("id", "company_id", "name", "env")
          VALUES (${p1}, ${c1}, 'Project', ${json({
            ANTHROPIC_TOKEN: { type: "secret_ref", secretId: oauthSecret },
            X: { type: "plain", value: " sk-ant-oat01-project" },
            KEEP_ME: { type: "plain", value: "x" },
          })})
        `;
        const p2 = randomUUID();
        await sql`
          INSERT INTO "projects" ("id", "company_id", "name", "env")
          VALUES (${p2}, ${c1}, 'Other project', ${json({ KEEP_ME: "y" })})
        `;
        const routineEnv = {
          " ANTHROPIC_OAUTH_TOKEN": { type: "plain", value: "sk-ant-oat01-routine" },
          KEEP_ME: { type: "plain", value: "y" },
        };
        const r1 = randomUUID();
        await sql`
          INSERT INTO "routines" ("id", "company_id", "title", "env")
          VALUES (${r1}, ${c1}, 'Routine', ${json(routineEnv)})
        `;
        const rev1 = randomUUID();
        await sql`
          INSERT INTO "routine_revisions" ("id", "company_id", "routine_id", "revision_number", "title", "snapshot")
          VALUES (${rev1}, ${c1}, ${r1}, 1, 'Routine', ${json({
            version: 1,
            routine: { title: "Routine", env: routineEnv },
            triggers: [],
          })})
        `;

        // ---- Bookkeeping rows.
        const projectTokenBinding = await binding(c1, oauthSecret, "project", p1, "ANTHROPIC_TOKEN");
        const agentTokenBinding = await binding(c1, oauthSecret, "agent", a1, " Anthropic_Token ");
        const agentGatewayBinding = await binding(c1, gatewaySecret, "agent", a1, "ANTHROPIC_AUTH_TOKEN");
        const agentApiKeyBinding = await binding(c1, apiKeySecret, "agent", a2, "ANTHROPIC_API_KEY");
        // A target whose env this migration does not scrub keeps its binding.
        const pluginBinding = await binding(c1, oauthSecret, "plugin", randomUUID(), "ANTHROPIC_TOKEN");
        const agentOauthDeclaration = await declaration(c1, personalDefinition, "agent", a1, "ANTHROPIC_OAUTH_TOKEN");
        const agentGatewayDeclaration = await declaration(c1, gatewayDefinition, "agent", a3, "ANTHROPIC_AUTH_TOKEN");

        const run = randomUUID();
        await sql`INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id") VALUES (${run}, ${c1}, ${a1})`;
        const expires = new Date(Date.now() + 86_400_000);
        const pendingTokenProposal = randomUUID();
        const approvedTokenProposal = randomUUID();
        const pendingOtherProposal = randomUUID();
        await sql`
          INSERT INTO "company_secret_proposals" (
            "id", "company_id", "kind", "status", "justification", "secret_id", "target_type", "target_id",
            "config_path", "proposed_by_agent_id", "origin_run_id", "expires_at"
          ) VALUES
            (${pendingTokenProposal}, ${c1}, 'binding', 'pending', 'bind it', ${oauthSecret}, 'agent', ${a2},
              'env.anthropic_token', ${a1}, ${run}, ${expires}),
            (${approvedTokenProposal}, ${c1}, 'binding', 'approved', 'bind it', ${oauthSecret}, 'agent', ${a2},
              'env.ANTHROPIC_OAUTH_TOKEN', ${a1}, ${run}, ${expires}),
            (${pendingOtherProposal}, ${c1}, 'binding', 'pending', 'bind it', ${apiKeySecret}, 'agent', ${a2},
              'env.ANTHROPIC_API_KEY', ${a1}, ${run}, ${expires})
        `;

        const before = await snapshotAll(sql);

        await rewindMigration();
        await applyPendingMigrations(database.connectionString);
        const after = await snapshotAll(sql);

        const deleted: Record<(typeof ID_TABLES)[number], string[]> = {
          company_secrets: [],
          company_secret_versions: [],
          company_secret_bindings: [projectTokenBinding, agentTokenBinding],
          company_secret_proposals: [pendingTokenProposal],
          user_secret_definitions: [],
          user_secret_declarations: [agentOauthDeclaration],
        };

        // Exactly the expected rows are gone; every other row is unchanged. The
        // secrets stay: SQL cannot read their encrypted values.
        for (const table of ID_TABLES) {
          for (const id of deleted[table]) {
            expect(before[table].has(id), `${table} ${id} was seeded`).toBe(true);
            expect(after[table].has(id), `${table} ${id} was deleted`).toBe(false);
          }
          expect(withoutIds(after[table], []), `${table} survivors unchanged`)
            .toEqual(withoutIds(before[table], deleted[table]));
        }
        for (const [table, id] of [
          ["company_secret_bindings", agentGatewayBinding],
          ["company_secret_bindings", agentApiKeyBinding],
          ["company_secret_bindings", pluginBinding],
          ["user_secret_declarations", agentGatewayDeclaration],
          ["company_secret_proposals", approvedTokenProposal],
          ["company_secret_proposals", pendingOtherProposal],
          ["company_secrets", oauthSecret],
        ] as const) {
          expect(after[table].get(id), `${table} ${id} kept`).toEqual(before[table].get(id));
        }

        // Agents: only the token entries go, and a changed row gets a new updated_at.
        const agentRow = (id: string) => after.agents.get(id)!;
        expect(agentRow(a1).adapter_config).toEqual({ model: "claude-sonnet", env: keptEnv });
        expect(agentRow(a4).adapter_config).toEqual({ env: {} });
        for (const id of [a1, a4]) {
          expect(agentRow(id).updated_at).not.toEqual(before.agents.get(id)!.updated_at);
        }
        for (const id of [a2, a3, a5]) expect(agentRow(id)).toEqual(before.agents.get(id));

        // Issues: overrides scrubbed, other override fields and updated_at kept.
        const issueRow = (id: string) => after.issues.get(id)!;
        expect(issueRow(i1).assignee_adapter_overrides).toEqual({
          useProjectWorkspace: true,
          adapterConfig: { model: "claude-opus", env: keptEnv },
        });
        expect(issueRow(i5).assignee_adapter_overrides).toEqual({ adapterConfig: { env: {} } });
        for (const id of [i1, i5]) {
          expect(issueRow(id).updated_at).toEqual(before.issues.get(id)!.updated_at);
          expect({ ...issueRow(id), assignee_adapter_overrides: null })
            .toEqual({ ...before.issues.get(id)!, assignee_adapter_overrides: null });
        }
        for (const id of [i2, i3, i4]) expect(issueRow(id)).toEqual(before.issues.get(id));

        // Approvals: both copies of the hire env scrubbed; nothing else changes.
        const approvalRow = (id: string) => after.approvals.get(id)!;
        const beforeAp1 = before.approvals.get(ap1)!;
        expect(approvalRow(ap1)).toEqual({
          ...beforeAp1,
          payload: {
            ...(beforeAp1.payload as Json),
            adapterConfig: { model: "claude-sonnet", env: { KEEP: "v" } },
            requestedConfigurationSnapshot: {
              adapterType: "claude_local",
              adapterConfig: { model: "claude-sonnet", env: { KEEP: "v" } },
              runtimeConfig: {},
            },
          },
        });
        const beforeAp2 = before.approvals.get(ap2)!;
        expect(approvalRow(ap2)).toEqual({
          ...beforeAp2,
          payload: { ...(beforeAp2.payload as Json), adapterConfig: { env: keptEnv } },
        });
        for (const id of [ap3, ap4]) expect(approvalRow(id)).toEqual(before.approvals.get(id));

        // Environments and projects.
        expect(after.environments.get(e1)!.env_vars).toEqual({ GITHUB_TOKEN: "ghp" });
        expect(after.environments.get(e1)!.updated_at).not.toEqual(before.environments.get(e1)!.updated_at);
        expect(after.environments.get(e2)).toEqual(before.environments.get(e2));
        expect(after.projects.get(p1)!.env).toEqual({ KEEP_ME: { type: "plain", value: "x" } });
        expect(after.projects.get(p1)!.updated_at).not.toEqual(before.projects.get(p1)!.updated_at);
        expect(after.projects.get(p2)).toEqual(before.projects.get(p2));

        // Routines keep their user-visible updated_at; revisions are scrubbed too.
        expect(after.routines.get(r1)!.env).toEqual({ KEEP_ME: { type: "plain", value: "y" } });
        expect(after.routines.get(r1)!.updated_at).toEqual(before.routines.get(r1)!.updated_at);
        expect(after.routine_revisions.get(rev1)!.snapshot).toEqual({
          version: 1,
          routine: { title: "Routine", env: { KEEP_ME: { type: "plain", value: "y" } } },
          triggers: [],
        });
        for (const table of EDITED_TABLES) {
          expect(after[table].size, `${table} row count`).toBe(before[table].size);
        }

        // No stored env map names a subscription token key or holds a plain token.
        const leftovers = await sql<{ count: number }[]>`
          WITH env_maps AS (
            SELECT "adapter_config" -> 'env' AS env FROM "agents"
            UNION ALL SELECT "assignee_adapter_overrides" -> 'adapterConfig' -> 'env' FROM "issues"
            UNION ALL SELECT "payload" -> 'adapterConfig' -> 'env' FROM "approvals"
            UNION ALL SELECT "payload" -> 'requestedConfigurationSnapshot' -> 'adapterConfig' -> 'env' FROM "approvals"
            UNION ALL SELECT "env_vars" FROM "environments"
            UNION ALL SELECT "env" FROM "projects"
            UNION ALL SELECT "env" FROM "routines"
            UNION ALL SELECT "snapshot" -> 'routine' -> 'env' FROM "routine_revisions"
          )
          SELECT count(*)::int AS "count"
          FROM env_maps m
          CROSS JOIN LATERAL jsonb_each(
            CASE WHEN jsonb_typeof(m.env) = 'object' THEN m.env ELSE '{}'::jsonb END
          ) AS entry
          WHERE upper(btrim(entry.key)) IN (
              'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_TOKEN',
              'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
              'CCR_OAUTH_TOKEN_FILE', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN'
            )
            OR regexp_replace(coalesce(
              CASE WHEN jsonb_typeof(entry.value) = 'string' THEN entry.value #>> '{}' ELSE entry.value ->> 'value' END,
              ''
            ), '^[[:space:]]+', '') ~* '^sk-ant-(oat|ort|sid)'
        `;
        expect(leftovers).toEqual([{ count: 0 }]);

        // Replaying the migration changes nothing, updated_at included.
        await rewindMigration();
        await applyPendingMigrations(database.connectionString);
        const replayed = await snapshotAll(sql);
        for (const table of [...ID_TABLES, ...EDITED_TABLES]) {
          expect([...replayed[table].values()], `${table} unchanged by replay`).toEqual([...after[table].values()]);
        }

        // The helper functions did not outlive the migration.
        const temps = await sql<{ count: number }[]>`
          SELECT count(*)::int AS "count"
          FROM pg_proc
          WHERE proname IN (
            'paperclip_normalized_env_key',
            'paperclip_is_claude_token_env_key',
            'paperclip_is_claude_token_config_path',
            'paperclip_is_claude_token_value',
            'paperclip_strip_claude_token_env'
          )
        `;
        expect(temps).toEqual([{ count: 0 }]);
      } finally {
        await sql.end();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
