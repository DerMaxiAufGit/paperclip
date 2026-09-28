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
 * - `env [flags] [NAME=VALUE]... <command>` whose command is one of these,
 *   through any number of nested `env` wrappers;
 * - an `env` wrapper this model cannot read exactly (see `unreadable`) when
 *   any arg after it names `claude` as above, since it may run another
 *   command than the one read here.
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
  /**
   * True when an `env` wrapper does something this model does not read
   * exactly: an `env -S` string that quotes, escapes, expands `${NAME}` or has
   * a `#` comment, or a flag not known here (which may take the next arg as
   * its value). The env the binary gets then counts as cleared, and no wrapper
   * assignment counts toward the lane, since the wrapper may drop the env or
   * turn a later `NAME=VALUE` into a flag value or a command arg.
   */
  unreadable: boolean;
}

/**
 * One change an `env` wrapper makes to the env it hands on, in order: `clear`
 * for `-i`/`-`/`--ignore-environment` (and BSD `-L`/`-U`), `unset` for
 * `-u NAME`/`--unset NAME`, `set` for a `NAME=VALUE` assignment.
 */
type EnvWrapperStep = { kind: "clear" } | { kind: "unset"; name: string } | { kind: "set"; name: string; value: string };

/**
 * What an `env` flag does: `split` expands `-S`/`--split-string` into args,
 * `none` leaves the env alone, `unreadable` is a flag not known here.
 */
interface EnvFlagSpec {
  effect: "clear" | "unset" | "split" | "none" | "unreadable";
  value: "none" | "required" | "optional";
}

const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "npm", "pnpm", "yarn", "bun", "node"]);
/** GNU coreutils and BSD `env` short flags. Any other flag makes the wrapper unreadable. */
const ENV_SHORT_FLAGS = new Map<string, EnvFlagSpec>([
  ["i", { effect: "clear", value: "none" }],
  ["u", { effect: "unset", value: "required" }],
  ["S", { effect: "split", value: "required" }],
  ["C", { effect: "none", value: "required" }],
  ["v", { effect: "none", value: "none" }],
  // GNU: -a passes another argv[0] to the command; -0 (GNU and BSD) ends output lines with NUL.
  ["a", { effect: "none", value: "required" }],
  ["0", { effect: "none", value: "none" }],
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
  ["argv0", { effect: "none", value: "required" }],
  ["null", { effect: "none", value: "none" }],
  ["debug", { effect: "none", value: "none" }],
  ["block-signal", { effect: "none", value: "optional" }],
  ["default-signal", { effect: "none", value: "optional" }],
  ["ignore-signal", { effect: "none", value: "optional" }],
  ["list-signal-handling", { effect: "none", value: "none" }],
]);
const UNKNOWN_ENV_FLAG: EnvFlagSpec = { effect: "unreadable", value: "none" };
/** The whitespace GNU `env -S` splits on (not every Unicode space, as `\s` would). */
const ENV_SPLIT_WHITESPACE = new Set([" ", "\t", "\n", "\v", "\f", "\r"]);
/** What makes GNU `env -S` quote, escape, expand `${NAME}` or start a comment. */
const ENV_SPLIT_UNREADABLE = /['"\\$#]/;
const ENV_SPLIT_ESCAPES: Record<string, string> = { f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
/** An `env -S` `${NAME}` expansion, which takes its value from an env this model does not have. */
const ENV_SPLIT_EXPANSION = /\$\{[^}]*\}/g;

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

/** True when an arg names claude (see `namesClaude`), or is a `--flag=value` whose value does. */
function argNamesClaude(token: string): boolean {
  if (!token.startsWith("-")) return namesClaude(token);
  const eq = token.indexOf("=");
  return eq > 0 && namesClaude(token.slice(eq + 1));
}

function packageRunnerNamesClaude(args: string[]): boolean {
  for (const token of args) {
    if (token === "--") return false;
    if (argNamesClaude(token)) return true;
  }
  return false;
}

/**
 * Split an `env -S` string into args as GNU coreutils `env` does: whitespace
 * separates; single and double quotes group and are removed; a backslash
 * escapes (`\_` separates outside quotes and is a space inside double quotes,
 * `\c` ends the string); a `#` that starts an arg ends the string. `${NAME}`
 * stays as written. Input `env` refuses (an unknown escape, an unterminated
 * quote) is read leniently. Only a string without any of these features
 * (`ENV_SPLIT_UNREADABLE`) is read as exact.
 */
function splitEnvString(value: string): string[] {
  const args: string[] = [];
  let current: string | null = null;
  let quote: "'" | '"' | null = null;
  const end = () => {
    if (current !== null) args.push(current);
    current = null;
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote === "'") {
      const next = value[index + 1];
      if (char === "'") quote = null;
      else if (char === "\\" && (next === "\\" || next === "'")) current = `${current ?? ""}${value[++index]}`;
      else current = `${current ?? ""}${char}`;
      continue;
    }
    if (char === "\\") {
      const next = value[++index];
      if (next === undefined || next === "c") break;
      if (next === "_" && quote === null) end();
      else current = `${current ?? ""}${next === "_" ? " " : ENV_SPLIT_ESCAPES[next] ?? next}`;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else current = `${current ?? ""}${char}`;
      continue;
    }
    if (ENV_SPLIT_WHITESPACE.has(char)) end();
    else if (char === "#" && current === null) break;
    else if (char === "'" || char === '"') {
      quote = char;
      current = current ?? "";
    } else current = `${current ?? ""}${char}`;
  }
  end();
  return args;
}

/** A long flag by its exact name or a unique prefix of one, as getopt reads it; null when unknown or ambiguous. */
function envLongFlag(name: string): EnvFlagSpec | null {
  const exact = ENV_LONG_FLAGS.get(name);
  if (exact) return exact;
  const matches = name ? [...ENV_LONG_FLAGS.keys()].filter((key) => key.startsWith(name)) : [];
  return matches.length === 1 ? ENV_LONG_FLAGS.get(matches[0]!)! : null;
}

/** Reading a chain of `env` wrappers, each from the args the one before hands on. */
interface EnvWrapperParse {
  /** The args not read yet; `-S` puts the args of its string in front. */
  rest: string[];
  /** Every arg read so far, flag values and split strings included, in order. */
  read: string[];
  steps: EnvWrapperStep[];
  unreadable: boolean;
}

function nextEnvArg(parse: EnvWrapperParse): string | undefined {
  const arg = parse.rest.shift();
  if (arg !== undefined) parse.read.push(arg);
  return arg;
}

function applyEnvFlag(spec: EnvFlagSpec, value: string | undefined, parse: EnvWrapperParse): void {
  if (spec.effect === "clear") parse.steps.push({ kind: "clear" });
  else if (spec.effect === "unset" && value !== undefined) parse.steps.push({ kind: "unset", name: value });
  else if (spec.effect === "unreadable") parse.unreadable = true;
  else if (spec.effect === "split") {
    const text = value ?? "";
    if (ENV_SPLIT_UNREADABLE.test(text)) parse.unreadable = true;
    parse.rest.unshift(...splitEnvString(text));
  }
}

/**
 * Read one `env` flag token (`-i`, `-iu NAME`, `-uNAME`, `--unset=NAME`,
 * `--uns NAME`, …), taking its value from the next arg when it needs one. A
 * flag not known here may change the env, or take a value, in a way not
 * modelled, so it makes the wrapper unreadable.
 */
function readEnvFlag(token: string, parse: EnvWrapperParse): void {
  if (token === "-") {
    parse.steps.push({ kind: "clear" });
    return;
  }
  if (token.startsWith("--")) {
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const spec = envLongFlag(name) ?? UNKNOWN_ENV_FLAG;
    const value = inlineValue ?? (spec.value === "required" ? nextEnvArg(parse) : undefined);
    applyEnvFlag(spec, value, parse);
    return;
  }
  for (let index = 1; index < token.length; index += 1) {
    const spec = ENV_SHORT_FLAGS.get(token[index]!) ?? UNKNOWN_ENV_FLAG;
    if (spec.value === "none") {
      applyEnvFlag(spec, undefined, parse);
      continue;
    }
    const attached = token.slice(index + 1);
    applyEnvFlag(spec, attached || nextEnvArg(parse), parse);
    return;
  }
}

/** Read one `env` wrapper's flags and assignments; returns the command it runs, if any. */
function readEnvWrapper(parse: EnvWrapperParse): string | undefined {
  for (let token = nextEnvArg(parse); token !== undefined; token = nextEnvArg(parse)) {
    // `env` still reads assignments after `--`. Flags read after an assignment
    // or `--` (where `env` would run them as the command) err toward gating.
    if (token === "--") continue;
    if (token.startsWith("-")) {
      readEnvFlag(token, parse);
      continue;
    }
    // `env` takes any arg with a `=` as an assignment, `=VALUE` included.
    const eq = token.indexOf("=");
    if (eq >= 0) {
      parse.steps.push({ kind: "set", name: token.slice(0, eq), value: token.slice(eq + 1) });
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * An unreadable `env` chain whose command, as read here, is not claude counts
 * as a claude run when any arg after `env` names claude (as a package runner
 * arg would, flag values and split strings included). Every arg before that
 * one with a `=` then counts as an assignment, for the endpoint check.
 */
function unreadableClaudeInvocation(parse: EnvWrapperParse): ProcessClaudeInvocation | null {
  if (!parse.unreadable) return null;
  const args = [...parse.read, ...parse.rest];
  const index = args.findIndex(argNamesClaude);
  if (index < 0) return null;
  const assignments = args
    .slice(0, index)
    .filter((arg) => !arg.startsWith("-") && arg.includes("="))
    .map((arg): EnvWrapperStep => {
      const eq = arg.indexOf("=");
      return { kind: "set", name: arg.slice(0, eq), value: arg.slice(eq + 1) };
    });
  return { envSteps: [...parse.steps, ...assignments], args: args.slice(index + 1), unreadable: true };
}

function resolveInvocation(command: string, args: string[]): ProcessClaudeInvocation | null {
  const parse: EnvWrapperParse = { rest: [...args], read: [], steps: [], unreadable: false };
  let base = commandBaseName(command);
  // Each wrapper reads at least its command from `rest`, so this ends.
  while (base === "env") {
    const inner = readEnvWrapper(parse);
    if (inner === undefined) return unreadableClaudeInvocation(parse);
    base = commandBaseName(inner);
  }
  const invocation = { envSteps: parse.steps, args: parse.rest, unreadable: parse.unreadable };
  if (base === "claude") return invocation;
  if (PACKAGE_RUNNERS.has(base) && packageRunnerNamesClaude(parse.rest)) return invocation;
  return unreadableClaudeInvocation(parse);
}

function resolveProcessClaudeInvocation(config: Record<string, unknown>): ProcessClaudeInvocation | null {
  const command = asString(config.command, "").trim();
  if (!command) return null;
  return resolveInvocation(command, asStringArray(config.args));
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
  /** The `env` wrappers were not read exactly, so the lane counts them as clearing the env. */
  unreadable: boolean;
}

/** Appended to an endpoint refusal when the lane counts an unreadable `env` wrapper as clearing the env. */
const UNREADABLE_ENV_WRAPPER_NOTE =
  "Paperclip cannot fully read the env wrapper in this command (an env -S string with quotes, backslashes, " +
  "${…} or #, or an env flag it does not know), so the run counts as using this server's Claude sign-in.";

/**
 * Apply a process agent's `env` wrappers, in order, to the agent env (which
 * the process adapter hands the child) and the host env (which the child
 * inherits): `clear` drops both, `unset` drops the key from both, `set` adds
 * to the agent env, where it wins over the host env as in the launch env. An
 * unreadable wrapper chain leaves the binary an empty env for the lane, and
 * its assignment names lose any `${NAME}` for the endpoint check.
 */
function resolveProcessClaudeGate(config: Record<string, unknown>, hostEnv?: NodeJS.ProcessEnv): ProcessClaudeGate | null {
  const invocation = resolveProcessClaudeInvocation(config);
  if (!invocation) return null;
  const { args, unreadable } = invocation;
  const agentEnv = parseObject(config.env);
  let env: Record<string, unknown> = { ...agentEnv };
  let host: NodeJS.ProcessEnv | undefined;
  const assignments: Record<string, string> = {};
  for (const step of invocation.envSteps) {
    if (step.kind === "set") {
      assignments[unreadable ? step.name.replace(ENV_SPLIT_EXPANSION, "") : step.name] = step.value;
    }
    if (unreadable) continue;
    if (step.kind === "clear") {
      env = {};
      host = {};
    } else if (step.kind === "unset") {
      env = withoutEnvKey(env, step.name);
      host = withoutEnvKey(host ?? hostEnv ?? process.env, step.name);
    } else {
      env[step.name] = step.value;
    }
  }
  return {
    lane: unreadable
      ? { config: { env: {}, args }, hostEnv: {} }
      : { config: { env, args }, ...(host ? { hostEnv: host } : {}) },
    endpointConfig: { env: { ...agentEnv, ...assignments }, args },
    unreadable,
  };
}

/**
 * What the Claude subscription lane gates classify for a run, or null when the
 * run does not start the `claude` binary. A claude_local config is used as is.
 * A `process` agent whose command starts `claude` becomes a claude_local CLI
 * config with its claude args and the env the binary gets: the agent env after
 * its `env` wrappers, as `env` applies them (`-i`, `-u NAME`, then
 * `NAME=VALUE`), plus `hostEnv` (the host env the child inherits, default
 * `process.env`) with the same keys dropped when a wrapper clears or unsets
 * any. A wrapper chain this model cannot read exactly (an `env -S` string with
 * quotes, escapes, `${NAME}` or `#`, or an unknown flag) gets an empty env and
 * host env, so it counts as the subscription lane. Its own `engine` or
 * `managedAiConnection` keys mean nothing to the process adapter, so they are
 * dropped and cannot move the run off the lane.
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
 * still refuses, and so does one in an unreadable `env -S` string (read
 * without its quotes). The run fails with `adapter_engine_unavailable`, as a
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
  if (!violation) return null;
  return buildClaudeSubscriptionHarnessRefusal(
    gate.unreadable ? `${violation} ${UNREADABLE_ENV_WRAPPER_NOTE}` : violation,
  );
}
