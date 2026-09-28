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
  /** What `env` wrappers do to the env the binary gets, outermost wrapper first. */
  envSteps: EnvWrapperStep[];
  /** The args after the `claude` command, or all args of a package manager or runtime. */
  args: string[];
}

/**
 * One change an `env` wrapper makes to the env it hands on, in order: `clear`
 * for `-i`/`-`/`--ignore-environment` (and any flag not known here),
 * `unset` for `-u NAME`/`--unset NAME`, `set` for a `NAME=VALUE` assignment.
 */
type EnvWrapperStep = { kind: "clear" } | { kind: "unset"; name: string } | { kind: "set"; name: string; value: string };

/** What an `env` flag does: `split` expands `-S`/`--split-string` into args, `none` leaves the env alone. */
interface EnvFlagSpec {
  effect: "clear" | "unset" | "split" | "none";
  value: "none" | "required" | "optional";
}

const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "npm", "pnpm", "yarn", "bun", "node"]);
/** GNU coreutils and BSD `env` short flags. Any other flag counts as `clear`. */
const ENV_SHORT_FLAGS = new Map<string, EnvFlagSpec>([
  ["i", { effect: "clear", value: "none" }],
  ["u", { effect: "unset", value: "required" }],
  ["S", { effect: "split", value: "required" }],
  ["C", { effect: "none", value: "required" }],
  ["v", { effect: "none", value: "none" }],
  // BSD: -P searches another PATH for the command; -L/-U load a login class env.
  ["P", { effect: "none", value: "required" }],
  ["L", { effect: "clear", value: "required" }],
  ["U", { effect: "clear", value: "required" }],
]);
/** GNU coreutils `env` long flags, which getopt also takes as unique prefixes. */
const ENV_LONG_FLAGS = new Map<string, EnvFlagSpec>([
  ["ignore-environment", { effect: "clear", value: "none" }],
  ["unset", { effect: "unset", value: "required" }],
  ["split-string", { effect: "split", value: "required" }],
  ["chdir", { effect: "none", value: "required" }],
  ["debug", { effect: "none", value: "none" }],
  ["block-signal", { effect: "none", value: "optional" }],
  ["default-signal", { effect: "none", value: "optional" }],
  ["ignore-signal", { effect: "none", value: "optional" }],
  ["list-signal-handling", { effect: "none", value: "none" }],
]);
const CLEAR_ENV_FLAG: EnvFlagSpec = { effect: "clear", value: "none" };
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

/** A long flag by its exact name or a unique prefix of one, as getopt reads it; null when unknown or ambiguous. */
function envLongFlag(name: string): EnvFlagSpec | null {
  const exact = ENV_LONG_FLAGS.get(name);
  if (exact) return exact;
  const matches = name ? [...ENV_LONG_FLAGS.keys()].filter((key) => key.startsWith(name)) : [];
  return matches.length === 1 ? ENV_LONG_FLAGS.get(matches[0]!)! : null;
}

function applyEnvFlag(spec: EnvFlagSpec, value: string | undefined, rest: string[], steps: EnvWrapperStep[]): void {
  if (spec.effect === "clear") steps.push({ kind: "clear" });
  else if (spec.effect === "unset" && value !== undefined) steps.push({ kind: "unset", name: value });
  else if (spec.effect === "split") rest.unshift(...(value ?? "").split(/\s+/).filter(Boolean));
}

/**
 * Read one `env` flag token (`-i`, `-iu NAME`, `-uNAME`, `--unset=NAME`,
 * `--uns NAME`, …), taking its value from `rest` when it is the next arg. A
 * flag not known here may change the env in a way not modelled, so it counts
 * as clearing it: a credential it might remove then does not count.
 */
function readEnvFlag(token: string, rest: string[], steps: EnvWrapperStep[]): void {
  if (token === "-") {
    steps.push({ kind: "clear" });
    return;
  }
  if (token.startsWith("--")) {
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const spec = envLongFlag(name) ?? CLEAR_ENV_FLAG;
    const value = inlineValue ?? (spec.value === "required" ? rest.shift() : undefined);
    applyEnvFlag(spec, value, rest, steps);
    return;
  }
  for (let index = 1; index < token.length; index += 1) {
    const spec = ENV_SHORT_FLAGS.get(token[index]!) ?? CLEAR_ENV_FLAG;
    if (spec.value === "none") {
      applyEnvFlag(spec, undefined, rest, steps);
      continue;
    }
    const attached = token.slice(index + 1);
    applyEnvFlag(spec, attached || rest.shift(), rest, steps);
    return;
  }
}

function resolveInvocation(command: string, args: string[], depth: number): ProcessClaudeInvocation | null {
  const base = commandBaseName(command);
  if (base === "claude") return { envSteps: [], args };
  if (PACKAGE_RUNNERS.has(base)) {
    return packageRunnerNamesClaude(args) ? { envSteps: [], args } : null;
  }
  if (base !== "env" || depth >= MAX_WRAPPER_DEPTH) return null;
  const steps: EnvWrapperStep[] = [];
  let inner: string | undefined;
  const rest = [...args];
  while (rest.length > 0) {
    const token = rest.shift()!;
    // `env` still reads assignments after `--`. Flags read after an assignment
    // or `--` (where `env` would run them as the command) err toward gating.
    if (token === "--") continue;
    if (token.startsWith("-")) {
      readEnvFlag(token, rest, steps);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      steps.push({ kind: "set", name: token.slice(0, eq), value: token.slice(eq + 1) });
      continue;
    }
    inner = token;
    break;
  }
  if (!inner) return null;
  const invocation = resolveInvocation(inner, rest, depth + 1);
  if (!invocation) return null;
  return { envSteps: [...steps, ...invocation.envSteps], args: invocation.args };
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

/** `env` without every key named `name`, in any case (a superset of what `env -u` drops, which fails closed). */
function withoutEnvKey<T>(env: Record<string, T>, name: string): Record<string, T> {
  const upper = name.toUpperCase();
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== upper));
}

export interface ClaudeSubscriptionGateInput {
  /** A claude_local CLI config for `isClaudeSubscriptionLaneRun`. */
  config: Record<string, unknown>;
  /** The host env the binary gets, when an `env` wrapper clears or unsets some of it. */
  hostEnv?: NodeJS.ProcessEnv;
}

interface ProcessClaudeGate {
  /** The env the binary really gets, after the `env` wrappers, for the lane classification. */
  lane: ClaudeSubscriptionGateInput;
  /** The agent env plus every wrapper assignment, whatever the flags drop, for the endpoint check. */
  endpointConfig: Record<string, unknown>;
}

/**
 * Apply a process agent's `env` wrappers, in order, to the agent env (which
 * the process adapter hands the child) and the host env (which the child
 * inherits): `clear` drops both, `unset` drops the key from both, `set` adds
 * to the agent env, where it wins over the host env as in the launch env.
 */
function resolveProcessClaudeGate(config: Record<string, unknown>, hostEnv?: NodeJS.ProcessEnv): ProcessClaudeGate | null {
  const invocation = resolveProcessClaudeInvocation(config);
  if (!invocation) return null;
  const agentEnv = parseObject(config.env);
  let env: Record<string, unknown> = { ...agentEnv };
  let host: NodeJS.ProcessEnv | undefined;
  const assignments: Record<string, string> = {};
  for (const step of invocation.envSteps) {
    if (step.kind === "clear") {
      env = {};
      host = {};
    } else if (step.kind === "unset") {
      env = withoutEnvKey(env, step.name);
      host = withoutEnvKey(host ?? hostEnv ?? process.env, step.name);
    } else {
      env[step.name] = step.value;
      assignments[step.name] = step.value;
    }
  }
  return {
    lane: { config: { env, args: invocation.args }, ...(host ? { hostEnv: host } : {}) },
    endpointConfig: { env: { ...agentEnv, ...assignments }, args: invocation.args },
  };
}

/**
 * What the Claude subscription lane gates classify for a run, or null when the
 * run does not start the `claude` binary. A claude_local config is used as is.
 * A `process` agent whose command starts `claude` becomes a claude_local CLI
 * config with its claude args and the env the binary gets: the agent env after
 * its `env` wrappers, as `env` applies them (`-i`, `-u NAME`, then
 * `NAME=VALUE`; an unknown flag counts as `-i`), plus `hostEnv` (the host env
 * the child inherits, default `process.env`) with the same keys dropped when a
 * wrapper clears or unsets any. Its own `engine` or `managedAiConnection` keys
 * mean nothing to the process adapter, so they are dropped and cannot move the
 * run off the lane.
 */
export function claudeSubscriptionGateInput(
  adapterType: string | null | undefined,
  config: Record<string, unknown>,
  hostEnv?: NodeJS.ProcessEnv,
): ClaudeSubscriptionGateInput | null {
  if (adapterType === "claude_local") return { config };
  if (adapterType !== "process") return null;
  return resolveProcessClaudeGate(config, hostEnv)?.lane ?? null;
}

/**
 * The refusal for a `process` agent whose command starts `claude` on the
 * subscription lane (no API credential in the env the binary gets, see
 * `claudeSubscriptionGateInput`) with a config that points the binary away
 * from api.anthropic.com (`resolveClaudeSubscriptionEndpointViolation`), or
 * null when it may spawn. The endpoint check reads the agent env plus every
 * `env` wrapper assignment, so a key that a wrapper flag clears or unsets
 * still refuses. The run fails with `adapter_engine_unavailable`, as a
 * claude_local run does.
 */
export function resolveProcessClaudeSubscriptionRefusal(
  config: Record<string, unknown>,
  hostEnv?: NodeJS.ProcessEnv,
): AdapterExecutionResult | null {
  const gate = resolveProcessClaudeGate(config, hostEnv);
  if (!gate) return null;
  const onLane = isClaudeSubscriptionLaneRun({
    config: gate.lane.config,
    targetIsRemote: false,
    hostEnv: gate.lane.hostEnv ?? hostEnv,
  });
  if (!onLane) return null;
  const violation = resolveClaudeSubscriptionEndpointViolation(gate.endpointConfig);
  return violation ? buildClaudeSubscriptionHarnessRefusal(violation) : null;
}
