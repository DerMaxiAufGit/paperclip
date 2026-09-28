import {
  isClaudeSubscriptionLaneRun,
  resolveClaudeSubscriptionEndpointViolation,
} from "@paperclipai/adapter-claude-local/server";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildClaudeSubscriptionHarnessRefusal } from "@paperclipai/adapter-utils/claude-subscription-harness-guard";
import { asString, asStringArray, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { adapterSupportsRemoteManagedEnvironments } from "@paperclipai/shared";

/**
 * Environment drivers that give an adapter a remote execution target, for
 * adapters that support remote managed environments (see
 * `resolveEnvironmentExecutionTarget` in environment-execution-target.ts).
 * Every other driver, such as a plugin driver, resolves to no target, and the
 * heartbeat then runs the adapter on this server.
 */
const REMOTE_TARGET_DRIVERS = new Set(["ssh", "sandbox"]);

/**
 * Whether a run in an environment with this driver executes away from this
 * server, for the Claude subscription lane gates (owner-only and trigger
 * source). The gates skip remote runs, which need an API key anyway, so this
 * is true only when the adapter really gets a remote target. Any other driver
 * counts as local, so the gates still apply to it.
 */
export function claudeSubscriptionTargetIsRemote(
  driver: string | null | undefined,
  adapterType: string,
): boolean {
  if (!driver || !REMOTE_TARGET_DRIVERS.has(driver)) return false;
  return adapterSupportsRemoteManagedEnvironments(adapterType);
}

/**
 * How a generic `process` agent's command starts the `claude` binary, for the
 * Claude subscription lane checks. That binary reads the service user's Claude
 * sign-in the same way a claude_local run does, so such an agent gets the
 * owner-only and trigger-source gates in the heartbeat and the endpoint check
 * before spawn.
 *
 * Only a direct start is recognized, without parsing a shell:
 * - a command whose basename is `claude` (any path, any case, with or without
 *   a Windows `.exe`/`.cmd`/`.bat`/`.ps1` launcher extension);
 * - a package manager or runtime (`npx`, `pnpx`, `bunx`, `npm`, `pnpm`,
 *   `yarn`, `bun`, `node`) with any arg before `--`, or `--flag=value` value,
 *   that names `claude`, the `@anthropic-ai/claude-code` package, or a file in
 *   that package (the npm install's `cli.js`). This also counts `npm run
 *   claude` and the like, which errs on the side of gating;
 * - `env [flags] [NAME=VALUE]... <command>` whose command is one of these.
 *
 * A shell (`sh -c "claude …"`), a script, or any other program that starts
 * `claude` itself is not seen: a process agent runs any command as the service
 * user, which is a documented limit of the fork policy.
 */
interface ProcessClaudeInvocation {
  /** `NAME=VALUE` assignments of `env` wrappers, which the binary gets on top of the agent env. */
  env: Record<string, string>;
  /** The args after the `claude` command, or all args of a package manager or runtime. */
  args: string[];
  /** True when an `env` flag (`-i`, `-u NAME`, …) may clear or unset the inherited env. */
  ignoresHostEnv: boolean;
}

const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "npm", "pnpm", "yarn", "bun", "node"]);
/** `env` flags whose value is the next arg. `-S`/`--split-string` is expanded instead. */
const ENV_FLAGS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir"]);
const ENV_SPLIT_STRING_FLAGS = new Set(["-S", "--split-string"]);
const MAX_WRAPPER_DEPTH = 4;

function commandBaseName(command: string): string {
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

function namesClaude(token: string): boolean {
  const value = token.trim().toLowerCase();
  if (value === CLAUDE_CODE_PACKAGE || value.startsWith(`${CLAUDE_CODE_PACKAGE}@`)) return true;
  if (value.replace(/\\/g, "/").includes(`${CLAUDE_CODE_PACKAGE}/`)) return true;
  return commandBaseName(value) === "claude";
}

function packageRunnerNamesClaude(args: string[]): boolean {
  for (const token of args) {
    if (token === "--") return false;
    if (token.startsWith("-")) {
      const eq = token.indexOf("=");
      if (eq > 0 && namesClaude(token.slice(eq + 1))) return true;
      continue;
    }
    if (namesClaude(token)) return true;
  }
  return false;
}

function resolveInvocation(command: string, args: string[], depth: number): ProcessClaudeInvocation | null {
  const base = commandBaseName(command);
  if (base === "claude") return { env: {}, args, ignoresHostEnv: false };
  if (PACKAGE_RUNNERS.has(base)) {
    return packageRunnerNamesClaude(args) ? { env: {}, args, ignoresHostEnv: false } : null;
  }
  if (base !== "env" || depth >= MAX_WRAPPER_DEPTH) return null;
  const env: Record<string, string> = {};
  let ignoresHostEnv = false;
  let inner: string | undefined;
  const rest = [...args];
  while (rest.length > 0) {
    const token = rest.shift()!;
    if (token === "--") {
      inner = rest.shift();
      break;
    }
    if (token.startsWith("-")) {
      ignoresHostEnv = true;
      const [flag, inlineValue] = token.split(/=(.*)/s, 2) as [string, string | undefined];
      if (ENV_SPLIT_STRING_FLAGS.has(flag)) {
        const value = inlineValue ?? rest.shift() ?? "";
        rest.unshift(...value.split(/\s+/).filter(Boolean));
      } else if (ENV_FLAGS_WITH_VALUE.has(flag) && inlineValue === undefined) {
        rest.shift();
      }
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      env[token.slice(0, eq)] = token.slice(eq + 1);
      continue;
    }
    inner = token;
    break;
  }
  if (!inner) return null;
  const invocation = resolveInvocation(inner, rest, depth + 1);
  if (!invocation) return null;
  return {
    env: { ...env, ...invocation.env },
    args: invocation.args,
    ignoresHostEnv: ignoresHostEnv || invocation.ignoresHostEnv,
  };
}

function resolveProcessClaudeInvocation(config: Record<string, unknown>): ProcessClaudeInvocation | null {
  const command = asString(config.command, "").trim();
  if (!command) return null;
  return resolveInvocation(command, asStringArray(config.args), 0);
}

/** True when a `process` agent's command starts the `claude` binary directly (see above). */
export function isProcessClaudeCommand(config: Record<string, unknown>): boolean {
  return resolveProcessClaudeInvocation(config) !== null;
}

export interface ClaudeSubscriptionGateInput {
  /** A claude_local CLI config for `isClaudeSubscriptionLaneRun` and the endpoint check. */
  config: Record<string, unknown>;
  /** Empty when the host env may not reach the binary, so a host API key does not count. */
  hostEnv?: NodeJS.ProcessEnv;
}

/**
 * What the Claude subscription lane gates classify for a run, or null when the
 * run does not start the `claude` binary. A claude_local config is used as is.
 * A `process` agent whose command starts `claude` becomes a claude_local CLI
 * config with its env (plus `env` wrapper assignments) and claude args. Its own
 * `engine` or `managedAiConnection` keys mean nothing to the process adapter,
 * so they are dropped and cannot move the run off the lane.
 */
export function claudeSubscriptionGateInput(
  adapterType: string | null | undefined,
  config: Record<string, unknown>,
): ClaudeSubscriptionGateInput | null {
  if (adapterType === "claude_local") return { config };
  if (adapterType !== "process") return null;
  const invocation = resolveProcessClaudeInvocation(config);
  if (!invocation) return null;
  return {
    config: { env: { ...parseObject(config.env), ...invocation.env }, args: invocation.args },
    ...(invocation.ignoresHostEnv ? { hostEnv: {} } : {}),
  };
}

/**
 * The refusal for a `process` agent whose command starts `claude` on the
 * subscription lane (no API credential in its env or the server env) with a
 * config that points the binary away from api.anthropic.com
 * (`resolveClaudeSubscriptionEndpointViolation`), or null when it may spawn.
 * The run fails with `adapter_engine_unavailable`, as a claude_local run does.
 */
export function resolveProcessClaudeSubscriptionRefusal(
  config: Record<string, unknown>,
  hostEnv?: NodeJS.ProcessEnv,
): AdapterExecutionResult | null {
  const gate = claudeSubscriptionGateInput("process", config);
  if (!gate) return null;
  const onLane = isClaudeSubscriptionLaneRun({
    config: gate.config,
    targetIsRemote: false,
    hostEnv: gate.hostEnv ?? hostEnv,
  });
  if (!onLane) return null;
  const violation = resolveClaudeSubscriptionEndpointViolation(gate.config);
  return violation ? buildClaudeSubscriptionHarnessRefusal(violation) : null;
}
