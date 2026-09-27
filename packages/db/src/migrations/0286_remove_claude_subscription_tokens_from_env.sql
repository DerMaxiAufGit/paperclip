-- Remove Claude subscription tokens from stored env maps that migration 0282
-- missed or that the widened token rules now cover.
--
-- Paperclip uses a Claude subscription only through the `claude` CLI that is
-- signed in on the server (doc/plans/2026-09-24-claude-cli-only-auth.md). It
-- never stores, forwards or injects a Claude sign-in. Migration 0282 removed
-- CLAUDE_CODE_OAUTH_TOKEN env entries from agents, environments, projects,
-- routines and routine revisions. This data-only migration removes, from every
-- env map below, each entry that
--   - has the key CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN,
--     ANTHROPIC_TOKEN, CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
--     CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, CCR_OAUTH_TOKEN_FILE,
--     CLAUDE_CODE_HOST_CREDS_FILE or CLAUDE_CODE_SESSION_ACCESS_TOKEN (trimmed,
--     case-insensitive, like isClaudeSubscriptionTokenEnvKey() in
--     packages/shared/src/validators/secret.ts), whatever its value form;
--   - has a plain value (a legacy inline string or {"type": "plain"}) whose
--     trimmed text starts with `sk-ant-oat` (OAuth access token), `sk-ant-ort`
--     (OAuth refresh token) or `sk-ant-sid` (Claude.ai session key),
--     case-insensitive, like isClaudeSubscriptionTokenValue(), whatever its key;
--   - is a user_secret_ref to the CLAUDE_CODE_OAUTH_TOKEN user-secret
--     definition that 0282 deleted.
-- Env maps:
--   A. issues.assignee_adapter_overrides -> adapterConfig -> env (missed by 0282);
--   B. approvals.payload of hire_agent approvals: payload -> adapterConfig -> env
--      and payload -> requestedConfigurationSnapshot -> adapterConfig -> env
--      (missed by 0282);
--   C. agents.adapter_config -> env, environments.env_vars, projects.env,
--      routines.env and routine_revisions.snapshot -> routine -> env (again,
--      for the widened rules).
-- The company_secret_bindings and user_secret_declarations rows that name one
-- of those keys as an env var (config path `env.<KEY>`) of an agent, project,
-- routine, environment or issue go too, since they only mirror the removed
-- env entries, and so do pending binding proposals for such a config path,
-- because approving one would write the key back into an agent env.
--
-- Not covered by SQL:
--   - An env entry under any other key that references a stored secret
--     (secret_ref or user_secret_ref) is kept, as is the secret: the value is
--     encrypted, so SQL cannot tell whether it holds a subscription token. The
--     runtime strips subscription tokens from every launch env instead.
--   - Credentials held in an external secret provider (AWS Secrets Manager,
--     GCP Secret Manager, Vault) live outside this database, so no SQL
--     statement can delete them. Removing an env entry here removes only
--     Paperclip's reference; the operator deletes the stored value in that
--     provider.
--
-- ANTHROPIC_API_KEY, gateway ANTHROPIC_AUTH_TOKEN values that are not
-- Claude.ai tokens, Bedrock, Vertex and Foundry settings, and every other
-- provider's env stay untouched. No schema, enum or column changes.
--
-- Timestamps: agents, environments and projects get a new updated_at, as in
-- 0282. Issues, routines and approvals keep theirs: issue and routine
-- timestamps are user-visible (client.test.ts enforces this), and an approval
-- timestamp records the board decision, not a data cleanup.
--
-- Replay-safe: each statement rewrites only rows that still hold a matching
-- entry, so a second run, or a database without such rows, changes nothing.
--
-- Helper functions live in pg_temp and are dropped at the end.
CREATE OR REPLACE FUNCTION pg_temp.paperclip_normalized_env_key(candidate text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT upper(regexp_replace(coalesce(candidate, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.paperclip_is_claude_token_env_key(candidate text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT pg_temp.paperclip_normalized_env_key(candidate) IN (
		'CLAUDE_CODE_OAUTH_TOKEN',
		'ANTHROPIC_OAUTH_TOKEN',
		'ANTHROPIC_TOKEN',
		'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
		'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
		'CCR_OAUTH_TOKEN_FILE',
		'CLAUDE_CODE_HOST_CREDS_FILE',
		'CLAUDE_CODE_SESSION_ACCESS_TOKEN'
	)
$$;
--> statement-breakpoint
-- Secret bindings, declarations and proposals address an env var as `env.<KEY>`.
CREATE OR REPLACE FUNCTION pg_temp.paperclip_is_claude_token_config_path(config_path text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT coalesce(config_path LIKE 'env.%' AND pg_temp.paperclip_is_claude_token_env_key(substr(config_path, 5)), false)
$$;
--> statement-breakpoint
-- True for a plain env value (legacy inline string or {"type": "plain"}) that
-- holds a Claude.ai credential (OAuth access or refresh token, session key), like
-- isClaudeSubscriptionTokenValue() in packages/shared/src/validators/secret.ts:
-- trimmed, case-insensitive prefix.
CREATE OR REPLACE FUNCTION pg_temp.paperclip_is_claude_token_value(binding jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT coalesce(
		lower(left(
			regexp_replace(
				CASE
					WHEN jsonb_typeof(binding) = 'string' THEN binding #>> '{}'
					WHEN jsonb_typeof(binding) = 'object'
						AND binding ->> 'type' = 'plain'
						AND jsonb_typeof(binding -> 'value') = 'string'
						THEN binding ->> 'value'
				END,
				'^[[:space:]]+',
				''
			),
			10
		)) IN ('sk-ant-oat', 'sk-ant-ort', 'sk-ant-sid'),
		false
	)
$$;
--> statement-breakpoint
-- Removes every Claude subscription token entry from an env map. A value that is
-- not a JSON object is returned unchanged.
CREATE OR REPLACE FUNCTION pg_temp.paperclip_strip_claude_token_env(env jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT CASE
		WHEN jsonb_typeof(env) = 'object' THEN coalesce((
			SELECT jsonb_object_agg(entry.key, entry.value)
			FROM jsonb_each(env) AS entry
			WHERE NOT (
				pg_temp.paperclip_is_claude_token_env_key(entry.key)
				OR pg_temp.paperclip_is_claude_token_value(entry.value)
				OR (
					jsonb_typeof(entry.value) = 'object'
					AND entry.value ->> 'type' = 'user_secret_ref'
					AND pg_temp.paperclip_normalized_env_key(entry.value ->> 'key') = 'CLAUDE_CODE_OAUTH_TOKEN'
				)
			)
		), '{}'::jsonb)
		ELSE env
	END
$$;
--> statement-breakpoint
-- A. Issue assignee overrides. The issue timestamp stays unchanged.
UPDATE "issues"
SET "assignee_adapter_overrides" = jsonb_set(
	"assignee_adapter_overrides",
	'{adapterConfig,env}',
	pg_temp.paperclip_strip_claude_token_env("assignee_adapter_overrides" -> 'adapterConfig' -> 'env')
)
WHERE jsonb_typeof("assignee_adapter_overrides" -> 'adapterConfig' -> 'env') = 'object'
	AND pg_temp.paperclip_strip_claude_token_env("assignee_adapter_overrides" -> 'adapterConfig' -> 'env')
		<> "assignee_adapter_overrides" -> 'adapterConfig' -> 'env';
--> statement-breakpoint
-- B. hire_agent approvals carry the requested adapter config twice: at
-- payload.adapterConfig (applied on approval) and in
-- payload.requestedConfigurationSnapshot (shown to the board).
UPDATE "approvals"
SET "payload" = jsonb_set(
	"payload",
	'{adapterConfig,env}',
	pg_temp.paperclip_strip_claude_token_env("payload" -> 'adapterConfig' -> 'env')
)
WHERE "type" = 'hire_agent'
	AND jsonb_typeof("payload" -> 'adapterConfig' -> 'env') = 'object'
	AND pg_temp.paperclip_strip_claude_token_env("payload" -> 'adapterConfig' -> 'env')
		<> "payload" -> 'adapterConfig' -> 'env';
--> statement-breakpoint
UPDATE "approvals"
SET "payload" = jsonb_set(
	"payload",
	'{requestedConfigurationSnapshot,adapterConfig,env}',
	pg_temp.paperclip_strip_claude_token_env("payload" -> 'requestedConfigurationSnapshot' -> 'adapterConfig' -> 'env')
)
WHERE "type" = 'hire_agent'
	AND jsonb_typeof("payload" -> 'requestedConfigurationSnapshot' -> 'adapterConfig' -> 'env') = 'object'
	AND pg_temp.paperclip_strip_claude_token_env("payload" -> 'requestedConfigurationSnapshot' -> 'adapterConfig' -> 'env')
		<> "payload" -> 'requestedConfigurationSnapshot' -> 'adapterConfig' -> 'env';
--> statement-breakpoint
-- C. The env maps 0282 scrubbed, again for the widened rules.
UPDATE "agents"
SET
	"adapter_config" = jsonb_set("adapter_config", '{env}', pg_temp.paperclip_strip_claude_token_env("adapter_config" -> 'env')),
	"updated_at" = now()
WHERE jsonb_typeof("adapter_config" -> 'env') = 'object'
	AND pg_temp.paperclip_strip_claude_token_env("adapter_config" -> 'env') <> "adapter_config" -> 'env';
--> statement-breakpoint
UPDATE "environments"
SET
	"env_vars" = pg_temp.paperclip_strip_claude_token_env("env_vars"),
	"updated_at" = now()
WHERE jsonb_typeof("env_vars") = 'object'
	AND pg_temp.paperclip_strip_claude_token_env("env_vars") <> "env_vars";
--> statement-breakpoint
UPDATE "projects"
SET
	"env" = pg_temp.paperclip_strip_claude_token_env("env"),
	"updated_at" = now()
WHERE jsonb_typeof("env") = 'object'
	AND pg_temp.paperclip_strip_claude_token_env("env") <> "env";
--> statement-breakpoint
-- The routine timestamp stays unchanged.
UPDATE "routines"
SET "env" = pg_temp.paperclip_strip_claude_token_env("env")
WHERE jsonb_typeof("env") = 'object'
	AND pg_temp.paperclip_strip_claude_token_env("env") <> "env";
--> statement-breakpoint
-- Routine runs resolve env from the revision snapshot, so scrub it there too.
UPDATE "routine_revisions"
SET "snapshot" = jsonb_set("snapshot", '{routine,env}', pg_temp.paperclip_strip_claude_token_env("snapshot" -> 'routine' -> 'env'))
WHERE jsonb_typeof("snapshot" -> 'routine' -> 'env') = 'object'
	AND pg_temp.paperclip_strip_claude_token_env("snapshot" -> 'routine' -> 'env') <> "snapshot" -> 'routine' -> 'env';
--> statement-breakpoint
-- Bookkeeping rows of the removed env entries. Only the targets whose env maps
-- are scrubbed above; a binding of another target keeps its row.
DELETE FROM "company_secret_bindings"
WHERE "target_type" IN ('agent', 'project', 'routine', 'environment', 'issue')
	AND pg_temp.paperclip_is_claude_token_config_path("config_path");
--> statement-breakpoint
DELETE FROM "user_secret_declarations"
WHERE "target_type" IN ('agent', 'project', 'routine', 'environment', 'issue')
	AND (
		pg_temp.paperclip_is_claude_token_env_key("env_key")
		OR pg_temp.paperclip_is_claude_token_config_path("config_path")
	);
--> statement-breakpoint
-- Approving a binding proposal writes a secret ref into the target agent's env,
-- so a pending proposal for a token env var goes. Resolved proposals are history
-- and hold no credential, so they stay.
DELETE FROM "company_secret_proposals"
WHERE "kind" = 'binding'
	AND "status" = 'pending'
	AND pg_temp.paperclip_is_claude_token_config_path("config_path");
--> statement-breakpoint
DROP FUNCTION IF EXISTS pg_temp.paperclip_strip_claude_token_env(jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS pg_temp.paperclip_is_claude_token_value(jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS pg_temp.paperclip_is_claude_token_config_path(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS pg_temp.paperclip_is_claude_token_env_key(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS pg_temp.paperclip_normalized_env_key(text);
