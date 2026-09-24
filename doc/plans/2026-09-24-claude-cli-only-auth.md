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

## What stays

- The claude_local CLI engine running on the local host, with no injected
  auth, so the binary uses the service user's own login.
- Anthropic API-key auth (`ANTHROPIC_API_KEY` as a Paperclip secret),
  everywhere, including ACP and remote targets.
- Auth status checks that only run the binary (`claude auth status`).
- All other providers (OpenAI/Codex, Gemini, OpenRouter, …) unchanged.

## Status

- Phase 1: done. With `engine` unset, claude_local uses ACP for a local run with an API credential (so API-key agents need no global `claude` binary) and `cli` otherwise; ACP and remote targets need an API credential (API key, non-subscription `ANTHROPIC_AUTH_TOKEN`, Bedrock, or adapter-env Vertex/Foundry; `ANTHROPIC_BEDROCK_BASE_URL` alone does not count); `CLAUDE_CODE_OAUTH_TOKEN` is stripped from every child process (local, SSH, sandbox, ACP launch env, board chat, runtime services) and runner allowlist.
- Phase 2: done. Anthropic `subscription` method, host sign-in import, isolated Claude login homes, and `claude setup-token` capture are removed; `CLAUDE_CODE_OAUTH_TOKEN` is rejected as an env key in every persisted env map (server-side in secrets `normalizeEnvConfig`, plus request schemas for agent, project, routine, environment, issue overrides), in secret binding proposals, and is skipped with an import warning in company imports. Agent-created claude_local hires are never defaulted onto a managed Anthropic binding; a responsible user without an Anthropic default runs the agent on the server CLI.
- Phase 3: done. `ClaudeCliSignInStatus` replaces "Connect your Claude subscription" and shows `claude auth status` from the auth-signal route (with a "CLI not installed" state from reason `cli_missing`). It shows only when the target is this server; sandbox/SSH targets get API-key guidance, and a Paperclip Runner's Claude lane is API-key only. Onboarding blocks the hire when the CLI probe reports `claude_hello_probe_auth_required`.
- Phase 4: done. Claude quota comes only from `claude auth status` and the CLI `/usage` panel; the OAuth usage call, credential file and Keychain reads, and `quota-probe.ts` are removed.
- Phase 5: in progress. The migration that deletes stored Claude subscription connections, grants, env bindings, and secrets is being written.
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

## Phases

### 1. Runtime: only the local CLI lane uses a subscription

- `packages/adapters/claude-local/src/server/acp.ts` `normalizeEngine`: default
  engine becomes `cli`.
- ACP engine for Claude runs only when an `ANTHROPIC_API_KEY` is configured;
  otherwise fail with a clear message that points to `engine=cli`.
- Remove `CLAUDE_CODE_OAUTH_TOKEN` from provider env allowlists:
  `packages/adapter-utils/src/acpx-engine/execute.ts` (~597),
  `packages/paperclip-runner/src/drivers/acpx/environment.ts` (~31),
  `packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts`
  (~3282), `packages/paperclip-runner/runner/crates/runner-core/src/acpx_sidecar_transport.rs` (~99).
- claude_local on a remote target (SSH, sandbox, runner) requires
  `ANTHROPIC_API_KEY`; fail early with a clear message otherwise.

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

### 5. Database

- New migration (`pnpm db:generate`, custom SQL) that deletes stored Anthropic
  subscription AI connections, their grants, env bindings and secret rows.
  Destructive; approved by the user.

### 6. Docs, tests, full check

- Update `docs/adapters/claude-local.md`, `docs/adapters/overview.md`, and
  `doc/SPEC-implementation.md` where it describes Claude subscription connect.
- Add a server setup section: install `claude` for the service user, sign in
  with `claude` then `/login` as that user, run Paperclip as that user.
- Update or delete tests for removed paths.
- `pnpm -r typecheck && pnpm test:run && pnpm build && pnpm check:token-gates`.

## Remaining grey area

Anthropic's own headless mode is what this uses, but running many agents
around the clock on one subscription may still be judged outside "ordinary
use". Plan usage limits apply as normal.
