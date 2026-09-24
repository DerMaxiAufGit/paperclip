---
title: Claude Code
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI (`claude`) on the
Paperclip server. It supports session persistence, skills injection, and
structured output parsing.

## How Claude authenticates

Claude can authenticate in two ways:

- **Claude subscription (Pro, Max, Team, Enterprise).** Only the CLI engine on
  the Paperclip server uses a subscription. Paperclip runs the official
  `claude` binary in headless mode
  (`claude --print --output-format stream-json --verbose`) as the operating
  system user that Paperclip runs as. The binary uses that user's own Claude
  sign-in. See [Running Claude on a server](#running-claude-on-a-server).
- **Anthropic API key** (`ANTHROPIC_API_KEY`), or a cloud provider that bills
  outside the subscription (Amazon Bedrock or Google Vertex AI). This works on
  every engine and every execution target. You can store the key as a
  Paperclip secret, or save it as an Anthropic AI connection in **Apps**.

Paperclip never reads, stores, forwards, or injects a Claude sign-in:

- Paperclip has no "connect your Claude subscription" flow. It does not import
  the server's sign-in, create separate login homes, or capture
  `claude setup-token` output.
- Every env map Paperclip stores (agent, project, routine, environment, issue
  override) rejects the `CLAUDE_CODE_OAUTH_TOKEN` environment key. A company
  import skips a `CLAUDE_CODE_OAUTH_TOKEN` input and shows a warning in the
  import preview and result. Paperclip also removes `CLAUDE_CODE_OAUTH_TOKEN`
  from every process it starts, even when the Paperclip server's own
  environment sets it.
- The managed Claude config directory that Paperclip creates for remote
  targets holds only sanitized settings. It never holds a sign-in file, and it
  drops the `env` block and credential helpers (`apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`) of the
  server's `settings.json`.
- A database migration deletes the Claude subscription credentials that
  earlier versions stored, together with their connections, grants, and
  environment bindings. After the upgrade, a Claude subscription runs only
  through the `claude` CLI signed in on the server.

The reason is Anthropic's
[Claude Code legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance).
They say that third-party developers may not offer Claude.ai login in their
own products, may not route requests through Free, Pro, or Max plan
credentials on behalf of their users, and may not collect, store, or
intermediate Claude.ai credentials or session tokens.

A Claude subscription stays subject to Anthropic's usage policies and plan
limits. Running many agents all day on one subscription can be judged outside
ordinary individual use. Use an API key for heavy or shared workloads.

## Execution engines

| Engine | Selected by | Where it runs | Authentication |
|--------|-------------|---------------|----------------|
| CLI | `engine: "cli"`, or the default when the run has no API credential or runs on a remote target | The Paperclip server, or a remote target | On the server: the `claude` sign-in of the Paperclip user, or an API key. On a remote target: an API credential only. |
| ACP | `engine: "acp"`, or the default for a run on the Paperclip server that has an API credential | The Paperclip server, or a remote target | An API credential only |

- An API credential is `ANTHROPIC_API_KEY`, a gateway `ANTHROPIC_AUTH_TOKEN`
  (never a `sk-ant-oat` subscription token), `CLAUDE_CODE_USE_BEDROCK=1`, or
  `CLAUDE_CODE_USE_VERTEX=1` / `CLAUDE_CODE_USE_FOUNDRY=1` set in the agent's
  or environment's variables. `ANTHROPIC_BEDROCK_BASE_URL` alone does not count.
- With `engine` unset (or the old `"auto"` value), a run on the Paperclip
  server that has an API credential uses the ACP engine, so it needs no global
  `claude` binary. Every other run uses the CLI engine. A Claude subscription
  is therefore only ever used by the `claude` binary signed in on the server.
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
  the sign-in itself. For a remote environment, the route reports only whether
  the environment has an `ANTHROPIC_API_KEY`.
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
agent's `env`, or in the execution environment, the `claude` CLI uses the API
key, not the subscription sign-in. The Environment Test shows this as
`claude_anthropic_api_key_overrides_subscription`. To use the subscription,
remove `ANTHROPIC_API_KEY` from the service environment (for example, from
the unit's `Environment=` lines or `EnvironmentFile=`) and from the agent.

Do not use `claude setup-token` or `CLAUDE_CODE_OAUTH_TOKEN`. Paperclip rejects
the key in configurations and removes it from every process it starts.

## Quota waits

Claude ACP runs that end with a typed provider-quota error retain the quota
classification and any parsed reset time. Recovery waits until that time, or
uses its existing one-hour quota backoff when no reset time is available.
The adapter inspects the terminal provider message in memory; the run result
and run log retain only the generic failure message, recovery labels, and reset
timestamp. Context, turn, rate, and configured budget limits are not treated as
subscription quota exhaustion merely because ACP labels them `limit`.

## Subscription usage on the Costs page

Only the `claude` binary supplies the Claude subscription usage on the Costs
page. Paperclip runs `claude auth status` and the CLI's own `/usage` panel as
the Paperclip user, then reads their output. Paperclip does not read Claude
sign-in files or the macOS Keychain, and it does not call Anthropic's usage
API with a Claude sign-in.

The page shows no Claude subscription usage in these cases:

- `claude` is not installed.
- The CLI is signed out, or it uses an API key.
- The server uses Amazon Bedrock.

When the CLI is signed in to a subscription but `/usage` fails, the page shows
the error.

## Prerequisites

- Claude Code CLI installed (`claude` command available) on the host that runs
  the agent
- One of these credentials:
  - On the Paperclip server with the CLI engine: the `claude` CLI signed in as
    the Paperclip user (see [Running Claude on a server](#running-claude-on-a-server)),
    or an API credential
  - With the ACP engine, or on a remote target: `ANTHROPIC_API_KEY` in the
    agent or environment env, an Anthropic AI connection, or Bedrock or Vertex
    configuration

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `engine` | string | No | `cli` (default; also used when the field is unset or `auto`) or `acp` (needs an API key). See [Execution engines](#execution-engines). |
| `model` | string | No | Claude model to use (default: `claude-opus-5`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs). `CLAUDE_CODE_OAUTH_TOKEN` is rejected. |
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
remote `claude_local` run needs `ANTHROPIC_API_KEY` in the agent or
environment env, an Anthropic AI connection, or Bedrock or Vertex
configuration. A run without one fails before launch with this message:
"Claude on remote targets needs an Anthropic API key; subscription use is
limited to the claude CLI signed in on this server."

For a sandbox target without an explicit `CLAUDE_CONFIG_DIR`, Paperclip
creates a remote `CLAUDE_CONFIG_DIR` under the run's Claude runtime directory.
It uploads sanitized host-side settings such as `settings.json` and
`CLAUDE.md`. It does not upload host Claude sign-in files. It does not copy
`.credentials.json` or `credentials.json` from the sandbox image's
`$HOME/.claude` into the managed directory.

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
