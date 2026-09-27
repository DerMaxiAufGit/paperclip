-- Remove every stored Claude subscription credential.
--
-- Paperclip now uses a Claude subscription only through the `claude` CLI that
-- is signed in on the server (doc/plans/2026-09-24-claude-cli-only-auth.md,
-- phase 5). It never stores, forwards or injects a Claude sign-in. This
-- data-only migration deletes the credentials that earlier versions stored and
-- the rows that exist only to reference them:
--   A. managed Anthropic subscription AI connections (config.ai =
--      {provider: anthropic, method: subscription}), their grants, credential
--      secrets, per-grant user-secret definitions, declarations, bindings,
--      defaults, agent bindings and login sessions;
--   B. the fixed CLAUDE_CODE_OAUTH_TOKEN user secret of the removed
--      `claude setup-token` flow, the values it captured, and every
--      CLAUDE_CODE_OAUTH_TOKEN env entry, binding, declaration and proposal.
-- Anthropic API-key connections and all other providers stay untouched. No
-- schema, enum or column changes.
--
-- Replay-safe: every target set is recomputed from the current rows, so a
-- second run, or a database without such rows, changes nothing.
--
-- Env keys match like isClaudeSubscriptionTokenEnvKey() in
-- packages/shared/src/validators/secret.ts: trimmed and case-insensitive.
--
-- A secret that a non-Claude consumer still uses (a surviving grant or
-- connection, a non-Claude binding, a routine webhook trigger or a managed
-- agent profile) is kept; only its Claude references are removed. This also
-- keeps the migration from failing on the RESTRICT foreign key of
-- managed_agent_profiles.
--
-- Deletion order keeps every foreign key satisfied:
--   ai_*_defaults (NO ACTION to connection_grants) go before tool_connections;
--   binding proposals go before their secret (SET NULL would break the
--   company_secret_proposals shape check);
--   user-scope secrets go before their definition (SET NULL would break the
--   company_secrets scope shape check).
-- Cascades then remove company_secret_versions, company_secret_bindings and
-- secret_access_events of a deleted secret, user_secret_declarations of a
-- deleted definition, and connection_grants (with connection_grant_members and
-- connection_grant_delegations), tool_connection_installs,
-- connection_token_issuances, tool_catalog_entries, tool_oauth_states,
-- tool_profile_entries and tool_runtime_slots of a deleted connection. Tool
-- invocation, call and audit history keeps its rows with connection_id set to
-- NULL.
--
-- Helper functions and work tables live in pg_temp and are dropped at the end.
DROP TABLE IF EXISTS pg_temp."claude_sub_connections";
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp."claude_sub_grants";
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp."claude_sub_default_companies";
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp."claude_sub_definitions";
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp."claude_sub_secrets";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.paperclip_is_claude_oauth_key(candidate text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT upper(regexp_replace(coalesce(candidate, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g')) = 'CLAUDE_CODE_OAUTH_TOKEN'
$$;
--> statement-breakpoint
-- Secret bindings and declarations address an env var as `env.<KEY>`.
CREATE OR REPLACE FUNCTION pg_temp.paperclip_is_claude_oauth_config_path(config_path text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT coalesce(config_path LIKE 'env.%' AND pg_temp.paperclip_is_claude_oauth_key(substr(config_path, 5)), false)
$$;
--> statement-breakpoint
-- A. Managed Anthropic subscription AI connections and their grants.
CREATE TEMP TABLE "claude_sub_connections" ON COMMIT DROP AS
SELECT c."id", c."company_id"
FROM "tool_connections" c
WHERE c."connection_purpose" = 'ai'
	AND c."transport" = 'runtime_auth'
	AND c."config" -> 'ai' ->> 'provider' = 'anthropic'
	AND c."config" -> 'ai' ->> 'method' = 'subscription';
--> statement-breakpoint
CREATE TEMP TABLE "claude_sub_grants" ON COMMIT DROP AS
SELECT g."id", g."company_id", g."kind"
FROM "connection_grants" g
JOIN "claude_sub_connections" c
	ON c."company_id" = g."company_id"
	AND c."id" = g."connection_id";
--> statement-breakpoint
-- Companies whose personal Anthropic default was a subscription grant.
CREATE TEMP TABLE "claude_sub_default_companies" ON COMMIT DROP AS
SELECT d."company_id"
FROM "ai_provider_defaults" d
WHERE d."grant_id" IN (SELECT "id" FROM "claude_sub_grants")
UNION
SELECT d."company_id"
FROM "ai_connection_defaults" d
WHERE d."grant_id" IN (SELECT "id" FROM "claude_sub_grants")
	OR (d."provider" = 'anthropic' AND d."method" = 'subscription');
--> statement-breakpoint
-- User-secret definitions that exist only for a Claude subscription credential:
-- the fixed CLAUDE_CODE_OAUTH_TOKEN definition, and any definition (including
-- the per-grant `ai_<grant id>` slot of a personal subscription grant) whose
-- declarations all point at a deleted connection or a CLAUDE_CODE_OAUTH_TOKEN
-- env var.
CREATE TEMP TABLE "claude_sub_definitions" ON COMMIT DROP AS
WITH claude_declarations AS (
	SELECT
		x."user_secret_definition_id",
		(
			pg_temp.paperclip_is_claude_oauth_key(x."env_key")
			OR pg_temp.paperclip_is_claude_oauth_config_path(x."config_path")
			OR (
				x."target_type" = 'tool_connection'
				AND x."target_id" IN (SELECT "id"::text FROM "claude_sub_connections")
			)
		) AS "is_claude"
	FROM "user_secret_declarations" x
)
SELECT d."id", d."company_id"
FROM "user_secret_definitions" d
WHERE pg_temp.paperclip_is_claude_oauth_key(d."key")
	OR (
		(
			EXISTS (
				SELECT 1
				FROM "claude_sub_grants" g
				WHERE g."company_id" = d."company_id"
					AND g."kind" = 'user'
					AND d."key" = 'ai_' || replace(g."id"::text, '-', '_')
			)
			OR EXISTS (
				SELECT 1
				FROM claude_declarations cd
				WHERE cd."user_secret_definition_id" = d."id"
			)
		)
		AND NOT EXISTS (
			SELECT 1
			FROM claude_declarations cd
			WHERE cd."user_secret_definition_id" = d."id"
				AND NOT cd."is_claude"
		)
	);
--> statement-breakpoint
-- Secrets holding a Claude subscription credential.
CREATE TEMP TABLE "claude_sub_secrets" ON COMMIT DROP AS
WITH candidate_ids AS (
	-- The ai.credential of an Anthropic subscription grant or connection.
	SELECT ref ->> 'secretId' AS "secret_id"
	FROM "connection_grants" g
	CROSS JOIN LATERAL jsonb_array_elements(
		CASE WHEN jsonb_typeof(g."credential_secret_refs") = 'array' THEN g."credential_secret_refs" ELSE '[]'::jsonb END
	) ref
	WHERE g."id" IN (SELECT "id" FROM "claude_sub_grants")
	UNION
	SELECT ref ->> 'secretId'
	FROM "tool_connections" c
	CROSS JOIN LATERAL jsonb_array_elements(
		CASE WHEN jsonb_typeof(c."credential_secret_refs") = 'array' THEN c."credential_secret_refs" ELSE '[]'::jsonb END
	) ref
	WHERE c."id" IN (SELECT "id" FROM "claude_sub_connections")
	UNION
	-- A value of a Claude definition, a `claude setup-token` capture, or a
	-- secret keyed CLAUDE_CODE_OAUTH_TOKEN.
	SELECT s."id"::text
	FROM "company_secrets" s
	WHERE s."user_secret_definition_id" IN (SELECT "id" FROM "claude_sub_definitions")
		OR (s."provider_metadata" -> 'claudeSetupTokenSessionId') IS NOT NULL
		OR pg_temp.paperclip_is_claude_oauth_key(s."key")
	UNION
	-- A company secret bound to a CLAUDE_CODE_OAUTH_TOKEN env var.
	SELECT b."secret_id"::text
	FROM "company_secret_bindings" b
	WHERE pg_temp.paperclip_is_claude_oauth_config_path(b."config_path")
),
surviving_refs AS (
	SELECT ref ->> 'secretId' AS "secret_id"
	FROM "connection_grants" g
	CROSS JOIN LATERAL jsonb_array_elements(
		CASE WHEN jsonb_typeof(g."credential_secret_refs") = 'array' THEN g."credential_secret_refs" ELSE '[]'::jsonb END
	) ref
	WHERE g."id" NOT IN (SELECT "id" FROM "claude_sub_grants")
	UNION
	SELECT ref ->> 'secretId'
	FROM "tool_connections" c
	CROSS JOIN LATERAL jsonb_array_elements(
		CASE WHEN jsonb_typeof(c."credential_secret_refs") = 'array' THEN c."credential_secret_refs" ELSE '[]'::jsonb END
	) ref
	WHERE c."id" NOT IN (SELECT "id" FROM "claude_sub_connections")
)
SELECT s."id", s."company_id"
FROM "company_secrets" s
WHERE s."id"::text IN (SELECT "secret_id" FROM candidate_ids)
	AND s."id"::text NOT IN (SELECT "secret_id" FROM surviving_refs WHERE "secret_id" IS NOT NULL)
	AND NOT EXISTS (
		SELECT 1
		FROM "company_secret_bindings" b
		WHERE b."secret_id" = s."id"
			AND NOT pg_temp.paperclip_is_claude_oauth_config_path(b."config_path")
			AND NOT (
				b."target_type" = 'tool_connection'
				AND b."target_id" IN (SELECT "id"::text FROM "claude_sub_connections")
			)
	)
	AND NOT EXISTS (
		SELECT 1 FROM "routine_triggers" t WHERE t."secret_id" = s."id"
	)
	AND NOT EXISTS (
		SELECT 1 FROM "managed_agent_profiles" p WHERE p."api_key_secret_id" = s."id"
	);
--> statement-breakpoint
-- Removes CLAUDE_CODE_OAUTH_TOKEN entries (any value form), user-secret refs to
-- the Claude definition key, and refs to a deleted secret from an env map.
CREATE OR REPLACE FUNCTION pg_temp.paperclip_strip_claude_env(env jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
	SELECT CASE
		WHEN jsonb_typeof(env) = 'object' THEN coalesce((
			SELECT jsonb_object_agg(entry.key, entry.value)
			FROM jsonb_each(env) AS entry
			WHERE NOT (
				pg_temp.paperclip_is_claude_oauth_key(entry.key)
				OR (
					jsonb_typeof(entry.value) = 'object'
					AND entry.value ->> 'type' = 'user_secret_ref'
					AND pg_temp.paperclip_is_claude_oauth_key(entry.value ->> 'key')
				)
				OR (
					jsonb_typeof(entry.value) = 'object'
					AND entry.value ->> 'type' = 'secret_ref'
					AND entry.value ->> 'secretId' IN (SELECT "id"::text FROM "claude_sub_secrets")
				)
			)
		), '{}'::jsonb)
		ELSE env
	END
$$;
--> statement-breakpoint
DELETE FROM "ai_connection_defaults"
WHERE "grant_id" IN (SELECT "id" FROM "claude_sub_grants")
	OR ("provider" = 'anthropic' AND "method" = 'subscription');
--> statement-breakpoint
DELETE FROM "ai_provider_defaults"
WHERE "grant_id" IN (SELECT "id" FROM "claude_sub_grants");
--> statement-breakpoint
-- No current flow writes claude_local login sessions; every such row came from
-- the removed Claude subscription capture flows.
DELETE FROM "adapter_auth_sessions"
WHERE "adapter_type" = 'claude_local'
	OR "connection_id" IN (SELECT "id" FROM "claude_sub_connections")
	OR "connection_grant_id" IN (SELECT "id" FROM "claude_sub_grants")
	OR (
		"ai_connection" ->> 'provider' = 'anthropic'
		AND "ai_connection" ->> 'method' = 'subscription'
	);
--> statement-breakpoint
-- Deleting a proposed secret cascades the binding proposals that name it.
DELETE FROM "company_secret_proposals"
WHERE "secret_id" IN (SELECT "id" FROM "claude_sub_secrets")
	OR "created_secret_id" IN (SELECT "id" FROM "claude_sub_secrets")
	OR ("kind" = 'secret' AND pg_temp.paperclip_is_claude_oauth_key("proposed_key"))
	OR ("kind" = 'binding' AND pg_temp.paperclip_is_claude_oauth_config_path("config_path"));
--> statement-breakpoint
DELETE FROM "company_secret_bindings"
WHERE pg_temp.paperclip_is_claude_oauth_config_path("config_path")
	OR (
		"target_type" = 'tool_connection'
		AND "target_id" IN (SELECT "id"::text FROM "claude_sub_connections")
	);
--> statement-breakpoint
DELETE FROM "user_secret_declarations"
WHERE pg_temp.paperclip_is_claude_oauth_key("env_key")
	OR pg_temp.paperclip_is_claude_oauth_config_path("config_path")
	OR (
		"target_type" = 'tool_connection'
		AND "target_id" IN (SELECT "id"::text FROM "claude_sub_connections")
	);
--> statement-breakpoint
DELETE FROM "company_secrets"
WHERE "id" IN (SELECT "id" FROM "claude_sub_secrets");
--> statement-breakpoint
DELETE FROM "user_secret_definitions" d
WHERE d."id" IN (SELECT "id" FROM "claude_sub_definitions")
	AND NOT EXISTS (
		SELECT 1 FROM "company_secrets" s WHERE s."user_secret_definition_id" = d."id"
	);
--> statement-breakpoint
DELETE FROM "tool_connections"
WHERE "id" IN (SELECT "id" FROM "claude_sub_connections");
--> statement-breakpoint
-- Remove agent AI connection bindings that can only have meant a Claude
-- subscription, so the agent runs on the claude CLI signed in on the server:
--   - a shared or delegated binding to a deleted connection or grant, or to an
--     Anthropic subscription;
--   - a responsible-user Anthropic binding in a company where no member has an
--     Anthropic default left, when the binding asked for a subscription or the
--     company's Anthropic defaults were subscriptions deleted above.
-- A responsible-user Anthropic binding stays while a member still has an
-- Anthropic (API-key) default, because that default decides the run method.
-- A responsible user without an Anthropic default (for example one whose
-- subscription default is deleted above) runs the claude_local agent on the
-- claude CLI signed in on the server: the heartbeat drops the binding for that
-- user's runs (resolveRunAiConnectionBinding in ai-connection-runtime.ts).
UPDATE "agents" a
SET
	"runtime_config" = a."runtime_config" - 'aiConnection',
	"updated_at" = now()
WHERE jsonb_typeof(a."runtime_config" -> 'aiConnection') = 'object'
	AND (
		(
			a."runtime_config" -> 'aiConnection' ->> 'mode' IN ('shared', 'delegated')
			AND (
				a."runtime_config" -> 'aiConnection' ->> 'connectionId' IN (SELECT "id"::text FROM "claude_sub_connections")
				OR a."runtime_config" -> 'aiConnection' ->> 'grantId' IN (SELECT "id"::text FROM "claude_sub_grants")
				OR (
					a."runtime_config" -> 'aiConnection' ->> 'provider' = 'anthropic'
					AND a."runtime_config" -> 'aiConnection' ->> 'method' = 'subscription'
				)
			)
		)
		OR (
			a."runtime_config" -> 'aiConnection' ->> 'mode' = 'responsible_user'
			AND a."runtime_config" -> 'aiConnection' ->> 'provider' = 'anthropic'
			AND NOT EXISTS (
				SELECT 1
				FROM "ai_provider_defaults" d
				WHERE d."company_id" = a."company_id"
					AND d."provider" = 'anthropic'
					AND d."grant_id" IS NOT NULL
			)
			AND (
				a."runtime_config" -> 'aiConnection' ->> 'method' = 'subscription'
				OR a."company_id" IN (SELECT "company_id" FROM "claude_sub_default_companies")
			)
		)
	);
--> statement-breakpoint
UPDATE "agents"
SET
	"adapter_config" = jsonb_set("adapter_config", '{env}', pg_temp.paperclip_strip_claude_env("adapter_config" -> 'env')),
	"updated_at" = now()
WHERE jsonb_typeof("adapter_config" -> 'env') = 'object'
	AND pg_temp.paperclip_strip_claude_env("adapter_config" -> 'env') <> "adapter_config" -> 'env';
--> statement-breakpoint
UPDATE "environments"
SET
	"env_vars" = pg_temp.paperclip_strip_claude_env("env_vars"),
	"updated_at" = now()
WHERE jsonb_typeof("env_vars") = 'object'
	AND pg_temp.paperclip_strip_claude_env("env_vars") <> "env_vars";
--> statement-breakpoint
UPDATE "projects"
SET
	"env" = pg_temp.paperclip_strip_claude_env("env"),
	"updated_at" = now()
WHERE jsonb_typeof("env") = 'object'
	AND pg_temp.paperclip_strip_claude_env("env") <> "env";
--> statement-breakpoint
-- routines.updated_at is user-visible, so a backfill leaves it unchanged
-- (client.test.ts enforces this).
UPDATE "routines"
SET "env" = pg_temp.paperclip_strip_claude_env("env")
WHERE jsonb_typeof("env") = 'object'
	AND pg_temp.paperclip_strip_claude_env("env") <> "env";
--> statement-breakpoint
-- Routine runs resolve env from the revision snapshot, so scrub it there too.
UPDATE "routine_revisions"
SET "snapshot" = jsonb_set("snapshot", '{routine,env}', pg_temp.paperclip_strip_claude_env("snapshot" -> 'routine' -> 'env'))
WHERE jsonb_typeof("snapshot" -> 'routine' -> 'env') = 'object'
	AND pg_temp.paperclip_strip_claude_env("snapshot" -> 'routine' -> 'env') <> "snapshot" -> 'routine' -> 'env';
--> statement-breakpoint
DROP FUNCTION IF EXISTS pg_temp.paperclip_strip_claude_env(jsonb);
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp."claude_sub_secrets";
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp."claude_sub_definitions";
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp."claude_sub_default_companies";
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp."claude_sub_grants";
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp."claude_sub_connections";
--> statement-breakpoint
DROP FUNCTION IF EXISTS pg_temp.paperclip_is_claude_oauth_config_path(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS pg_temp.paperclip_is_claude_oauth_key(text);
