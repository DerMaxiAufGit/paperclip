import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";

import { CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE, isClaudeSubscriptionTokenValue } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

/**
 * The claude_local status panel. A Claude subscription is used only through
 * the official `claude` CLI signed in on the Paperclip server itself. The panel
 * reads the existing adapter auth-signal route, which runs `claude auth status`
 * on the server. Paperclip never reads, stores or forwards the Claude sign-in,
 * so the panel only reports the CLI's own answer and shows how to sign in.
 */
export const CLAUDE_CLI_SIGN_IN_TITLE = "Uses the claude CLI signed in on this server";

export const CLAUDE_CLI_SIGN_IN_STEPS = [
  "Open a shell on the server as the user Paperclip runs as.",
  "Run claude.",
  "Enter /login and finish the sign-in in your browser.",
] as const;

export type ClaudeCliSignInState =
  | "checking"
  | "signed_in"
  | "signed_out"
  | "cli_missing"
  | "not_allowed"
  | "unknown";

export function useClaudeCliSignIn(
  companyId: string | null | undefined,
  environmentId?: string | null,
  enabled = true,
) {
  const query = useQuery({
    queryKey: companyId
      ? queryKeys.agents.authSignal(companyId, "claude_local", environmentId ?? null)
      : ["agents", "none", "auth-signal", "claude_local", environmentId ?? null],
    queryFn: () => agentsApi.getAdapterAuthSignal(companyId!, "claude_local", environmentId ?? null),
    enabled: Boolean(companyId) && enabled,
    retry: false,
  });
  const state: ClaudeCliSignInState = query.isPending
    ? "checking"
    : query.isError
      ? "unknown"
      : query.data?.reason === "subscription_not_allowed"
        ? "not_allowed"
        : query.data?.status === "present"
        ? "signed_in"
        : query.data?.status === "absent"
          ? "signed_out"
          : query.data?.reason === "cli_missing"
            ? "cli_missing"
            : "unknown";
  return { state, recheck: () => void query.refetch(), rechecking: query.isFetching };
}

function statusMessage(state: ClaudeCliSignInState): string {
  switch (state) {
    case "checking":
      return "Checking the claude CLI sign-in on this server.";
    case "signed_in":
      return "The claude CLI on this server is signed in.";
    case "signed_out":
      return "The claude CLI on this server is not signed in.";
    case "cli_missing":
      return "The claude CLI is not installed for the user Paperclip runs as on this server.";
    case "not_allowed":
      return CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE;
    default:
      return "Could not confirm the claude CLI sign-in on this server.";
  }
}

export const CLAUDE_CLI_SIGNED_IN_BUT_REJECTED_NOTE =
  "The run was rejected even though the claude CLI reports a sign-in. The sign-in may have expired or been revoked: sign in again with the steps below.";

export function ClaudeCliSignInStatus({
  companyId,
  environmentId,
  afterAuthFailure = false,
  className,
}: {
  companyId: string | null | undefined;
  environmentId?: string | null;
  /**
   * The panel explains a run that failed with `claude_auth_required`. `claude
   * auth status` reads only the stored sign-in, so it can still report
   * "signed in" after that sign-in expired or was revoked. The steps and
   * Check again then stay visible in every state, as re-sign-in steps.
   */
  afterAuthFailure?: boolean;
  className?: string;
}) {
  const { state, recheck, rechecking } = useClaudeCliSignIn(companyId, environmentId);
  const needsInstall = state === "cli_missing";
  // On an instance with other users the server sign-in cannot be used at all,
  // so signing in does not help: the agent needs an Anthropic API key.
  const notAllowed = state === "not_allowed";
  const needsSignIn = notAllowed
    ? false
    : afterAuthFailure
      ? !needsInstall
      : state === "signed_out" || state === "unknown";
  return (
    <div className={cn("border border-border px-4 py-4", className)} data-testid="claude-cli-sign-in-status">
      <p className="text-sm font-medium text-foreground">{CLAUDE_CLI_SIGN_IN_TITLE}</p>
      <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground" role="status">
        {state === "checking" ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : state === "signed_in" ? (
          <CheckCircle2 className="size-4 text-foreground" aria-hidden />
        ) : (
          <CircleAlert className="size-4" aria-hidden />
        )}
        {statusMessage(state)}
      </p>
      {afterAuthFailure && state === "signed_in" && (
        <p className="mt-3 text-sm text-muted-foreground">{CLAUDE_CLI_SIGNED_IN_BUT_REJECTED_NOTE}</p>
      )}
      {needsSignIn && (
        <>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{CLAUDE_CLI_SIGN_IN_STEPS[0]}</li>
            <li>
              Run <code className="font-mono text-foreground">claude</code>.
            </li>
            <li>
              Enter <code className="font-mono text-foreground">/login</code> and finish the sign-in in your browser.
            </li>
          </ol>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={recheck} disabled={rechecking}>
            {rechecking ? "Checking" : "Check again"}
          </Button>
        </>
      )}
      {needsInstall && (
        <>
          <p className="mt-3 text-sm text-muted-foreground">
            Install Claude Code for the user Paperclip runs as, so that{" "}
            <code className="font-mono text-foreground">claude</code> is on that user&rsquo;s PATH. Then sign in and check again.
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={recheck} disabled={rechecking}>
            {rechecking ? "Checking" : "Check again"}
          </Button>
        </>
      )}
      <p className="mt-3 text-sm text-muted-foreground">Paperclip does not store your Claude sign-in.</p>
    </div>
  );
}

export const CLAUDE_AUTH_REQUIRED_API_KEY_HINT =
  "If this agent uses an Anthropic API key, check that the key is valid instead.";

export const CLAUDE_API_CREDENTIAL_TITLE = "Uses an Anthropic API credential";

export const CLAUDE_API_CREDENTIAL_REJECTED_ACTION =
  "The credential was rejected. Update the ANTHROPIC_API_KEY secret for this agent or its environment (or the gateway token or cloud provider credentials it uses), then run the agent again.";

type EnvBindingLike = unknown;

/** A binding's literal value, or null for a secret reference or an unset binding. */
function plainEnvValue(binding: EnvBindingLike): string | null {
  if (typeof binding === "string") return binding.trim();
  if (binding && typeof binding === "object") {
    const record = binding as Record<string, unknown>;
    if (record.type === "plain") return typeof record.value === "string" ? record.value.trim() : "";
  }
  return null;
}

function envBindingIsSet(binding: EnvBindingLike): boolean {
  const plain = plainEnvValue(binding);
  if (plain !== null) return plain.length > 0;
  if (binding && typeof binding === "object") {
    const type = (binding as Record<string, unknown>).type;
    return type === "secret_ref" || type === "user_secret_ref";
  }
  return false;
}

function envFlagSet(binding: EnvBindingLike): boolean {
  const plain = plainEnvValue(binding);
  return plain === "1" || plain === "true";
}

/**
 * True when a claude_local run could not have used the claude CLI sign-in on
 * this server, as far as the agent's config and the run record show: the ACP
 * engine, an Anthropic API credential in the adapter env (API key, gateway
 * `ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex or Foundry), or a managed Anthropic
 * AI connection on the run. Mirrors the server's `claudeRunHasApiCredential`;
 * the server's own host env is not visible here.
 */
export function claudeRunUsesApiCredential(input: {
  adapterConfig: Record<string, unknown> | null | undefined;
  contextSnapshot?: Record<string, unknown> | null;
}): boolean {
  const config = input.adapterConfig ?? {};
  if (typeof config.engine === "string" && config.engine.trim().toLowerCase() === "acp") return true;
  const aiConnection = input.contextSnapshot?.aiConnection;
  if (
    aiConnection &&
    typeof aiConnection === "object" &&
    (aiConnection as Record<string, unknown>).provider === "anthropic"
  ) {
    return true;
  }
  const env =
    config.env && typeof config.env === "object" ? (config.env as Record<string, EnvBindingLike>) : {};
  // A subscription token (`sk-ant-oat…`) under either key is not an API credential.
  const apiCredentialSet = (binding: EnvBindingLike) =>
    envBindingIsSet(binding) && !isClaudeSubscriptionTokenValue(plainEnvValue(binding));
  if (apiCredentialSet(env.ANTHROPIC_API_KEY)) return true;
  if (apiCredentialSet(env.ANTHROPIC_AUTH_TOKEN)) return true;
  return (
    envFlagSet(env.CLAUDE_CODE_USE_BEDROCK) ||
    envFlagSet(env.CLAUDE_CODE_USE_VERTEX) ||
    envFlagSet(env.CLAUDE_CODE_USE_FOUNDRY)
  );
}

/** The environment a run used, from its context snapshot, or null when not recorded. */
export function readRunEnvironment(
  contextSnapshot: Record<string, unknown> | null | undefined,
): { id: string | null; driver: string | null } | null {
  const raw = contextSnapshot?.paperclipEnvironment;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    id: typeof record.id === "string" && record.id ? record.id : null,
    driver: typeof record.driver === "string" && record.driver ? record.driver : null,
  };
}

/**
 * Shown on a claude_local run that failed with `claude_auth_required`.
 *
 * An ACP run, a run with an API credential, and a run on a remote environment
 * (SSH, sandbox) never use the claude CLI signed in on this server, so for them
 * the guidance points at the API credential and hides the server sign-in.
 *
 * Otherwise the run used the server CLI's own sign-in. Paperclip cannot finish
 * a Claude sign-in for the server (it cannot pass the sign-in code back to the
 * CLI), so there is no sign-in button: the operator signs in on the server
 * shell. The panel shows `claude auth status` for the run's environment and
 * the re-sign-in steps, also when the CLI still reports a sign-in, since an
 * expired or revoked sign-in fails the run the same way.
 */
export function ClaudeAuthRequiredRunGuidance({
  companyId,
  adapterConfig,
  contextSnapshot,
}: {
  companyId: string | null | undefined;
  adapterConfig?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
}) {
  const environment = readRunEnvironment(contextSnapshot);
  const targetIsRemote = environment?.driver != null && environment.driver !== "local";
  if (targetIsRemote || claudeRunUsesApiCredential({ adapterConfig, contextSnapshot })) {
    return (
      <div className="border border-border px-4 py-4" data-testid="claude-auth-required-guidance">
        <p className="text-sm font-medium text-foreground">{CLAUDE_API_CREDENTIAL_TITLE}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {targetIsRemote
            ? "Claude on this environment runs with an Anthropic API credential, not the claude CLI signed in on this server. Signing in on the server does not help."
            : "This agent runs with an Anthropic API credential, not the claude CLI signed in on this server. Signing in on the server does not help."}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{CLAUDE_API_CREDENTIAL_REJECTED_ACTION}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="claude-auth-required-guidance">
      <ClaudeCliSignInStatus companyId={companyId} environmentId={environment?.id ?? null} afterAuthFailure />
      <p className="text-xs text-muted-foreground">{CLAUDE_AUTH_REQUIRED_API_KEY_HINT}</p>
    </div>
  );
}
