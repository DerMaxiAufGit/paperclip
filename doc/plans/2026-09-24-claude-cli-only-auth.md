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
- Phase 5: done. Migration `0285_remove_claude_subscription_credentials.sql` deletes stored Anthropic subscription AI connections with their grants, defaults, agent bindings and login sessions, the `CLAUDE_CODE_OAUTH_TOKEN` user secret of the removed `claude setup-token` flow with its captured values, and every `CLAUDE_CODE_OAUTH_TOKEN` env entry, binding, declaration and proposal. The follow-up migration `0286_remove_claude_subscription_tokens_from_env.sql` (Phase 7) covers the env maps 0285 missed and the widened token rules. Neither migration can delete a value held in an external secret provider (AWS Secrets Manager, GCP Secret Manager, Vault); the operator deletes those there. The two migrations were first numbered 0282 and 0283; see the renumbering note under "5. Database".
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
  local CLI run with none of these; ACP and remote targets get `unknown`. On
  the CLI engine, a credential that the inline `--settings` env in the extra
  args takes away does not count, as in the lane gates.
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

- Done: `0285_remove_claude_subscription_credentials.sql` deletes stored
  Anthropic subscription AI connections, their grants, env bindings and secret
  rows. Destructive; approved by the user.
- Done: follow-up `0286_remove_claude_subscription_tokens_from_env.sql` (see
  Phase 7).
- Renumbered on 2026-09-28. Upstream took migration numbers 0282 to 0284
  (`0282_colossal_shocker`, `0283_jittery_psynapse`, `0284_petite_genesis`), so
  the fork's `0282_remove_claude_subscription_credentials.sql` and
  `0283_remove_claude_subscription_tokens_from_env.sql` became 0285 and 0286.
  Their SQL content is byte-for-byte unchanged, so the comments inside 0286
  still say "0282". The migration runner in `packages/db/src/client.ts`
  identifies an applied migration by the sha256 of its content, not by its file
  name or journal position. A database that already applied the fork
  migrations under the old names treats 0285 and 0286 as applied, and applies
  upstream's 0282 to 0284 once, after them. On every later upstream merge, do
  the same: keep upstream's journal and snapshots, move the fork migrations
  after upstream's newest number with their content unchanged, append their
  journal entries with larger `when` values, and chain their snapshots (copies
  of upstream's newest snapshot, because the fork migrations change no schema).

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
  message without sign-in steps). In the Test route the lane is the probe's
  lane, decided on the env the probe child gets, not the agent's run lane
  (see the endpoint bullet). When the Test route does run a
  subscription-lane probe for a caller that is not the board (an agent key
  with `agents:create`), the server fixes the probe
  (`claudeSubscriptionProbeConfigForActor` in
  `server/src/services/claude-subscription-probe.ts`): the caller's
  `extraArgs`/`args` are replaced by `--setting-sources user
  --strict-mcp-config --no-session-persistence`, permissions are not skipped,
  `--chrome` is off, it runs one turn, and the adapter's default hello timeout
  applies. So project settings and `.mcp.json` in the caller-chosen `cwd` are
  not loaded. The board keeps the full probe, and an agent's API-key probe is
  unchanged. Board chat runs only on `local_trusted` and
  only for the board; an agent key gets 403 before the `claude` CLI is
  spawned. Board chat runs `claude` in one stable 0700 folder per company,
  `<instanceRoot>/board-chat/<companyId>`, with `--setting-sources user
  --strict-mcp-config --no-session-persistence`, so anything planted in a
  shared folder such as /tmp (`.claude/settings.json`, `.mcp.json`,
  `CLAUDE.md`) no longer reaches it. On every use the folder (and its
  `board-chat/` parent) is checked to be a real directory, not a symlink,
  owned by the Paperclip process user, is set back to 0700, and is emptied
  before the run; it is not deleted afterwards. The reason: claude 2.1.x
  creates `<CLAUDE_CONFIG_DIR>/projects/<slug-of-cwd>/` (memory/, sessions/,
  backups/) even with `--no-session-persistence`, so a new folder per request
  left one project dir per message in the operator's Claude config dir. Only
  one board chat per company runs at a time: a second request gets 429
  `BOARD_CHAT_BUSY`, or an SSE error when it passed the first check while the
  other was starting. A `companyId` that is not a safe path segment gets 400.
  With no API credential, it refuses with
  403 `CLAUDE_SUBSCRIPTION_ENDPOINT_REFUSED` when the server env fails
  `resolveClaudeSubscriptionEndpointViolation`; the Conference Room shows the
  `error` text of any 4xx. The heartbeat treats a run as remote, and so
  outside both gates, only when its environment driver really gives the
  adapter a remote execution target: ssh or sandbox, for adapters that
  support remote managed environments (`claudeSubscriptionTargetIsRemote` in
  `server/src/services/claude-subscription-target.ts`, which mirrors
  `resolveEnvironmentExecutionTarget`). Any other driver, such as a plugin
  environment driver, resolves to no target and runs the adapter on this
  server, so both gates apply. The helper copies the driver branches of
  `resolveEnvironmentExecutionTarget` by hand: on an upstream merge that adds
  a driver with a remote target, add it there. Until then such a run counts as
  local and gets the gates, which is the fail-closed side.

  A `process` agent whose command starts the `claude` binary directly gets
  both gates as a claude_local CLI run (`claudeSubscriptionGateInput` and
  `isProcessClaudeCommand` in `claude-subscription-target.ts`). That covers a
  command whose basename is `claude` (any path or case, with or without
  `.exe`/`.cmd`/`.bat`/`.ps1`); `npx`, `pnpx`, `bunx`, `npm`, `pnpm`, `yarn`,
  `bun` or `node` with an argument before `--` (or a `--flag=value` value)
  naming `claude`, `@anthropic-ai/claude-code`, or a file in that package; and
  `env [flags] [NAME=VALUE]...` in front of either, with nested `env` wrappers
  read at any depth. The gates apply the `env` wrappers in order, as `env`
  does, to the agent env and the server env: `-i`/`-`/`--ignore-environment`
  drop both, `-u NAME` (also `--unset[=]NAME`, abbreviations, `-iu NAME`)
  drops NAME from both, then the `NAME=VALUE` assignments apply.
  `-a`/`--argv0 ARG` and `-0`/`--null` are known flags that leave the env
  alone, and an arg `=VALUE` is an assignment. An `env` chain Paperclip cannot
  read exactly (an unknown or ambiguous flag, or an `env -S` string with
  quotes, backslashes, `${VAR}` or `#`) counts as clearing the env and the
  host env, so it lands on the subscription lane, and no wrapper assignment
  counts as an API key. Such a chain counts as a claude run when any later arg
  names `claude` or `@anthropic-ai/claude-code`. The endpoint check before
  spawn reads the agent env plus every assignment, so a redirect key that a
  wrapper flag clears or unsets still refuses; it reads `-S` assignments
  without their quotes, with `${NAME}` removed from names. `env -- NAME=VALUE
  claude` counts too. The process config's `engine` and `managedAiConnection`
  keys are ignored.

  An agent of any other adapter (codex_local, kimi_local, gemini_local,
  grok_local, cursor, opencode_local, pi_local, hermes_local through `command`
  or `hermesCommand`, or a plugin adapter) whose command starts `claude` is
  refused in the heartbeat on every target, before any workspace or process
  work (`configuration_incomplete`, reason `claude_command_on_other_adapter`;
  `claudeCommandOnOtherAdapterRefusal` in `claude-subscription-target.ts`).
  Such an adapter spawns its command with the server's env and home, so
  `claude` would use the server's sign-in with none of the claude_local rules.
  The command is recognised as for a process agent, with the adapter's
  `extraArgs` and `args` as the args. The environment Test refuses such a
  config the same way (check `claude_command_on_other_adapter`,
  `claudeCommandOnOtherAdapterTestCheck` in `claude-subscription-probe.ts`)
  before the adapter's own Test, which would run the command for a version
  check or hello probe; so does the Test of a managed AI connection adoption.
- **Trigger-source gate.** Even for the owner,
  `resolveClaudeSubscriptionTriggerViolation` refuses a subscription-lane run
  whose wake came from outside Paperclip (reason
  `claude_subscription_external_trigger`, `trigger` one of):
  - `chat_guest`: a chat message from a person not linked to a Paperclip user
    (a system-requested wake whose requester is a chat external principal).
    A chat wake (its id is an `inbound_wakeup` or `failed_run_retry` chat
    action) attributed to a user whose chat account has no `linked` identity
    link to that user on the endpoint counts too, whatever the wake's
    requester type; so does a GitHub automatic review whose delivery is marked
    `githubAuthority.guest` or whose pull request author or event sender is not
    linked to the user (chat-channels attributes these to the configured
    responsible user). A chat wake that passes these link checks counts as the
    user's own wake, the same as the user's comment from the Paperclip UI, so
    it skips the task-origin check below. This b4138da46 rule was restored on
    2026-09-28, after an interim change had sent every chat wake through the
    origin check, which refused the owner's own linked-chat message on a
    conversation a chat guest had started;
  - `email`: an inbound email (requester `agentmail`, reason `email_received`,
    or a run context that names an email endpoint without a user wake);
  - `plugin`: `agents.invoke`, plugin agent sessions and plugin issue wakeups,
    which is also how plugin webhooks reach agents, and the comments,
    interaction responses and approval decisions a plugin relays for a user
    (context source `plugin:<pluginKey>…`). Those relayed wakes also carry the
    plugin's `pluginId` in their wake payload, so the marker survives a later
    wake (for example the agent's timer wake) that coalesces into the run and
    replaces the context `source`;
  - `routine_webhook`: a task created by a routine's public webhook trigger
    (routine run source `webhook`);
  - `task_bridge`: a wake requested by an agent that held a `task_bridge` agent
    API key which was not revoked when the wake was requested. These keys serve
    internet-facing chat and webhook bridges (for example a Hermes gateway).
    A wake names the requesting agent, not the key it used, and a bridge key
    may reassign a task of its own agent to an allowed agent, so every
    agent-requested wake from such an agent counts, including delegation from
    the agent's own runs. A routine run such an agent started or shaped counts
    too (see the `routine_execution` rule below).

  A wake that no Paperclip user requested (system or agent, for example the
  recovery liveness dispatch of a stranded task) is also refused on a task that
  came from outside:
  - origin `plugin:…` (plugin tasks, including a plugin-managed routine's
    `plugin:<key>:operation` task, `plugin`);
  - a `routine_execution` task of a plugin-managed routine (`plugin`). The
    routine comes from the task's routine run, or from its origin id, because
    the managed issue template may set its own origin id. A
    `plugin_managed_resources` row with `resource_kind` `routine` marks it. This
    covers every run source, since the plugin's `ctx.routines.managed.run` is
    recorded as a manual run without a user and a plugin webhook can drive it.
    The one exception is a manual run a Paperclip user started from the board
    (the task's `createdByUserId` is set);
  - a `task_bridge` task, created through a task bridge key (origin id = key
    id, `task_bridge`);
  - a `chat_channel` email conversation (origin id `email:…` or `email-send:…`,
    `email`);
  - a `chat_channel` conversation a chat guest started (the issue carries
    `sourceTrust`, `chat_guest`);
  - a routine webhook task (`routine_webhook`);
  - a task a plugin last assigned, moved or unblocked (`plugin`). A plugin can
    change the assignee or status of any task in its company through
    `issues.update` without changing the task's origin, and the recovery
    liveness dispatch then runs the task. The only trace is the plugin's
    `activity_log` row. The gate reads, in one query on the issue's activity
    rows, the newest row that is either a Paperclip user's activity or a plugin
    edit, and refuses when that row is the plugin edit. A plugin edit is an
    `issue.updated` row whose `patch` sets any field other than title,
    description, priority, labels or billing code (so assignee, status,
    blockers, origin fields, creator and workspace fields all count), or an
    `issue.relations.updated` row that does not only add blockers. Any later
    activity of a Paperclip user on the task lifts the refusal. An agent's
    activity does not, and neither does a passive user row
    (`PASSIVE_USER_ISSUE_ACTIONS` in `claude-subscription-policy.ts`, added
    2026-09-28): upstream's inbox markers `issue.read_marked`,
    `issue.read_unmarked`, `issue.inbox_archived`, `issue.inbox_unarchived` and
    `issue.inbox_touched` (IssueDetail marks a task read on every page load, so
    before this change the owner merely opening a plugin-edited task let the
    next system wake run it), plus `issue.conversation_opened`,
    `issue.feedback_vote_saved`, `issue.tree_control_previewed`,
    `issue.attribution_spoof_rejected`, `external_object.refresh_requested` and
    every `issue.file_resource_…` row (workspace file reads, which the task page
    also makes on its own). Upstream's own lists
    (`ACTIVITY_GATE_IGNORED_ACTIONS` in `services/routines.ts`,
    `ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS` in `services/issues.ts`) are not
    exported, so the fork keeps its own list; on an upstream merge that adds a
    passive user action on issues, add it there;
  - a `routine_execution` task whose routine run a task bridge key may have
    started or shaped (`task_bridge`, `routineRunMayComeFromTaskBridge`, added
    2026-09-28). `routes/routines.ts` does not apply a task bridge key's scope:
    the key can create a routine assigned to its own agent and run it with
    `POST /routines/:id/run` and body `{ assigneeAgentId: <other agent>,
    source: "manual" | "api" }`. The run's wake has no requester, so the wake
    rule above never saw the bridge. Refused, unless a Paperclip user started
    the run (a manual run records the user as the task's `createdByUserId`; the
    route's `routine.run_triggered` activity row on the routine run names the
    user or agent of a manual or api run):
    - the run was started by an agent that held a live task bridge key at the
      time (the task's `createdByAgentId` of a manual run, or the agent of the
      `routine.run_triggered` row). The activity row carries the agent but not
      the key (`logActivity` uses `agentApiKeyId` only to find the responsible
      user), so the rule is close to the wake rule: the agent held a task
      bridge key that already existed then (counting from five minutes before
      its created_at, for clock skew between the database and the server) and
      was not revoked then;
    - a manual or api run names no user and no agent while some agent of the
      company held a live task bridge key when the run was triggered (created
      by then, less five minutes, and not revoked). The route
      writes `routine.run_triggered` only after the run is queued, so an api
      run can start before its row exists; a pipeline stage entry
      (`runPipelineStageEntryRoutine`, source `api`) writes none. Both fail
      closed in a company with a live task bridge key and pass in one without.
      A task whose routine run is gone counts as such a run. A routine api run
      triggered before any task bridge key existed stays allowed;
    - an agent that held a live task bridge key created the routine, created
      any of its revisions, or created the trigger that fired the run, at the
      time it wrote them. This covers every source, including scheduled runs
      after the owner reassigned the routine to another agent, because the
      bridge wrote the routine. A key counts from its created_at (less five
      minutes) because a key's scope cannot change after it is created. So a
      routine an agent wrote before the owner gave it a task bridge key stays
      the owner's. Every later edit of the routine or its triggers (update,
      trigger create/update/delete, secret rotation, revision restore) appends
      a revision, so a bridge edit of an older routine is still refused.

  Owner-driven wakes stay allowed: assignments and comments by a Paperclip
  user, timers and heartbeats, scheduled routines (unless a task bridge agent
  created or edited the routine or its trigger), routine runs a Paperclip user
  started (the board's Run now, or an api run with a board login once its
  `routine.run_triggered` row exists), the owner's manual run of a
  plugin-managed routine, agent delegation (except from an agent with a live
  task bridge key), linked chat users (also on a conversation a chat guest
  started), and follow-up wakes on a chat conversation a linked user started.
  A new chat endpoint for a claude_local agent on the subscription lane starts
  with `allowUnlinkedPeople: false`.
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

  Runtime secret resolution (`resolveEnvBindings` and
  `resolveAdapterConfigForRuntime` in `server/src/services/secrets.ts`) never
  resolves a secret bound under a token key, and drops any resolved value that
  is a token: a company or user secret, a legacy plain value, or an adapter
  schema secret field such as the Hermes gateway `apiKey`. That covers every
  caller: the heartbeat, the environment Test, skills list/sync and the
  auth-signal key checks. A dropped entry gets no `secretKeys` or manifest
  entry, and the server logs a warning naming the company and config path,
  never the value. The heartbeat's `dropResolvedClaudeSubscriptionTokens`
  stays as defence in depth.

  `POST /companies/:companyId/ai-connections` refuses an `apiKey` that is a
  token value, for any provider, with 422 and
  `CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE`, before body validation,
  authorization, storage or any provider call. `validateAiApiKey` refuses it
  too, which also covers re-verifying a stored key when an agent adopts a
  managed connection; `createAiConnectionSchema` has the same refinement.

  `paperclipai onboard` and `paperclipai configure` refuse a token at the LLM
  API key prompt, and `llmConfigSchema.apiKey` refuses one. A config file that
  already holds one in `llm.apiKey` still loads, because a validation error
  would stop the server from starting; the token is dropped from the loaded
  config with a one-time warning, so neither the server (OpenAI model listing)
  nor `paperclipai doctor` sends it anywhere, and the next config write removes
  it from the file.

  Every adapter config leaf is checked, not only `env`: the http adapter sends
  `headers` and `payloadTemplate` to its URL, and the OpenClaw gateway sends
  `headers` and `authToken`. Saving an adapter config refuses a subscription
  token in any string value or object key at any depth (422; `details.path`
  names the config path, never the value; a container nested deeper than 32
  levels is refused with `adapter_config_too_deep`). At runtime,
  `resolveAdapterConfigForRuntime` drops such a leaf from a config stored
  before this check (an array element is blanked so positions do not shift)
  and logs the company id and config path. A token counts both as a whole
  value and inside a longer string (`sk-ant-oat`, `sk-ant-ort` or `sk-ant-sid`
  followed by a digit), such as `Authorization: Bearer sk-ant-oat01-…` or an
  `ANTHROPIC_CUSTOM_HEADERS` value; the same applies to env values and secret
  values checked in `server/src/services/secrets.ts`.
- **Subscription endpoint check.** With no API credential, the `claude` binary
  sends the server's Claude sign-in (`Authorization: Bearer sk-ant-oat…`) to
  whatever endpoint its env names (verified with claude 2.1.280).
  `resolveClaudeSubscriptionEndpointViolation` in `credential-policy.ts`,
  called from the local-CLI branch of `resolveClaudeCredentialPolicyViolation`
  for subscription-lane runs only, refuses a run whose adapter config env sets
  any of:
  - `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_API_BASE_URL` to anything other than
    `https://api.anthropic.com` (URL host exactly `api.anthropic.com`, the
    binary's own first-party test; an unparseable value is refused);
  - `ANTHROPIC_UNIX_SOCKET`;
  - `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, or
    `NODE_TLS_REJECT_UNAUTHORIZED` other than `1`;
  - `BUN_INSPECT*`, `BUN_OPTIONS`, `LD_PRELOAD`, `LD_AUDIT` or
    `DYLD_INSERT_LIBRARIES`;
  - `NODE_OPTIONS` with a debugger, code-loading, `--env-file` or
    `--tls-keylog` flag.

  The adapter config env covers the agent, project, environment and routine
  env and issue overrides. The same rules apply to the `env` of an inline
  `--settings` JSON in `extraArgs`/`args`. Keys match in any case, and an
  unresolved binding under a checked key fails closed. The server's own
  process env is the operator's and is not checked for claude_local runs;
  board chat, whose child env is the server env, checks it (see the owner-only
  bullet). The run fails with
  `adapter_engine_unavailable` before launch; the environment Test reports the
  same message and runs no probe. API-key, gateway (`ANTHROPIC_AUTH_TOKEN`)
  and Bedrock/Vertex/Foundry runs keep custom endpoints.

  The environment Test classifies the local CLI probe on the env its child
  gets: `pickLocalProbeCallerEnv` and `claudeLocalTestProbeConfig` in
  `credential-policy.ts` pick the allowlisted part of the adapter env (the
  probe env builder in `probe-env.ts` uses the same function), and
  `isClaudeSubscriptionLaneRun({ localTestProbe: true })` classifies on it
  (route helper `isClaudeSubscriptionLaneTestProbe` in
  `claude-subscription-probe.ts`). The Vertex and Foundry flags are not in the
  allowlist, so a Vertex- or Foundry-only agent on the CLI engine is metered
  for runs, but its Test probe runs on the sign-in. The owner-only gate
  (`claude_subscription_not_allowed`), the server-fixed probe for non-board
  callers, and the endpoint check (probe env plus inline `--settings` env,
  reported as `adapter_engine_unavailable`, no probe) all apply to it, and the
  Test adds the info check `claude_probe_uses_cli_sign_in`. The probe env
  drops a caller `ANTHROPIC_BASE_URL` unless the child gets an API credential
  or the URL names api.anthropic.com. A Test whose engine resolves to ACP is
  not gated, because it starts no claude CLI.

  Paperclip decides the lane from the env the `claude` binary uses. The inline
  `--settings` env in `extraArgs`/`args` is applied over the agent and server
  env (verified with claude 2.1.283: `{"env":{"ANTHROPIC_API_KEY":""}}` makes
  the binary drop the key and use the server's sign-in). A settings-env entry
  for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
  `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY` whose value does not count by
  itself (empty, whitespace, `0`, a token, a non-string) takes that credential
  away, so the run is on the subscription lane: the endpoint check, owner-only
  gate and trigger-source gate apply. The settings never add a credential, and
  an `apiKeyHelper` in them does not count, because the binary ignores the
  whole `--settings` JSON when any field fails its schema and skips a
  `--settings` token that is another flag's value. A CLI run on any target is
  refused before launch when an inline `--settings` value is not valid JSON,
  or when its env carries a subscription token key or value. The ACP engine
  never gets these args, so they do not affect it.

  The process adapter runs the same check before it spawns a command that
  starts `claude` (see the owner-only bullet) on the subscription lane
  (`resolveProcessClaudeSubscriptionRefusal`). It reads the agent env, the
  `env` wrapper assignments, and inline `--settings` JSON in `args`. An `env`
  chain it cannot read exactly is also refused when it has a `${VAR}`
  anywhere in an `env -S` string, or assigns a name that is empty or not a
  plain variable name once any `${VAR}` is dropped, because `env` may then set
  any key; a process claude agent never needs either. The run fails with
  `adapter_engine_unavailable` and nothing is spawned.
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
  files. Every `config-seed` asset (the CLI and ACP runs and the sandbox Test
  probe) goes through `claudeConfigSeedAsset` in `claude-config.ts`: it
  excludes `.credentials.json`, `credentials.json`, `.claude.json`, the
  `backups` folder and the legacy `.claude.json.backup` at any depth, plus
  the timestamped `.claude.json` copies in the seed root by exact name, and is
  staged with `followSymlinks: false`, so a link planted in a managed AI
  connection's config dir cannot pull a host file along (added 2026-09-28).
  Only `prepareManagedAiRuntime` marks a run as a managed AI connection,
  which is what makes the adapter stage the agent's
  `CLAUDE_CONFIG_DIR` as the seed: `resolveExecutionRunAdapterConfig` in the
  heartbeat drops a `managedAiConnection` stored in an agent's adapter config,
  and the adapter test-environment route drops a caller-supplied one. The SSH
  transport now honours `workspaceExclude` for its tar upload
  and its restore baseline (matched at any depth, so the restore never reads an
  excluded local file as deleted).
- **Remote staging never forwards a Claude sign-in, for every adapter.** The
  generic staging layer (`prepareSandboxManagedRuntime`, which
  `prepareCommandManagedRuntime` also uses, and `prepareRemoteManagedRuntime`
  for SSH) merges `claudeSignInWorkspaceExcludes` from
  `packages/adapter-utils/src/claude-config-credential-excludes.ts` into the
  caller's workspace excludes, for both the upload and the sync-back. They
  cover the sign-in files (`.credentials.json`, `credentials.json`) of any
  `.claude` dir at any depth and any `.claude.json` at any depth, plus, when
  they sit inside the workspace, the sign-in files and `.claude.json` of the
  server's `CLAUDE_CONFIG_DIR`, the sign-in files of `~/.claude`, and
  `~/.claude.json`. They also cover Claude Code's copies of `.claude.json`
  (claude 2.1.283 writes `<config dir>/backups/.claude.json.backup.<ms>` and
  `.claude.json.corrupted.<ms>`): `.claude/backups` and the legacy
  `.claude.json.backup` at any depth, the `backups` folder of the server's
  `CLAUDE_CONFIG_DIR` and `~/.claude` inside the workspace, and the
  timestamped `.claude.json` copies that exist next to the server's global
  config (home dir or `CLAUDE_CONFIG_DIR`), listed by exact name. Exclude
  entries stay literal because the restore baseline (`shouldExcludePath`) does
  not understand globs: a glob would leave a file out of the upload while
  keeping it in the baseline, and the restore would then delete it locally.
  So a codex_local, opencode_local, pi_local, gemini_local,
  grok_local, kimi_local or cursor run on an SSH or sandbox target no longer
  uploads the owner's Claude sign-in when its workspace holds the service
  user's home or the server's `CLAUDE_CONFIG_DIR`. The sync-back never reads
  such a file as deleted (a persisted restore baseline gets the same excludes
  merged in, so a baseline captured before this change cannot delete the host
  file) and never copies one created remotely back to the host. Referenced
  projects staged next to the workspace get the same excludes. claude_local
  keeps its own excludes for the agent's explicit `CLAUDE_CONFIG_DIR` on top:
  its sign-in files and its `backups` folder, on both engines.
- **Workspace file browser.** `/issues/:issueId/file-resources/*` denies Claude
  sign-in files as `denied_secret`: `.credentials.json` and `credentials.json`
  inside any `.claude` folder, and `.claude.json` at any depth
  (`workspace-file-resources.ts`). The names are shared with the staging
  excludes. It also denies sign-in files by where they really live, so a
  workspace root that is itself a Claude config dir (`~/.claude`) or holds the
  server's `CLAUDE_CONFIG_DIR` under any name is covered: a credential file
  directly in any `.claude` dir or anywhere inside the resolved or real
  `CLAUDE_CONFIG_DIR` or `~/.claude`, any `.claude.json`, and the real target
  of a sign-in file that is a link to a file with another name. This covers
  content, resolve, download (and so native-runner file reads), availability,
  and list/search/recent/changed. It also denies Claude Code's copies of
  `.claude.json` (any file name starting with `.claude.json.backup` or
  `.claude.json.corrupted`, any case, at any depth) and the `backups` folder,
  with everything in it, of any `.claude` dir and of the server's
  `CLAUDE_CONFIG_DIR` / `~/.claude` (checked in claude 2.1.283, which writes
  `<config dir>/backups/.claude.json.backup.<ms>` and
  `.claude.json.corrupted.<ms>`). Helpers: `createClaudeSignInPathMatcher`,
  `isClaudeSignInPath` and `isClaudeSignInPathSegments` in
  `claude-config-credential-excludes.ts`.
- **Plugin local folders.** A Claude config dir (the server's
  `CLAUDE_CONFIG_DIR` or `~/.claude`, a folder inside one, a folder that holds
  one such as the home dir, or any folder named `.claude`) is never a plugin
  local folder. `localFolders.configure` and the board's
  `PUT /plugins/:pluginId/companies/:companyId/local-folders/:folderKey`
  refuse it with 403 before creating or storing anything. A folder like that
  stored earlier reports a `not_readable` problem, so its status is unhealthy
  and list/readText/writeTextAtomic/deleteFile refuse it. In any local
  folder, readText refuses a Claude sign-in file (the same names as the file
  browser, including the `.claude.json` copies and `backups` folders), list
  leaves it out, and writeTextAtomic and deleteFile refuse one
  (`overlapsClaudeConfigDir` in `claude-config-credential-excludes.ts`,
  `assertPluginLocalFolderOutsideClaudeConfig` in
  `plugin-local-folders.ts`).
- **Agent instructions bundles** (`server/src/services/agent-instructions.ts`).
  A new external bundle root, or a new legacy `instructionsFilePath` whose
  folder is, lies inside, or contains a Claude config dir
  (`overlapsClaudeConfigDir`), is refused with 422 before anything is
  created. A root that was stored earlier and is unchanged stays usable. The
  bundle API never lists, reads (403), exports, writes or deletes (403) a
  Claude sign-in file, including through links (real-path checks). This also
  applies to company exports and the native-runtime instruction asset (both go
  through `exportFiles`). The legacy fallback never reads an
  `instructionsFilePath` that is a sign-in file. `materializeManagedBundle`
  refuses an imported file named as a sign-in file (403) before replacing the
  managed root.
- **Follow-up migration.** `0286_remove_claude_subscription_tokens_from_env.sql`
  removes, from issue assignee overrides and `hire_agent` approval payloads
  (both missed by 0285) and again from agent, environment, project, routine and
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
- Paperclip decides the subscription lane from the agent and server env, and
  from an inline `--settings` env, which can only take a credential away.
  A claude_local agent that bills through an `apiKeyHelper` or an API key or
  Bedrock/Vertex/Foundry flag in the `claude` CLI's own `settings.json` counts
  as subscription-lane, so the owner-only and trigger-source gates refuse it
  where they apply; the refusal message and docs tell users to move the setting
  into the agent env. An Anthropic API key or `apiKeyHelper` kept only in an
  inline `--settings` JSON in the extra args counts as subscription-lane too
  (same fix). An explicit "API-billed" agent flag, or a key-name-only scan of
  `settings.json`, would need a product decision. A `--settings <file>` path
  is not read for classification either: a settings file named in the extra
  args that blanks `ANTHROPIC_API_KEY` and sets `ANTHROPIC_BASE_URL` can still
  move an API-key agent onto the owner's sign-in without the gates. Closing
  that means refusing `--settings` files or reading them at launch, the same
  product decision as for the endpoint check below. The same limit applies to
  an agent's environment Test probe that the classifier counts as API-key
  (agent or server env plus inline `--settings`): it keeps the caller's args,
  `cwd` and project settings, so a `--settings <file>` in the extra args, or a
  project `.claude/settings.json` in the chosen `cwd`, that blanks the key and
  sets `ANTHROPIC_BASE_URL` can still move that probe onto the sign-in without
  the fixed probe flags.
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
  The owner's own linked-chat message runs on a conversation a chat guest
  started, and that run reads the whole conversation, including the guest's
  messages.
- GitHub PR-merge confirmations are accepted. When an agent's own
  `request_confirmation` is accepted by a merge on GitHub, the
  `system:pr-merged` and `merged_pull_request_sweep` paths wake that agent with
  a system wake. The gate accepts this as an event in the owner's repository,
  because the agent asked for the confirmation and merging needs write access
  to the repository.
- The plugin-edit check reads `activity_log`. Any activity row of a Paperclip
  user on the task lifts it, apart from the passive rows in
  `PASSIVE_USER_ISSUE_ACTIONS`, including rows the issue service writes for a
  user that a plugin names as its acting user (for example
  `issue.thread_interaction_expired` after a plugin comment with
  `actorUserId`). The passive list is a denylist kept by hand: a passive user
  action upstream adds later lifts the refusal until it is added. A plugin edit
  made through a path that logs no activity is not seen.
- The task bridge check cannot tell which key an agent used, so it refuses
  every agent-requested wake of an agent that holds a live task bridge key,
  including delegation from that agent's own runs, and every routine run such
  an agent started, created, edited or scheduled while it held the key (or
  within five minutes before its creation). The wake rule does not bound a key
  by its creation, so a wake the agent requested just before it got the key is
  still refused. Revocation has no skew allowance: `revokedAt` comes from the
  server clock and activity rows and wakes from the database clock, so an
  action within that skew before revocation can count as the owner's.
  Delegation by an agent that has no such key is allowed as before, even when
  a bridge started the chain.
  In a company with a live task bridge key, a routine api run whose
  `routine.run_triggered` row is not written yet when the run starts (a race
  with the route), and every pipeline stage entry run, is refused on the
  subscription lane; the owner's board Run now is not affected, since a manual
  run records the owner on the task. The routine rule reads the creator of the
  routine, its revisions and its trigger; an agent deleted since then leaves no
  creator (`on delete set null`), so its routines count as the owner's. A task
  bridge key can also move a pipeline case or reach other upstream routes that
  do not apply its scope; only the routine path is covered.
- Internet-facing gateway agents (`hermes_gateway`, `openclaw_gateway`,
  `http`) that use a standard claimed key instead of a `task_bridge` key count
  as owner delegation, so an outside chat message handled by such a gateway
  can wake a subscription-lane agent. Use a `task_bridge` key for an
  internet-facing gateway. Treating gateway adapter types as external would
  need a product decision.
- Every local agent runs as the Paperclip service user, and that user owns the
  `claude` sign-in (`~/.claude/.credentials.json` or the OS keychain). An
  agent with shell access (any claude_local, codex_local or other local coding
  agent) or a `process` adapter command can therefore read the sign-in
  directly, whatever the gates above decide about who may start a
  subscription-lane run. Paperclip never reads the sign-in itself; keeping
  agents away from it would need running them as a separate OS user from the
  one that signed in to Claude.
- Only a direct start of `claude` by a `process` agent is recognized. An
  agent of any other adapter (codex_local, kimi_local, gemini_local,
  grok_local, cursor, opencode_local, pi_local, hermes_local through
  `command`/`hermesCommand`, or a plugin adapter) whose command starts
  `claude` is refused in the heartbeat with `configuration_incomplete`
  (reason `claude_command_on_other_adapter`) on every target, recognised the
  same way as for a process agent, with `extraArgs`/`args` as the args. A
  shell (`sh -c "claude …"`), a script, a copy or symlink of the binary under
  another name, or any program that starts `claude` itself gets neither the
  gates nor the endpoint check, and another adapter's command of that kind is
  not refused either. The check also errs toward gating: `npm run
  claude` or `node tool.js claude` counts as a Claude run. `env -S` strings
  are split like GNU `env` (space, tab, newline, VT, FF, CR; quotes; escapes;
  `#` comments), but `${VAR}` is not expanded, so a `${VAR}` that expands to
  an `env` flag or to the command name is not seen, which is the same class
  of gap as `sh -c`. An unreadable `env` chain that has a `${VAR}` anywhere in
  an `env -S` string, or assigns a name that is empty or not a plain variable
  name, is refused as an endpoint violation on the subscription lane (a
  process claude agent never needs either). Any quoted, escaped, expanded or
  commented `-S` string, or an unknown `env` flag, over-gates: an API key
  assigned inside it or after it does not count, so such an agent is treated
  as subscription-lane, and a custom endpoint is refused. Input that GNU `env`
  refuses to run (an unknown escape, an unterminated quote) is read leniently.
  A flag read after an assignment or after `--` (where real `env` would try to
  run it as the command) is still treated as a flag, which also leans toward
  gating.
- Encrypted secrets under other keys can still hold a subscription token
  stored before this branch; the runtime drops the value at launch, but it stays
  stored until the owner deletes it.
- An adapter config saved before the all-leaves check can still hold a token
  in a non-env leaf. The runtime drops it on every run, but it stays stored
  until the owner edits it; until then any update that saves the whole config
  (for example changing the instructions path) is refused with the leaf's
  path. The embedded match needs a digit after the prefix, so an encoded or
  split token is not seen.
- A subscription token in the config file's `llm.apiKey` stays on disk until a
  later config write changes the file. The warning comes from the shared config
  schema (`console.warn`, once per process), not from the server or CLI config
  loaders.
- The `env` block of a `claude` settings file overrides the process env
  (verified: a workspace `.claude/settings.json` with `ANTHROPIC_BASE_URL`
  redirected a `--print` run even with a different value in the process env).
  The endpoint check reads only the agent env and inline `--settings` JSON, not
  the service user's `~/.claude/settings.json`, a project's
  `.claude/settings.json` or `.claude/settings.local.json` in the run's
  workspace, or a `--settings <file>` path. So a settings file that the agent
  writes, or that a checked-out repository contains, can still send the
  subscription elsewhere. Closing this would need `--setting-sources user`
  plus a refusal of `--settings` files, or reading those files at launch;
  either is a product decision. The agent also runs shell commands as the
  service user and can read the sign-in file itself; the endpoint check closes
  only the config-only channel that needs no cooperation from the agent.
- Board chat checks the server's own process env, unlike claude_local. An
  owner with, for example, `SSL_CERT_FILE` or `NODE_EXTRA_CA_CERTS` in the
  server env and no API key loses board chat until they remove it or add
  `ANTHROPIC_API_KEY`. Board chat also no longer loads the owner's user-level
  MCP servers (`--strict-mcp-config`), and it still loads the service user's
  `~/.claude/settings.json` (`--setting-sources user`), whose `env` block the
  endpoint check does not read.
- Machines that ran the round-4 board chat (one fresh folder per request)
  already have one `~/.claude/projects/<…-board-chat-chat-XXXXXX>` dir per
  board chat message. Paperclip does not touch the operator's Claude config
  dir, so the operator can delete those by hand. Round-4
  `<instanceRoot>/board-chat/chat-*` folders left behind by a crash are not
  removed automatically either. The per-company lock and the global limit of
  three board chats are per router instance, and the global counter is checked
  before the database calls and raised later, so a burst can briefly run more
  than three.
- An agent key with `agents:create` can still make the server spend one fixed
  "Respond with hello." turn on the owner's subscription through the
  environment Test route. The trigger-source gate does not apply there,
  because the route sees the calling agent, not the wake that started its run.
  The probe returns only fixed pass/fail checks, never model output. A
  `CLAUDE.md` in the caller-chosen `cwd` is still loaded.
- A Vertex- or Foundry-only agent's CLI Test checks the `claude` CLI sign-in,
  not the provider. Forwarding the Vertex/Foundry flags and their provider
  keys to the probe child would need caller-controlled
  `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_FOUNDRY_BASE_URL`,
  `GOOGLE_APPLICATION_CREDENTIALS` or `ANTHROPIC_FOUNDRY_*` values in the
  probe allowlist, which could hand the server's Google or Azure credentials
  to an endpoint the caller picks; that needs a product decision.
- The workspace file browser and plugin local folders deny only what
  Paperclip itself serves over its API and to plugins. A local agent running
  as the same OS user can still read the sign-in files directly (see the
  service-user item above). Outside the server's `CLAUDE_CONFIG_DIR` and
  `~/.claude`, the location rule denies a credential file only when it sits
  directly in a `.claude` dir, so a workspace under an unrelated `.claude`
  ancestor (such as Claude Code's `<repo>/.claude/worktrees/*`) keeps its
  deeper `credentials.json` files; inside the root, a credential file at any
  depth under a `.claude` segment is still denied. The absolute sign-in
  matcher knows only the server's `CLAUDE_CONFIG_DIR` and `~/.claude`: a
  sign-in kept in an agent-level `CLAUDE_CONFIG_DIR` that is not named
  `.claude` and lies inside a workspace root is not denied by the file API.
- An instructions root stored before the bundle checks inside a Claude config
  dir (or the home dir) keeps working, with its sign-in files hidden, but its
  other files (for example `~/.claude/projects` transcripts) are still
  listed. Adapters read `instructionsFilePath` themselves, outside
  `agent-instructions.ts`: a legacy `instructionsFilePath` stored before this
  change that names a sign-in file is still read by the adapter at run time;
  only new values are refused at save time.
- Left out of the endpoint check on purpose:
  - Proxies (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`,
    `CLAUDE_CODE_PROXY_*`, `CLAUDE_CODE_HTTP(S)_PROXY`): while certificate
    checks are on, a proxy only relays the encrypted connection, and the TLS
    overrides that would let it read requests are refused. An operator who
    turns off certificate checks in the server's own env lets an agent-env
    proxy read the sign-in.
  - Provider base URLs (`ANTHROPIC_BEDROCK_BASE_URL`,
    `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_FOUNDRY_BASE_URL`,
    `ANTHROPIC_AWS_BASE_URL`, `ANTHROPIC_GOOGLE_CLOUD_BASE_URL`,
    `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`): used only with their provider flag,
    and those clients never attach the Claude sign-in (checked in the 2.1.280
    client code).
  - `CLAUDE_CODE_CUSTOM_OAUTH_URL`: the binary accepts only Anthropic-owned
    hosts. `USE_LOCAL_OAUTH`, `USE_STAGING_OAUTH`, `CLAUDE_LOCAL_OAUTH_*`:
    production builds ignore them.
  - `SESSION_INGRESS_URL`, `AGENT_PROXY_URL`, `CLAUDE_BRIDGE_*`,
    `CLAUDE_REMOTE_TOOLS_BRIDGE_URL`, `CLAUDE_CODE_ARTIFACT*_BASE_URL`,
    `CLAUDE_CODE_MEMORY_API_BASE_URL`: used by Anthropic-hosted remote
    sessions and Remote Control with their own session tokens, which Paperclip
    strips; not shown to carry the sign-in in a `--print` run.
  - `SSLKEYLOGFILE`: the bundled Bun runtime writes no key log (verified).
    `LD_LIBRARY_PATH`: common legitimate use, and it needs a planted library.
  - `NODE_USE_SYSTEM_CA` and `CLAUDE_CODE_CERT_STORE`: the system certificate
    store is controlled by root once `SSL_CERT_FILE` and `SSL_CERT_DIR` are
    refused. `CLAUDE_CODE_CLIENT_CERT`/`_KEY` and `ANTHROPIC_CUSTOM_HEADERS`
    add a client certificate or headers but do not expose the bearer token.
- The bundled claude 2.1.280 knows provider flags that Paperclip's classifier
  does not count (`CLAUDE_CODE_USE_ANTHROPIC_AWS`,
  `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`, `CLAUDE_CODE_USE_MANTLE`) and
  credentials it does not count (`ANTHROPIC_AWS_API_KEY`,
  `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, and
  `AWS_BEARER_TOKEN_BEDROCK` without `CLAUDE_CODE_USE_BEDROCK`). A run that
  relies only on these counts as subscription-lane, so the owner-only,
  trigger-source and endpoint rules apply to it. That is stricter, not a leak.
- Remote staging filters only the working-tree overlay and plain uploads. A
  Claude sign-in file committed to the workspace's git history still travels
  with the git-history clone (sandbox) or bundle (SSH). A durable seed archive
  persisted before this change is replayed as-is. The legacy `.config.json`
  is not excluded; a timestamped `.claude.json.backup.<ms>` outside a
  `.claude/backups` folder is excluded only next to the server's own global
  config (for claude_local, also in the `backups` folder of the agent's own
  `CLAUDE_CONFIG_DIR`); a copy whose name contains a tar glob character is
  not excluded.
  Runtime assets (adapter-chosen directories) are not filtered generically. A
  native provider `syncOut` receives the exclude list as-is, and how it
  matches the entries is up to the provider.
