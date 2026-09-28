---
title: Process Adapter
summary: Generic shell process adapter
---

The `process` adapter executes arbitrary shell commands. Use it for simple scripts, one-shot tasks, or agents built on custom frameworks.

## When to Use

- Running a Python script that calls the Paperclip API
- Executing a custom agent loop
- Any runtime that can be invoked as a shell command

## When Not to Use

- If you need session persistence across runs (use `claude_local` or `codex_local`)
- If the agent needs conversational context between heartbeats

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `cwd` | string | No | Working directory |
| `env` | object | No | Environment variables |
| `timeoutSec` | number | No | Process timeout |

## How It Works

1. Paperclip spawns the configured command as a child process
2. Standard Paperclip environment variables are injected (`PAPERCLIP_AGENT_ID`, `PAPERCLIP_API_KEY`, etc.)
3. The process runs to completion
4. Exit code determines success/failure

## Commands That Run Claude Code

A command that starts the `claude` binary directly (for example `claude`,
`npx @anthropic-ai/claude-code`, or `env NAME=VALUE claude`) without an
Anthropic API key in the agent or server env uses the server's Claude sign-in.
Such an agent follows the Claude subscription rules of the
[`claude_local` adapter](/adapters/claude-local): the server owner only, only
wakes the owner drives, and only the `api.anthropic.com` endpoint.

Paperclip applies an `env` wrapper the way `env` does: `env -i` or
`env -u ANTHROPIC_API_KEY claude` drops a server-env API key, so that run uses
the sign-in and gets these rules. An endpoint key in the agent env or in a
wrapper's `NAME=VALUE` is refused even when a wrapper flag clears it.
A wrapper Paperclip cannot read exactly (an `env -S` string with quotes,
backslashes, `${VAR}` or `#`, or an `env` flag it does not know) counts as
clearing the env, so the run counts as using the sign-in even when it sets an
API key; write it as plain `env NAME=VALUE claude` instead. On the sign-in, such
a wrapper is refused when it has `${VAR}` in an `env -S` string or assigns a
name that is not a plain variable name, because Paperclip cannot check which
variable it sets.

Only `process` and `claude_local` agents may run `claude`. An agent of another
adapter (for example `codex_local` or `gemini_local`) whose command starts the
`claude` binary fails before it starts (`configuration_incomplete`, reason
`claude_command_on_other_adapter`), and its Environment Test reports the same
without running the command.

## Example

An agent that runs a Python script:

```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "python3 /path/to/agent.py",
    "cwd": "/path/to/workspace",
    "timeoutSec": 300
  }
}
```

The script can use the injected environment variables to authenticate with the Paperclip API and perform work.
