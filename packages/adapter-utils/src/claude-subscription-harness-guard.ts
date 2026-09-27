import { isClaudeSubscriptionTokenValue } from "@paperclipai/shared";
import type { AdapterExecutionResult } from "./types.js";

/**
 * Only the official `claude` binary may use a Claude Free/Pro/Max subscription,
 * through the sign-in of the user Paperclip runs as (the claude_local adapter).
 * A third-party harness that can route to Anthropic (Hermes, Pi, OpenCode)
 * falls back to a stored Claude sign-in when it has no API key: its own login,
 * or the service user's `~/.claude` credentials. Paperclip therefore launches
 * such a harness on an Anthropic model only when the run env holds an Anthropic
 * API key, and refuses the run otherwise.
 *
 * Only the env keys a harness actually reads as an API key count. Claude Code
 * settings such as `CLAUDE_CODE_USE_BEDROCK` do not: these harnesses ignore
 * them and reach Bedrock or Vertex through their own provider IDs.
 */
export const CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE =
  "Only the official claude binary may use a Claude subscription. Give this agent an Anthropic API key, or use the Claude (claude_local) adapter.";

export const ANTHROPIC_API_KEY_ENV_KEY = "ANTHROPIC_API_KEY";

/** A non-empty value that is not a Claude subscription token (`sk-ant-oat…`). */
export function isAnthropicApiCredentialValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !isClaudeSubscriptionTokenValue(value);
}

/** True when one of `keys` in `env` holds an Anthropic API credential. */
export function envHasAnthropicApiCredential(
  env: Record<string, string | undefined>,
  keys: readonly string[] = [ANTHROPIC_API_KEY_ENV_KEY],
): boolean {
  return keys.some((key) => isAnthropicApiCredentialValue(env[key]));
}

/**
 * The values a harness CLI reads for any of `flags` in `args`, in order:
 * `--flag value`, `--flag=value`, `-f value`, `-f=value` and `-fvalue` (for a
 * single-letter short flag). With `abbreviations`, a long flag also matches any
 * prefix of it of at least three characters (`--prov`), as Python's argparse
 * accepts.
 *
 * User-supplied extra args are appended after the provider and model flags
 * Paperclip sets, so a later value wins in the harness. The harness guards read
 * them with this so an extra `--provider anthropic` or `--model anthropic/…`
 * cannot bypass the Anthropic API key check.
 */
export function readHarnessCliFlagValues(
  args: readonly string[] | null | undefined,
  flags: readonly string[],
  options: { abbreviations?: boolean } = {},
): string[] {
  const values: string[] = [];
  const list = args ?? [];
  const matchesLong = (name: string): boolean =>
    flags.some(
      (flag) =>
        flag.startsWith("--") &&
        (name === flag || (options.abbreviations === true && name.length >= 3 && flag.startsWith(name))),
    );
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (typeof arg !== "string") continue;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (!matchesLong(name)) continue;
      if (eq >= 0) values.push(arg.slice(eq + 1));
      else if (index + 1 < list.length && typeof list[index + 1] === "string") values.push(list[++index]!);
      continue;
    }
    if (arg.startsWith("-") && arg.length >= 2) {
      const short = arg.slice(0, 2);
      if (!flags.includes(short)) continue;
      const rest = arg.slice(2);
      if (rest.length > 0) values.push(rest.startsWith("=") ? rest.slice(1) : rest);
      else if (index + 1 < list.length && typeof list[index + 1] === "string") values.push(list[++index]!);
    }
  }
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

/**
 * The refusal message when a third-party harness run routes to Anthropic
 * without an Anthropic API key in the env the harness gets, or null when the
 * run may start. A run that does not route to Anthropic is never refused.
 */
export function resolveClaudeSubscriptionHarnessViolation(input: {
  anthropicRoute: boolean;
  env: Record<string, string | undefined>;
  apiKeyEnvKeys?: readonly string[];
}): string | null {
  if (!input.anthropicRoute) return null;
  if (envHasAnthropicApiCredential(input.env, input.apiKeyEnvKeys)) return null;
  return CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE;
}

/**
 * The execution result for a refused run. The harness never started, and the
 * error code is non-retryable, so recovery does not re-queue the run.
 */
export function buildClaudeSubscriptionHarnessRefusal(
  message: string = CLAUDE_SUBSCRIPTION_THIRD_PARTY_HARNESS_MESSAGE,
  extra: Pick<AdapterExecutionResult, "provider" | "model"> = {},
): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "adapter_engine_unavailable",
    errorMessage: message,
    ...extra,
    resultJson: {
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    },
  };
}
