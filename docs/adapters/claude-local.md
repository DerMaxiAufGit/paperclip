---
title: Claude Code
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI (`claude`) on the
Paperclip server. It supports session persistence, skills injection, and
structured output parsing.

## How Claude authenticates

Claude can authenticate in two ways:

- **Claude subscription (Free, Pro, Max).** Only the CLI engine on the
  Paperclip server uses a subscription, and only for the server owner's own use
  (see [Who may use the subscription](#who-may-use-the-subscription)).
  Paperclip runs the official `claude` binary in headless mode
  (`claude --print --output-format stream-json --verbose`) as the operating
  system user that Paperclip runs as. The binary uses that user's own Claude
  sign-in. See [Running Claude on a server](#running-claude-on-a-server).
- **Anthropic API credential.** This is one of:
  - `ANTHROPIC_API_KEY`;
  - a gateway `ANTHROPIC_AUTH_TOKEN` (with `ANTHROPIC_BASE_URL`) that is not a
    `sk-ant-oat` subscription token;
  - Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`);
  - Google Vertex AI (`CLAUDE_CODE_USE_VERTEX=1`);
  - Microsoft Foundry (`CLAUDE_CODE_USE_FOUNDRY=1`).

  An API credential works on every engine and every execution target. You can
  store an API key as a Paperclip secret, or save it as an Anthropic AI
  connection in **Apps**.

Paperclip never reads, stores, forwards, or injects a Claude sign-in:

- Paperclip has no "connect your Claude subscription" flow. It does not import
  the server's sign-in, create separate login homes, or capture
  `claude setup-token` output.
- Paperclip treats these as Claude subscription tokens: the environment keys
  `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`,
  `ANTHROPIC_OAUTH_TOKEN`, and `ANTHROPIC_TOKEN`, the keys that point the
  `claude` binary at a sign-in (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`,
  `CCR_OAUTH_TOKEN_FILE`, `CLAUDE_CODE_HOST_CREDS_FILE`, and
  `CLAUDE_CODE_SESSION_ACCESS_TOKEN`), all in any letter case, and any value
  that starts with `sk-ant-oat` (OAuth access token), `sk-ant-ort` (OAuth
  refresh token), or `sk-ant-sid` (Claude.ai session key), under any key.
  Every env map Paperclip stores (agent, project, routine, environment, issue
  override) rejects them. Company and user secrets reject such a value.
  A company import skips a token key and shows a warning in the import preview
  and result. Paperclip also removes them from every process it starts, even
  when the Paperclip server's own environment sets them, workspace runtime
  services and workspace commands included. Such a value in
  `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` never counts as an API
  credential.
- The managed Claude config directory that Paperclip creates for remote
  targets holds only sanitized settings. It never holds a sign-in file, and it
  drops the `env` block and credential helpers (`apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`) of the
  server's `settings.json`.
- Paperclip does not show Claude plan usage. See
  [Claude usage on the Costs page](#claude-usage-on-the-costs-page).
- Two database migrations delete the Claude subscription credentials that
  earlier versions stored. Migration 0282 removes subscription connections with
  their grants, the `claude setup-token` secret, and `CLAUDE_CODE_OAUTH_TOKEN`
  env entries and bindings. Migration 0283 also removes the other token keys
  and plain `sk-ant-oat`, `sk-ant-ort`, and `sk-ant-sid` values from stored env
  maps, issue overrides, and hire approvals. The migrations delete only rows in the Paperclip database. A
  value stored in an external secret provider (AWS Secrets Manager, GCP Secret
  Manager, or Vault) is not deleted: delete it in that provider. After the
  upgrade, a Claude subscription runs only through the `claude` CLI signed in
  on the server.

The reason is Anthropic's
[Claude Code legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance).
They say that third-party developers may not offer Claude.ai login in their
own products, may not route requests through Free, Pro, or Max plan
credentials on behalf of their users, and may not collect, store, or
intermediate Claude.ai credentials or session tokens.

A Claude subscription stays subject to Anthropic's usage policies and plan
limits. Paperclip does not limit how many subscription runs happen at once.
Running many agents all day on one subscription can be judged outside ordinary
individual use. Use an API key for heavy or shared workloads.

## Who may use the subscription

A run is on the subscription lane when it is a `claude_local` run on the
Paperclip server with no API credential and without `engine: "acp"`. Two rules
apply to such a run. A run with an API credential is not affected by either
rule.

**Owner only.** The subscription lane is for the server owner's own use. It is
allowed when:

- the deployment mode is `local_trusted`; or
- the deployment mode is `authenticated` and the instance has at most one
  active human user. A human user is a user account with an instance role or an
  active company membership. Agents do not count. An `authenticated` instance
  that nobody has claimed yet has no human user, so it is allowed too.

On an instance with more users, a subscription-lane run fails before it starts
with this message: "Claude subscription runs are limited to the server owner's
own use. This instance has other users, so give this agent an Anthropic API
key. Paperclip sees an API key, Bedrock, Vertex or Foundry only in the agent or
server env, not in the claude CLI's settings.json or an apiKeyHelper, so set it
there." The run fails with `configuration_incomplete` (reason
`subscription_not_allowed`) and links to the agent's runtime settings. The
Environment Test reports the same message as `claude_subscription_not_allowed`
and does not run the `claude` probe. The sign-in status panel shows the same
message and no sign-in steps.

Paperclip decides whether a run is on the subscription lane only from the
agent env and the server env. It does not read the `claude` CLI's own
`settings.json`. An agent that bills through an `apiKeyHelper`, or through an
API key or `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY` in the `env` block of
the service user's `~/.claude/settings.json`, therefore counts as a
subscription-lane run, and the owner-only and trigger-source rules refuse it
when they apply. Move that setting into the agent env (as a secret for a key)
so Paperclip sees the API credential.

**Trigger source.** Even for the owner, a subscription-lane run fails before it
starts when its wake came from outside Paperclip:

- a chat message from a person who is not linked to a Paperclip user (a chat
  guest);
- an inbound email to the agent's email inbox;
- a plugin: `agents.invoke`, a plugin agent session, a plugin issue wakeup, or
  a comment, interaction response, or approval decision that a plugin relays
  for a user. Plugin webhooks reach agents this way;
- a task that a routine's public webhook trigger created.

A system or agent wake on a task that came from outside Paperclip is refused
too, for example the recovery dispatch of a stranded task: a task a plugin
created (origin `plugin:…`, which includes a plugin-managed routine's task), an
email conversation, a chat conversation that a chat guest started, and a task a
routine's public webhook created. A wake that a Paperclip user requests on such
a task, such as the owner's comment, is allowed.

The run fails with `configuration_incomplete` (reason
`claude_subscription_external_trigger`, with `trigger` set to `chat_guest`,
`email`, `plugin`, or `routine_webhook`) and this message: "This run was
started from outside Paperclip (chat guest, email, webhook or plugin). Claude
subscription runs are for the server owner only; give this agent an Anthropic
API key."

These wakes stay allowed: assignments and comments by a Paperclip user, timers
and heartbeats, scheduled routines, delegation between agents, chat messages
from linked chat users, and follow-up wakes on a chat conversation that a
linked user started. A new chat endpoint for an agent on the
subscription lane starts with unlinked people turned off.

Board chat spawns the `claude` CLI directly. It is available only in
`local_trusted` mode.

## Execution engines

| Engine | Selected by | Where it runs | Authentication |
|--------|-------------|---------------|----------------|
| CLI | `engine: "cli"`, or the default when the run has no API credential or runs on a remote target | The Paperclip server, or a remote target | On the server: the `claude` sign-in of the Paperclip user, or an API key. On a remote target: an API credential only. |
| ACP | `engine: "acp"`, or the default for a run on the Paperclip server that has an API credential | The Paperclip server, or a remote target | An API credential only |

- An API credential is `ANTHROPIC_API_KEY`, a gateway `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_USE_BEDROCK=1`, or `CLAUDE_CODE_USE_VERTEX=1` /
  `CLAUDE_CODE_USE_FOUNDRY=1` set in the agent's or environment's variables. A
  `sk-ant-oat` subscription token never counts, under either key.
  `ANTHROPIC_BEDROCK_BASE_URL` alone does not count.
- With `engine` unset (or the old `"auto"` value), a run on the Paperclip
  server that has an API credential uses the ACP engine, so it needs no global
  `claude` binary. Every other run uses the CLI engine: a run on the server
  without an API credential, and every run on a remote target. A Claude
  subscription is therefore only ever used by the `claude` binary signed in on
  the server.
- The ACP engine and every remote target (SSH, sandbox, runner) check for an
  API credential before launch. A run without one fails before it starts. The
  error names the fix. On the ACP engine, the error also points to
  `engine: "cli"`. Paperclip never changes engines automatically.
- The API credential can come from the agent's `env`, from the execution
  environment's variables, or from an Anthropic AI connection. For a local ACP
  run without a managed AI connection, the Paperclip server's own
  `ANTHROPIC_API_KEY` also counts. Remote targets never inherit the server's
  environment.
- The ACP engine also needs Node 24.11.0 or newer and the
  `@agentclientprotocol/claude-agent-acp` package installed with this adapter.
- `filesystemScope` and `networkScope` confinement need the CLI engine and
  Bubblewrap on the host. They reject `engine: "acp"`, and with `engine` unset
  they keep the run on the CLI engine.

## Running Claude on a server

Use these steps to run `claude_local` agents on a Claude subscription. The
`claude` binary on the Paperclip server uses the sign-in of the operating
system user that runs the Paperclip server process. Install Claude Code and
sign in as that same user.

### 1. Install Claude Code for the service user

Open a login shell as the service user. The example user is `paperclip`:

```sh
sudo -iu paperclip
```

Install Claude Code with Anthropic's native installer, or with npm:

```sh
curl -fsSL https://claude.ai/install.sh | bash
# or
npm install -g @anthropic-ai/claude-code
```

The `claude` command must be on the `PATH` of the Paperclip server process,
not only on the `PATH` of your interactive shell. A service manager does not
read shell startup files. The native installer puts `claude` in
`~/.local/bin`.

### 2. Sign in as the service user

In the same shell, start Claude Code and type `/login`:

```sh
claude
# then type /login and follow the prompts
```

You can also run `claude auth login`. On a server without a browser, the CLI prints
a sign-in URL. Open the URL on any computer, finish the sign-in, then paste the
code back into the terminal if the CLI asks for it. The sign-in stays in the
service user's Claude configuration. Paperclip does not copy or read it.

If the service user sets `CLAUDE_CONFIG_DIR`, sign in with the same
`CLAUDE_CONFIG_DIR` value, because the CLI stores its sign-in in that
directory.

### 3. Run Paperclip as the same user

`paperclipai service install` creates a systemd user unit on Linux, or a
LaunchAgent on macOS. That service runs as the user who installed it. Install
the service as the service user.

For a custom system-wide unit, set `User=` to the user who signed in:

```ini
# /etc/systemd/system/paperclip.service
[Unit]
Description=Paperclip
After=network-online.target
Wants=network-online.target

[Service]
User=paperclip
Group=paperclip
WorkingDirectory=/home/paperclip
Environment=HOME=/home/paperclip
# Include the directory that contains `claude`.
Environment=PATH=/home/paperclip/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/paperclip/.local/bin/paperclipai run
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`HOME` must point to the service user's home directory, because the CLI
finds its sign-in under `$HOME/.claude`. After you edit the unit, run
`sudo systemctl daemon-reload` and `sudo systemctl restart paperclip`.

In the Docker image, the server runs as the `node` user with
`HOME=/paperclip`, which is the data volume. Sign in inside the container
with `docker exec -it -u node paperclip claude`, then type `/login`. The
sign-in is saved on the data volume, so it persists across restarts.

### 4. Check the sign-in

As the service user, run:

```sh
claude auth status
```

The command prints JSON. `"loggedIn": true` with `"authMethod": "claude.ai"`
means the subscription sign-in works. Paperclip runs the same command:

- The agent setup screens show a status panel titled "Uses the claude CLI
  signed in on this server". The panel shows the result of
  `claude auth status` on the server and the sign-in steps. The panel reads
  `GET /api/companies/:companyId/adapters/claude_local/auth-signal`. For the
  Paperclip server, that route runs only `claude auth status` and never reads
  the sign-in itself. On an instance that fails the
  [owner-only rule](#who-may-use-the-subscription), the route does not run
  `claude auth status`: it reports `absent` with reason
  `subscription_not_allowed`, and the panel shows the owner-only message
  without sign-in steps. For a remote environment, the route reports only
  whether the environment has an `ANTHROPIC_API_KEY`.
- When a run fails with `claude_auth_required` on the CLI engine on this
  server, the run shows the same status panel and the sign-in steps. The steps
  stay visible even when `claude auth status` still reports a sign-in, because
  an expired or revoked sign-in fails the run the same way. Paperclip cannot
  sign in for you: it has no button, API route, or CLI command that starts a
  Claude sign-in. Open a shell on the server as the user Paperclip runs as, run
  `claude`, then type `/login` (or run `claude auth login`). Then retry the run.
- If the run used the ACP engine, an Anthropic API credential (API key, gateway
  `ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex or Foundry), or a remote environment,
  it never used the server sign-in. The run page then says the API credential
  was rejected and does not show the sign-in steps: update the credential.

### API keys override the sign-in

If `ANTHROPIC_API_KEY` is set in the Paperclip server's environment, in the
agent's `env`, or in the execution environment, the run uses the API key, not
the subscription sign-in. With `engine` unset, such a run also uses the ACP
engine. With `engine: "cli"`, the `claude` CLI uses the key. The Environment
Test shows this as `claude_anthropic_api_key_overrides_subscription`. To use
the subscription, remove `ANTHROPIC_API_KEY` from the service environment (for
example, from the unit's `Environment=` lines or `EnvironmentFile=`) and from
the agent.

Do not use `claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_TOKEN`,
or a `sk-ant-oat`, `sk-ant-ort`, or `sk-ant-sid` value. Paperclip
rejects them in configurations and secrets and removes them from every process
it starts.

## Other adapters on the same server

Only the official `claude` binary, through `claude_local`, may use a Claude
subscription. Other harnesses on the same server can find a stored Claude
sign-in: their own Claude login, or the service user's `~/.claude`
credentials. So an Anthropic model on another harness needs an API key:

| Adapter | Counts as an Anthropic run | Needs | Stored logins hidden for the run |
|---------|----------------------------|-------|----------------------------------|
| Hermes (`hermes_local`) | The resolved provider is `anthropic` (set in the agent, taken from `~/.hermes/config.yaml`, or inferred from a `claude...` model name), or it is `auto` and `~/.hermes/config.yaml` selects `anthropic` | `ANTHROPIC_API_KEY` | `CLAUDE_CONFIG_DIR` points to an empty directory |
| OpenCode (`opencode_local`) | Model `anthropic/...` | `ANTHROPIC_API_KEY` | `OPENCODE_AUTH_CONTENT={}` |
| Pi (`pi_local`) | Model `anthropic/...`, or a bare `claude...` model | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` | A managed `PI_CODING_AGENT_DIR` without `auth.json` |

- A local run counts the key from the Paperclip server's environment or the
  agent's `env`. OpenCode and Pi runs on a remote target count only the
  agent's `env`. A `sk-ant-oat` value never counts.
- Without a key, the run fails before the harness starts with
  `adapter_engine_unavailable` and this message: "Only the official claude
  binary may use a Claude subscription. Give this agent an Anthropic API key,
  or use the Claude (claude_local) adapter." The run is not retried. The
  adapter's Environment Test reports the same error.
- Anthropic models reached through another provider, such as OpenRouter,
  Bedrock, Vertex, or a gateway, are not affected.
- Hermes prefers an `ANTHROPIC_TOKEN` in `~/.hermes/.env` and an Anthropic
  login from `hermes auth` over the key. Paperclip does not read
  `~/.hermes/.env`, so remove those yourself.
- The provider and model flags in the agent's `extraArgs` (or `args`) count
  too, because the harness gets them after the ones Paperclip sets: Hermes
  `--provider` and `-m`/`--model` (also `--provider=…` and abbreviated long
  options), Pi `--provider` and `--model`, and OpenCode `-m`/`--model`.
- Breaking change for existing setups: a key that the harness keeps in its own
  store does not count. That covers a key in `~/.hermes/.env` or in
  `~/.hermes/config.yaml` (`hermes setup` puts it there), an OpenCode key from
  `opencode auth login` or in `opencode.json`, and a key in Pi's `auth.json`.
  Paperclip does not read those files, because the same files can hold a
  Claude sign-in. Move the key into the agent's `env` as a secret.
- On an Anthropic run, `OPENCODE_AUTH_CONTENT={}` hides every OpenCode stored
  login, not only Anthropic's, because Paperclip cannot drop one entry without
  reading the file. A provider that the same run reaches through a stored
  login, for example an OpenCode `small_model` or a subagent on another
  provider, then needs its key in the agent's `env` too. A remote Pi run on an
  Anthropic model gets an empty agent directory, so the remote Pi's own
  settings, models, and extensions are not used for that run.

## Quota waits

Claude ACP runs that end with a typed provider-quota error retain the quota
classification and any parsed reset time. Recovery waits until that time, or
uses its existing one-hour quota backoff when no reset time is available.
The adapter inspects the terminal provider message in memory; the run result
and run log retain only the generic failure message, recovery labels, and reset
timestamp. Context, turn, rate, and configured budget limits are not treated as
subscription quota exhaustion merely because ACP labels them `limit`.

## Claude usage on the Costs page

The Costs page shows no Claude plan usage or quota windows. Reading them would
mean reading the Claude sign-in or driving an interactive `claude` session, and
Paperclip does neither. The only command Paperclip runs to ask the `claude`
binary about its sign-in is `claude auth status`, for the sign-in status panel.
Check your plan usage in Claude itself.

## Prerequisites

- Claude Code CLI installed (`claude` command available) on the host that runs
  the agent. A local run with an API credential and `engine` unset uses the
  ACP engine, which does not need it.
- One of these credentials:
  - On the Paperclip server with the CLI engine: the `claude` CLI signed in as
    the Paperclip user (see [Running Claude on a server](#running-claude-on-a-server)),
    within the [owner-only and trigger-source rules](#who-may-use-the-subscription),
    or an API credential
  - With the ACP engine, or on a remote target: an API credential in the agent
    or environment env (`ANTHROPIC_API_KEY`, a gateway `ANTHROPIC_AUTH_TOKEN`
    that is not a `sk-ant-oat` token, or Bedrock, Vertex, or Foundry
    configuration), or an Anthropic AI connection

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `engine` | string | No | `cli` or `acp`. Unset (or `auto`): a run on the Paperclip server with an API credential uses `acp`, and every other run uses `cli`. `acp` always needs an API credential. See [Execution engines](#execution-engines). |
| `model` | string | No | Claude model to use (default: `claude-opus-5`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs). The Claude subscription token keys (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_TOKEN`, and the sign-in handoff keys listed [above](#how-claude-authenticates)) and any `sk-ant-oat`, `sk-ant-ort`, or `sk-ant-sid` value are rejected. |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat (defaults to `300`) |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (default: `true`); required for headless runs where interactive approval is impossible |

## Default model

An omitted, empty, or whitespace-only `model` uses Claude Opus 5
(`claude-opus-5`) on both the CLI and ACP engines. This also applies to existing
agents with an unset model, including agents created through the API and agents
running in sandboxes. No database migration is needed. The editor shows the
Paperclip default and leaves the setting unset until you select a model.

An explicit `model` takes precedence over `ANTHROPIC_MODEL`. When only
`ANTHROPIC_MODEL` is configured, the adapter keeps that override. Bedrock and
Vertex configurations without an explicit model keep their provider-specific
default because those providers use different model IDs. Host environment
settings apply only to local targets when resolving the model.

The default does not change explicitly configured agent models or the separate
Paperclip Runner's qualified provider profiles.

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## Session Persistence

The adapter persists Claude Code session IDs between heartbeats. On the next wake, it resumes the existing conversation so the agent retains full context.

Session resume is cwd-aware: if the agent's working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

### Poisoned `previous_message_id` (recovery)

Symptom in logs / issue thread:

```
API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)
```

What it means: the on-disk Claude Code transcript JSONL for that session contains a malformed (non-`msg_`-prefixed) `previous_message_id`. Anthropic's `/v1/messages` rejects every resume attempt against that transcript with a deterministic 400. Without guards, Paperclip would re-persist the same poisoned session id and the issue is stranded permanently — see [RED-976](../../../) / [RED-978](../../../).

What the adapter does automatically:

1. **Auto-rotate on resume.** If a `--resume` attempt returns this 400, the adapter retries once with a fresh session, deletes the poisoned `<session>.jsonl` from the local Claude config dir (best effort), and uses the fresh session id going forward.
2. **Validate-before-persist.** A result that carries this 400 never gets its `session_id` written back to the task session store, even if Claude Code emits one in the result event. The adapter returns `sessionId: null`, `sessionParams: null`, and `errorCode: "claude_poisoned_previous_message_id"`.
3. **Clear-on-error.** The adapter sets `clearSession: true` on the result, which causes the heartbeat service to drop any persisted session row for that issue (`clearTaskSessions`). The next continuation starts from a clean slate.

On-call checklist if you see this in production:

- Confirm `errorCode` is `claude_poisoned_previous_message_id` in the run row — that means the guards fired correctly and the issue auto-recovers on the next heartbeat.
- If the same issue still loops after one heartbeat, check that `agentTaskSessions` for that `(agentId, taskKey)` was cleared. If not, the adapter return value was lost (e.g. a malformed run finalization) — escalate; do **not** manually edit the row, file a child issue with the run id.
- For remote execution targets (sandbox/SSH), the poisoned JSONL is on the remote and the adapter only logs the cleanup intent. The fresh-session retry still succeeds because it uses a new session id, and the server-side `clearSession: true` is authoritative regardless of remote disk state.

## Skills Injection

The adapter creates a temporary directory with symlinks to Paperclip skills and passes it via `--add-dir`. This makes skills discoverable without polluting the agent's working directory.

## Remote execution targets

Remote targets (SSH, managed sandboxes, and runners) cannot use the Paperclip
server's Claude sign-in, and Paperclip does not copy a sign-in to them. A
remote `claude_local` run needs an API credential in the agent or environment
env (`ANTHROPIC_API_KEY`, a gateway `ANTHROPIC_AUTH_TOKEN` that is not a
`sk-ant-oat` token, or Bedrock, Vertex, or Foundry configuration), or an
Anthropic AI connection. Remote targets never inherit the Paperclip server's
environment. A run without a credential fails before launch with this message:
"Claude on remote targets needs an Anthropic API key; subscription use is
limited to the claude CLI signed in on this server."

A Paperclip Runner's Claude ACPX lane accepts only `ANTHROPIC_API_KEY`, because
that is the only Claude credential its launch environment passes. Without a
key (or with a `sk-ant-oat` value in it), the server refuses the run before
launch with the same message (`configuration_incomplete`, reason
`claude_api_key_required`), and the runner refuses to prepare the sandbox.

For a sandbox target without an explicit `CLAUDE_CONFIG_DIR`, Paperclip
creates a remote `CLAUDE_CONFIG_DIR` under the run's Claude runtime directory.
It uploads sanitized host-side settings such as `settings.json` and
`CLAUDE.md`. It does not upload host Claude sign-in files. It does not copy
`.credentials.json` or `credentials.json` from the sandbox image's
`$HOME/.claude` into the managed directory.

On both engines, a remote sandbox run never forwards the agent's
`CLAUDE_CONFIG_DIR` path into the sandbox, also when the path is inside the
workspace. It always uses the managed directory, seeded from the sanitized
server settings, or, for an Anthropic AI connection, from that connection's
config directory without its sign-in files. On every remote target (sandbox or
SSH) and both engines, the sign-in files (`.credentials.json`,
`credentials.json`) of every Claude config directory inside the workspace are
neither uploaded with the workspace nor synced back. That covers the agent's
`CLAUDE_CONFIG_DIR`, the server's `CLAUDE_CONFIG_DIR`, and `~/.claude` (when
the workspace is the service user's home directory). A local copy of such a
file is never touched by the sync-back.

This differs from [`codex_local`](/adapters/codex-local), where a
Paperclip-managed sandbox run uploads a host-owned `CODEX_HOME/auth.json`.

## Manual local CLI usage

For manual local CLI usage outside heartbeat runs (for example running as `claudecoder` directly), use:

```sh
npx paperclipai agent local-cli claudecoder --company-id <company-id>
```

This installs Paperclip skills in `~/.claude/skills`, creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- The engine can run with the configured credentials. The ACP engine or a
  remote target without an API credential reports
  `adapter_engine_unavailable`.
- On an instance that fails the
  [owner-only rule](#who-may-use-the-subscription), a Test on the subscription
  lane reports `claude_subscription_not_allowed` and stops before the probe.
- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Which authentication the CLI uses: an `ANTHROPIC_API_KEY` that overrides the
  sign-in, Bedrock, or the `claude` CLI's own sign-in on the Paperclip server
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness

When the probe finds no valid sign-in, the Test reports
`claude_hello_probe_auth_required`. On the Paperclip server, the hint tells
you to run `claude` as the Paperclip user and type `/login`. On a remote
target, the hint tells you to set a valid `ANTHROPIC_API_KEY`. The Test never
starts a sign-in on a remote target.

The probe sees the same layered env as a real run: when an environment is
selected, its environment variables (secret refs included) are resolved and
merged under the adapter config's `env`, so environment-level auth is
reflected in the test result. A secret binding that is missing surfaces as
an `environment_env_binding_missing` failure instead of a silently passing
probe.
