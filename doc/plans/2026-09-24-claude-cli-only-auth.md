# Claude subscription only through the server's own `claude` CLI

Date: 2026-09-24
Branch: `claude-cli-only-auth` (own fork, not for upstream)

## Goal

Paperclip uses a Claude subscription only by spawning the official `claude`
binary in headless mode (`claude --print --output-format stream-json`) on the
server Paperclip runs on. The server's service user has signed in to Claude
through Anthropic's own flow (`claude`, then `/login`). The CLI reads its own
login. Paperclip never reads, stores, forwards or injects Claude subscription
credentials.

Reference: Anthropic's Claude Code legal page says third-party developers may
not "offer Claude.ai login into their own applications", "route requests
through Free, Pro, or Max plan credentials on behalf of their users", or
"collect, store, or intermediate Claude.ai credentials or session tokens". The
Agent SDK overview says the same for agents built on the Agent SDK.

## Decisions (made by the user)

- Own fork. Remove the non-compliant features; no feature flag.
- Execution model: Paperclip runs on one server where `claude` is installed and
  signed in. Agents run there through the local binary. Remote targets (SSH,
  cloud sandboxes, runners) work only with an Anthropic Console API key.
- Existing stored Claude subscription tokens: delete them with a migration.
- Claude quota on the Costs page: keep it only if it comes from running the
  `claude` binary; otherwise drop it.
- "Login to Claude Code" (`POST /api/agents/:id/claude-login`, the run-page
  button, and `paperclipai agent claude-login`): remove it. On a server it
  cannot finish a sign-in, because nothing passes the code back to the CLI.
  Operators sign in on the server: run `claude` as the user Paperclip runs as,
  then `/login` (or `claude auth login`).
- Company imports that declare a `CLAUDE_CODE_OAUTH_TOKEN` input: skip it and
  report a warning in the import preview and result.
- ACP billing: runs that authenticate with a gateway `ANTHROPIC_AUTH_TOKEN`,
  Vertex, Foundry, or Bedrock are `metered_api`, never `subscription`.
- 2026-09-27, after the audit (see Phase 7):
  - Who may use the subscription: "only me". The subscription lane is for the
    server owner's own use; an instance with other users gets no
    subscription runs.
  - Claude usage on the Costs page: drop the usage scrape. Paperclip shows no
    Claude plan usage at all (this replaces the Phase 4 decision to keep a
    CLI-based `/usage` reading).
  - No concurrency cap on subscription runs.

## What stays

- The claude_local CLI engine running on the local host, with no injected
  auth, so the binary uses the service user's own login.
- Anthropic API-key auth (`ANTHROPIC_API_KEY` as a Paperclip secret),
  everywhere, including ACP and remote targets.
- Auth status checks that only run the binary (`claude auth status`).
- All other providers (OpenAI/Codex, Gemini, OpenRouter, …) unchanged.

## Status

- Phase 1: done. With `engine` unset (or the legacy `auto`), a local run with an API credential uses ACP (so API-key agents need no global `claude` binary), and every other run uses the CLI engine: a local run without an API credential, and every remote run. `filesystemScope`/`networkScope` keep an unset engine on CLI. ACP and remote targets need an API credential (API key, gateway `ANTHROPIC_AUTH_TOKEN`, Bedrock, or adapter-env Vertex/Foundry; a `sk-ant-oat` value never counts, and `ANTHROPIC_BEDROCK_BASE_URL` alone does not count). Subscription tokens are stripped from every child process (local, SSH, sandbox, ACP launch env, board chat, runtime services) and from the runner allowlist; Phase 7 widened this to more key names and to token values.
- Phase 2: done. Anthropic `subscription` method, host sign-in import, isolated Claude login homes, and `claude setup-token` capture are removed; `CLAUDE_CODE_OAUTH_TOKEN` is rejected as an env key in every persisted env map (server-side in secrets `normalizeEnvConfig`, plus request schemas for agent, project, routine, environment, issue overrides), in secret binding proposals, and is skipped with an import warning in company imports. Agent-created claude_local hires are never defaulted onto a managed Anthropic binding; a responsible user without an Anthropic default runs the agent on the server CLI.
- Phase 3: done. `ClaudeCliSignInStatus` replaces "Connect your Claude subscription" and shows `claude auth status` from the auth-signal route (with a "CLI not installed" state from reason `cli_missing`). It shows only when the target is this server; sandbox/SSH targets get API-key guidance, and a Paperclip Runner's Claude lane is API-key only. Onboarding blocks the hire when the CLI probe reports `claude_hello_probe_auth_required`.
- Phase 4: done, then narrowed in Phase 7. The OAuth usage call, credential file and Keychain reads, and `quota-probe.ts` are removed. The CLI `/usage` scrape that replaced them was removed in Phase 7: Paperclip shows no Claude plan usage.
- Phase 5: done. Migration `0282_remove_claude_subscription_credentials.sql` deletes stored Anthropic subscription AI connections with their grants, defaults, agent bindings and login sessions, the `CLAUDE_CODE_OAUTH_TOKEN` user secret of the removed `claude setup-token` flow with its captured values, and every `CLAUDE_CODE_OAUTH_TOKEN` env entry, binding, declaration and proposal. The follow-up migration `0283_remove_claude_subscription_tokens_from_env.sql` (Phase 7) covers the env maps 0282 missed and the widened token rules. Neither migration can delete a value held in an external secret provider (AWS Secrets Manager, GCP Secret Manager, Vault); the operator deletes those there.
- Login route removal: done. The `claude-login` route, `runClaudeLogin`, the
  OpenAPI entry, the UI client method and run-page button, and the CLI command
  are removed. A run that fails with `claude_auth_required` shows
  `ClaudeAuthRequiredRunGuidance` (the `ClaudeCliSignInStatus` panel plus an
  API-key hint). `detectClaudeLoginRequired` and its `loginUrl` extraction stay,
  because the CLI lane still puts `loginUrl` in the run's `errorMeta`.
- Company import warning: done. `readAgentEnvInputs`/`readProjectEnvInputs` add
  "Skipped CLAUDE_CODE_OAUTH_TOKEN for agent|project <slug>: …" to the
  preview/import warnings.
- Billing label (both engines): done. One classifier,
  `resolveClaudeBillingIdentity` in `credential-policy.ts`, serves the ACP
  engine (`resolveClaudeAcpBillingIdentity`) and the CLI engine (`execute.ts`).
  API key: `api`, biller `anthropic`. Bedrock/Vertex/Foundry: `metered_api`,
  biller `aws_bedrock`/`google`/`azure` (Costs page label "Microsoft Azure"
  added). Gateway `ANTHROPIC_AUTH_TOKEN`: `metered_api`, biller from the
  `ANTHROPIC_BASE_URL` host (`anthropic`, `openrouter`, else `unknown`).
  `ANTHROPIC_BEDROCK_BASE_URL` alone is not Bedrock. `subscription` only for a
  local CLI run with none of these; ACP and remote targets get `unknown`.
- Run failure guidance: `ClaudeAuthRequiredRunGuidance` takes the agent's
  `adapterConfig` and the run's `contextSnapshot`. ACP engine, an API credential
  in the adapter env, a managed Anthropic connection, or a non-local run
  environment get API-credential guidance and no server `/login` steps.
  Otherwise the panel checks the run's own environment and keeps the
  re-sign-in steps and Check again visible even when `claude auth status`
  reports a sign-in (an expired sign-in fails the run the same way).
- Phase 6: done. Docs updated (`docs/adapters/claude-local.md` "Running Claude on a server", adapter overview, AI Connections, SPEC, SPEC-implementation, install/deploy links); tests updated for removed paths.
- Phase 7: implemented. See [Phase 7: hardening after the 2026-09-27 audit](#phase-7-hardening-after-the-2026-09-27-audit).

## Phases

### 1. Runtime: only the local CLI lane uses a subscription

- Default engine (`resolveClaudeDefaultEngine` in
  `packages/adapters/claude-local/src/server/credential-policy.ts`, used by
  `resolveEngineSelection` in `acp.ts` and by the server's
  `resolveClaudeLocalEngine`): with `engine` unset or `auto`, a local run with
  an API credential (`claudeRunHasApiCredential`) uses ACP; every other run
  uses the CLI engine. An explicit `engine` wins; `filesystemScope` or
  `networkScope` keeps an unset engine on CLI.
- One gate, `resolveClaudeCredentialPolicyViolation`, serves the CLI engine,
  the ACP engine and the environment Test: a local CLI run always passes; the
  ACP engine and every remote target need an API credential and fail before
  launch without one (the ACP message points to `engine=cli`). The adapter
  never switches engines.
- Remove `CLAUDE_CODE_OAUTH_TOKEN` from provider env allowlists:
  `packages/adapter-utils/src/acpx-engine/execute.ts` (~597),
  `packages/paperclip-runner/src/drivers/acpx/environment.ts` (~31),
  `packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts`
  (~3282), `packages/paperclip-runner/runner/crates/runner-core/src/acpx_sidecar_transport.rs` (~99).
- claude_local on a remote target (SSH, sandbox, runner) requires an API
  credential; fail early with `CLAUDE_REMOTE_API_KEY_REQUIRED_MESSAGE`
  otherwise.

### 2. Server + shared: remove subscription-token intake and storage

- `packages/shared/src/ai-connections.ts`: remove the `anthropic` +
  `subscription` method (env key `CLAUDE_CODE_OAUTH_TOKEN`). Keep `anthropic`
  API key.
- `server/src/services/ai-connection-runtime.ts`: no subscription token
  injection for Anthropic.
- `server/src/services/local-ai-credentials.ts`,
  `server/src/services/local-ai-login.ts`,
  `server/src/routes/ai-connections.ts` (`/local`, `/local/check`): remove the
  Anthropic branches. Keep OpenAI/Codex branches working.
- `server/src/services/setup-token-transport-binding.ts` and related
  `claude setup-token` capture code: remove.

### 3. UI

- `ui/src/components/OnboardingWizard.tsx`,
  `ui/src/components/new-agent/AgentProviderConnection.tsx`,
  `ui/src/components/ai-connections/useLocalAiLogin.ts`: replace "Connect your
  Claude subscription" with a status panel: "Uses the claude CLI signed in on
  this server", showing the `claude auth status` result and how to sign in on
  the server. API key option stays. Follow `DESIGN.md` token rules and run
  `pnpm check:token-gates`.

### 4. Quota

- `packages/adapters/claude-local/src/server/quota.ts`: remove the code that
  reads the login and calls Anthropic's usage endpoint directly. Keep the
  CLI-based path only if it just runs the binary; otherwise drop Claude quota.
- Remove `packages/adapters/claude-local/src/cli/quota-probe.ts`.
- Superseded in Phase 7: the CLI `/usage` scrape is removed too, and
  `getQuotaWindows` returns no Claude windows.

### 5. Database

- Done: `0282_remove_claude_subscription_credentials.sql` deletes stored
  Anthropic subscription AI connections, their grants, env bindings and secret
  rows. Destructive; approved by the user.
- Done: follow-up `0283_remove_claude_subscription_tokens_from_env.sql` (see
  Phase 7).

### 6. Docs, tests, full check

- Update `docs/adapters/claude-local.md`, `docs/adapters/overview.md`, and
  `doc/SPEC-implementation.md` where it describes Claude subscription connect.
- Add a server setup section: install `claude` for the service user, sign in
  with `claude` then `/login` as that user, run Paperclip as that user.
- Update or delete tests for removed paths.
- `pnpm -r typecheck && pnpm test:run && pnpm build && pnpm check:token-gates`.

## Phase 7: hardening after the 2026-09-27 audit

The audit found paths where the server owner's Claude sign-in could still serve
other people or other tools, or where a token could still be stored or passed
on. User decisions: "only me" (owner-only lane), drop the usage scrape, no
concurrency cap.

- **Owner-only subscription lane.** The subscription lane is a claude_local run
  on this server with no API credential and no explicit `engine: "acp"`
  (`isClaudeSubscriptionLaneRun` in `credential-policy.ts`).
  `resolveClaudeSubscriptionEligibility` in
  `server/src/services/claude-subscription-policy.ts` allows it when the
  deployment mode is `local_trusted`, or when the mode is `authenticated` and
  the instance has at most one active human user. A human user is an auth user
  other than the synthetic `local-board` principal that holds an instance role
  or an active company membership; agents do not count. An `authenticated`
  instance that nobody has claimed yet (zero human users) is allowed too. The
  server registers its deployment mode at startup
  (`setClaudeSubscriptionDeploymentMode`). Enforced in the heartbeat before any
  workspace or process work (`configuration_incomplete`, reason
  `subscription_not_allowed`, action link to the agent's runtime page), in the
  environment Test route (check `claude_subscription_not_allowed`, no probe),
  and in the auth-signal route (status `absent`, reason
  `subscription_not_allowed`, which the sign-in panel shows as the owner-only
  message without sign-in steps). Board chat already runs only on
  `local_trusted`.
- **Trigger-source gate.** Even for the owner,
  `resolveClaudeSubscriptionTriggerViolation` refuses a subscription-lane run
  whose wake came from outside Paperclip (reason
  `claude_subscription_external_trigger`, `trigger` one of):
  - `chat_guest`: a chat message from a person not linked to a Paperclip user
    (a system-requested wake whose requester is a chat external principal);
  - `email`: an inbound email (requester `agentmail`, reason `email_received`,
    or a run context that names an email endpoint without a user wake);
  - `plugin`: `agents.invoke`, plugin agent sessions and plugin issue wakeups,
    which is also how plugin webhooks reach agents, and the comments,
    interaction responses and approval decisions a plugin relays for a user
    (context source `plugin:<pluginKey>…`);
  - `routine_webhook`: a task created by a routine's public webhook trigger
    (routine run source `webhook`).

  A wake that no Paperclip user requested (system or agent, for example the
  recovery liveness dispatch of a stranded task) is also refused on a task that
  came from outside: origin `plugin:…` (plugin tasks, including a
  plugin-managed routine's `plugin:<key>:operation` task, `plugin`), a
  `chat_channel` email conversation (origin id `email:…` or `email-send:…`,
  `email`), a `chat_channel` conversation a chat guest started (the issue
  carries `sourceTrust`, `chat_guest`), and a routine webhook task. Owner-driven
  wakes stay allowed: assignments and comments by a Paperclip user, timers and
  heartbeats, scheduled routines, agent delegation, linked chat users, and
  follow-up wakes on a chat conversation a linked user started. A new chat endpoint for a claude_local agent on the subscription
  lane starts with `allowUnlinkedPeople: false`.
- **Token blocking by value and by widened key names.** Subscription token
  keys are `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`,
  `ANTHROPIC_TOKEN`, the refresh-token sign-in `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`
  (read by the bundled `claude` binary with `CLAUDE_CODE_OAUTH_SCOPES`), and the
  sign-in handoffs `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`,
  `CCR_OAUTH_TOKEN_FILE`, `CLAUDE_CODE_HOST_CREDS_FILE` and
  `CLAUDE_CODE_SESSION_ACCESS_TOKEN` (trimmed, any case;
  `CLAUDE_SUBSCRIPTION_TOKEN_ENV_KEYS` in
  `packages/shared/src/validators/secret.ts`). A value that starts with
  `sk-ant-oat` (OAuth access token), `sk-ant-ort` (OAuth refresh token) or
  `sk-ant-sid` (Claude.ai session key), trimmed and in any case, is a
  subscription token under any key (`CLAUDE_SUBSCRIPTION_TOKEN_VALUE_PREFIXES`). Env
  map request schemas and `normalizeEnvConfig` reject both; company and user
  secret create and rotate paths reject a token value; company imports skip the
  keys with a warning; every spawned process, remote env, ACP child env, board
  chat child, runner ACPX launch env, heartbeat env binding, and workspace
  runtime service and workspace command env (after the adapter and service env
  overrides are merged) drops both; a
  managed AI connection whose stored value is a token is refused; a token never
  counts as an API credential under `ANTHROPIC_API_KEY` or
  `ANTHROPIC_AUTH_TOKEN`.
- **Third-party harness guard.** Only the official `claude` binary may use a
  Claude subscription (`packages/adapter-utils/src/claude-subscription-harness-guard.ts`).
  Hermes (provider `anthropic`, or `auto` when `~/.hermes/config.yaml` selects
  it), OpenCode (`anthropic/...` models) and Pi (`anthropic/...` or bare
  `claude*` models) refuse an Anthropic run without an API key in the env the
  harness gets (Hermes and OpenCode: `ANTHROPIC_API_KEY`; Pi: also
  `ANTHROPIC_AUTH_TOKEN`), with a non-retryable `adapter_engine_unavailable`.
  An allowed run hides the harness's stored logins: Hermes gets an empty
  `CLAUDE_CONFIG_DIR`, OpenCode gets `OPENCODE_AUTH_CONTENT={}`, Pi gets a
  managed agent dir without `auth.json`. Anthropic models reached through
  another provider (OpenRouter, Bedrock, Vertex, a gateway) are not affected.
  The provider and model flags in the agent's `extraArgs`/`args` count too,
  since they follow Paperclip's own flags (`readHarnessCliFlagValues`): Hermes
  `--provider`, `-m`/`--model` (with `=` forms and argparse abbreviations), Pi
  `--provider`/`--model`, OpenCode `-m`/`--model`. Each adapter's environment
  Test reports the same error.
- **Claude usage scrape removed.** `getQuotaWindows` returns an empty `ok`
  result without running or reading anything; `fetchClaudeCliQuota`,
  `captureClaudeCliUsageText` and `parseClaudeCliUsageText` are gone, and the
  Costs page has no Claude subscription quota section
  (`ClaudeSubscriptionPanel` removed). `claude auth status` stays for the
  sign-in panel.
- **Startup cleanup no longer reads credential files.**
  `server/src/services/claude-login-home-cleanup.ts` recognizes a leftover
  Claude login home only by which regular files exist (`.claude.json`,
  `.credentials.json`, `credentials.json`), never opens them, and skips any home
  that holds a Codex/Grok `auth.json`.
- **Runner fail-early.** The heartbeat refuses a Paperclip Runner Claude ACPX
  run before launch without a non-token `ANTHROPIC_API_KEY` in the run env
  (`configuration_incomplete`, reason `claude_api_key_required`). The runner's
  `prepareAcpxRuntimeSandbox` refuses the Claude lane before any filesystem
  work (`assertClaudeAcpxApiCredential`), and its ACPX launch env drops any
  `sk-ant-oat` value.
- **Remote `CLAUDE_CONFIG_DIR` staging fix.** Neither engine forwards an
  operator `CLAUDE_CONFIG_DIR` into a sandbox, including a path inside the
  staged workspace (it was remapped before, which shipped that directory's
  sign-in); a sandbox run always gets the managed config seed. On every remote
  target (sandbox and SSH) and both engines, the sign-in files of every Claude
  config dir inside the workspace (the agent's `CLAUDE_CONFIG_DIR`, the
  server's `CLAUDE_CONFIG_DIR`, `~/.claude`) are excluded from the workspace
  upload and from the sync-back, and the config seed is staged without sign-in
  files. The SSH transport now honours `workspaceExclude` for its tar upload
  and its restore baseline (matched at any depth, so the restore never reads an
  excluded local file as deleted).
- **Follow-up migration.** `0283_remove_claude_subscription_tokens_from_env.sql`
  removes, from issue assignee overrides and `hire_agent` approval payloads
  (both missed by 0282) and again from agent, environment, project, routine and
  routine-revision env maps, every entry with a token key, a plain `sk-ant-oat`
  value, or a `user_secret_ref` to the deleted `CLAUDE_CODE_OAUTH_TOKEN`
  definition. It deletes the matching secret bindings, declarations and pending
  binding proposals. It cannot inspect encrypted secret values under other
  keys (the runtime strips those) and cannot delete values in an external
  secret provider.

## Remaining grey area

- Anthropic's own headless mode is what this uses, but running many agents
  around the clock on one subscription may still be judged outside "ordinary
  use". There is no concurrency cap (user decision); plan usage limits apply as
  normal, and Paperclip does not show them.
- The owner-only check counts Paperclip accounts, not people. One account
  shared by several people, or a `local_trusted` instance exposed through a
  tunnel or reverse proxy, passes the check.
- The trigger-source gate reads how a run was woken, not where its content came
  from. Agent delegation is allowed, so an external trigger that first wakes an
  API-key agent can reach a subscription-lane agent through a delegated task,
  and a task the owner creates can carry text from outside.
- Paperclip decides the subscription lane from the agent and server env only.
  A claude_local agent that bills through an `apiKeyHelper` or an API key or
  Bedrock/Vertex/Foundry flag in the `claude` CLI's own `settings.json` counts
  as subscription-lane, so the owner-only and trigger-source gates refuse it
  where they apply; the refusal message and docs tell users to move the setting
  into the agent env. An explicit "API-billed" agent flag, or a key-name-only
  scan of `settings.json`, would need a product decision.
- Third-party harnesses count only an Anthropic key in the agent or server env.
  A key kept in the harness's own store (`~/.hermes/.env` or `config.yaml`,
  OpenCode `auth.json`/`opencode.json`, Pi `auth.json`) no longer counts, which
  breaks setups that relied on it until the key is moved into the agent env.
  Paperclip does not read those files because they can hold a Claude sign-in;
  counting such a key (for example by a key-name-only scan of
  `~/.hermes/.env`) would need a product decision. An Anthropic OpenCode run
  hides every stored OpenCode login (`OPENCODE_AUTH_CONTENT={}`), and a remote
  Anthropic Pi run gets an empty agent dir; narrowing that would need reading
  the stored logins (OpenCode) or a remote copy step (Pi).
- The harness guards classify a run by its main provider and model. Hermes
  auxiliary or fallback providers in `~/.hermes/config.yaml`, and an OpenCode
  `small_model` or subagent on `anthropic/…` from `opencode.json`, are not
  inspected; Hermes non-Anthropic runs keep the real `CLAUDE_CONFIG_DIR`.
- The trigger-source gate lets system follow-up wakes through on a chat
  conversation a linked user started, even after a chat guest posted in it.
- Encrypted secrets under other keys can still hold a subscription token
  stored before this branch; the runtime drops the value at launch, but it stays
  stored until the owner deletes it.
