import { isClaudeSubscriptionLaneRun, resolveClaudeExecutionEngine } from "@paperclipai/adapter-claude-local/server";
import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { claudeCommandOnOtherAdapterRefusal } from "./claude-subscription-target.js";

/**
 * The claude_local environment Test runs a real `claude` hello turn. On the
 * Claude subscription lane (`isClaudeSubscriptionLaneRun`) that turn uses the
 * sign-in of the user Paperclip runs as, which is for the server owner's own
 * use only (doc/plans/2026-09-24-claude-cli-only-auth.md). The Test route is
 * open to every actor with `agents:create`, which includes agent keys, and an
 * agent can be woken from outside Paperclip. So for a caller that is not the
 * board, the server decides how that turn runs, not the caller:
 *
 * - The caller's `extraArgs`/`args` are dropped: an `--mcp-config`,
 *   `--append-system-prompt`, `--settings` file or hooks, `--add-dir` and the
 *   like never reach the CLI. They are replaced by the flags board chat uses,
 *   so the CLI loads only the owner's user settings and no MCP servers. A
 *   project `.claude/settings.json` in the caller-chosen `cwd` (for example
 *   one whose `ANTHROPIC_BASE_URL` would receive the sign-in's bearer token)
 *   and a project `.mcp.json` are not loaded, and the session is not saved.
 * - Permissions are not skipped and `--chrome` is off.
 * - One turn, within the adapter's default probe timeout.
 *
 * The `cwd`, `model`, `effort`, `command` and `env` stay the caller's, so the
 * Test still checks what the agent would run with. The local probe already
 * uses the trusted `claude` executable and an allowlisted env.
 *
 * Dropping the args can only take an inline `--settings` away. Those settings
 * can only take a credential away, never add one (see the claude-local
 * credential policy), so without them the probe either stays on the
 * subscription lane or uses the API credential the settings had blanked,
 * which no longer touches the sign-in. The board keeps the full probe.
 */

/**
 * True when the claude_local Test for this config runs a local `claude` probe
 * on the server's Claude sign-in, so the owner-only gate and
 * `claudeSubscriptionProbeConfigForActor` apply. It follows the adapter's Test:
 * the ACP engine's Test starts no `claude` CLI, and the CLI probe child gets
 * only part of the adapter env, so the lane is decided on that part
 * (`localTestProbe`), never on the agent's full config. A Vertex- or
 * Foundry-only agent is metered, but its CLI probe runs on the sign-in.
 */
export function isClaudeSubscriptionLaneTestProbe(input: {
  config: Record<string, unknown>;
  target: AdapterExecutionTarget | null | undefined;
}): boolean {
  if (resolveClaudeExecutionEngine(input.config, input.target).engine === "acp") return false;
  return isClaudeSubscriptionLaneRun({ config: input.config, target: input.target, localTestProbe: true });
}

/**
 * The failing environment Test check for an agent of another adapter (not
 * claude_local or `process`) whose command starts the `claude` binary
 * (`claudeCommandOnOtherAdapterRefusal`), or null. That adapter's Test runs
 * its command as the service user (version checks, hello probes), so `claude`
 * would use the server's Claude sign-in with none of the claude_local rules.
 * The route returns this check before the adapter's Test runs, as the
 * heartbeat refuses the run.
 */
export function claudeCommandOnOtherAdapterTestCheck(
  adapterType: string,
  config: Record<string, unknown>,
): AdapterEnvironmentCheck | null {
  const refusal = claudeCommandOnOtherAdapterRefusal(adapterType, config);
  if (!refusal) return null;
  return {
    code: refusal.reason,
    level: "error",
    message: refusal.message,
    hint: "Use the claude_local adapter to run Claude.",
  };
}

/** The flags a non-board subscription-lane probe runs with, in place of the caller's args. */
export const CLAUDE_SUBSCRIPTION_PROBE_ISOLATION_ARGS: readonly string[] = [
  "--setting-sources",
  "user",
  "--strict-mcp-config",
  "--no-session-persistence",
];

/**
 * The adapter config for a claude_local Test probe that runs on the Claude
 * subscription lane. The caller decides that the probe is on the lane. A board
 * caller gets its config back unchanged; any other caller gets a copy with the
 * probe fixed by the server (see the file comment).
 */
export function claudeSubscriptionProbeConfigForActor(
  actor: { type: string },
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (actor.type === "board") return config;
  const restricted: Record<string, unknown> = {
    ...config,
    extraArgs: [...CLAUDE_SUBSCRIPTION_PROBE_ISOLATION_ARGS],
    dangerouslySkipPermissions: false,
    chrome: false,
    maxTurnsPerRun: 1,
  };
  delete restricted.args;
  delete restricted.helloProbeTimeoutSec;
  return restricted;
}
