import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterBillingType,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  parseLocalProcessFilesystemScope,
  parseLocalProcessNetworkScope,
} from "@paperclipai/adapter-utils/local-process-sandbox";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import type {
  AcpxEngineExecutorOptions,
  AcpxRemoteManagedHomeContext,
  AcpxRemoteManagedHomeResult,
  AcpxTerminalSessionFailure,
  AcpxTerminalFailureClassification,
} from "@paperclipai/adapter-utils/acpx-engine/execute";
import {
  asNumber,
  asString,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  materializeRemoteClaudeConfig,
  prepareClaudeConfigSeed,
} from "./claude-config.js";
import { buildAdapterTestTargetCheck } from "./probe-diagnostics.js";
import { createWorkspaceRestoreTeardown } from "@paperclipai/adapter-utils/workspace-restore-teardown";
import { extractClaudeRetryNotBefore, isClaudeProviderQuotaError } from "./parse.js";
import {
  resolveClaudeBillingIdentity,
  resolveClaudeCredentialPolicyViolation,
  resolveClaudeDefaultEngine,
  withoutClaudeSubscriptionTokens,
} from "./credential-policy.js";
import { resolveClaudeModel } from "../index.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");
const MIN_ACP_NODE_VERSION = "24.11.0";

export type ClaudeExecutionEngine = "cli" | "acp";

export interface ClaudeEngineSelection {
  engine: ClaudeExecutionEngine;
  explicit: boolean;
  unavailableReason?: string;
}

type ClaudeEngineResolutionInput =
  Pick<AdapterExecutionContext, "config"> &
  Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>;

type ClaudeAcpExecutorOptions = Omit<
  AcpxEngineExecutorOptions,
  "adapterType" | "moduleDir" | "packageRootDir"
>;

type ClaudeAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

/**
 * An explicit `engine` always wins. When it is not set, the engine follows the
 * credential (see `resolveClaudeDefaultEngine`): a local run with an Anthropic
 * API credential uses ACP, which needs no global `claude` binary; every other
 * run uses the CLI engine, so a subscription is only ever used by the official
 * `claude` binary signed in on this server.
 */
function resolveEngineSelection(
  config: Record<string, unknown>,
  target: AdapterExecutionTarget | null | undefined,
): ClaudeEngineSelection {
  const raw = typeof config.engine === "string" ? config.engine.trim().toLowerCase() : "";
  if (raw === "acp") return { engine: "acp", explicit: true };
  if (raw === "cli") return { engine: "cli", explicit: true };
  // Local filesystem/network confinement exists only on the CLI engine.
  const confinementRequested = config.filesystemScope != null || config.networkScope != null;
  if (confinementRequested) return { engine: "cli", explicit: false };
  return {
    engine: resolveClaudeDefaultEngine({ config, targetIsRemote: target?.kind === "remote" }),
    explicit: false,
  };
}

export function resolveClaudeExecutionEngine(
  config: Record<string, unknown>,
  target?: AdapterExecutionTarget | null,
): ClaudeEngineSelection {
  return resolveEngineSelection(config, target);
}

export async function resolveClaudeExecutionEngineForRun(
  input: ClaudeEngineResolutionInput,
): Promise<ClaudeEngineSelection> {
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  const selection = resolveEngineSelection(input.config, target);
  // Subscription use is limited to the local CLI engine. ACP and remote targets
  // need an API credential; fail before launch instead of changing engines.
  const credentialViolation = resolveClaudeCredentialPolicyViolation({
    engine: selection.engine,
    config: input.config,
    target,
  });
  if (credentialViolation) return { ...selection, unavailableReason: credentialViolation };
  // Engine availability must never change the agent's execution or permission contract.
  if (selection.engine === "cli") return selection;
  const unavailable = (reason: string): ClaudeEngineSelection => ({
    ...selection,
    unavailableReason: `${reason} Repair the ACP setup, or explicitly set engine=cli to use the CLI engine.`,
  });
  const filesystemScope = parseLocalProcessFilesystemScope(input.config.filesystemScope);
  const networkScope = parseLocalProcessNetworkScope(input.config.networkScope);
  if (filesystemScope || networkScope) {
    return unavailable("Local filesystem/network confinement requires the Claude CLI engine; ACP confinement is not supported.");
  }

  const reason = await claudeAcpUnavailableReason(input);
  return reason ? unavailable(reason) : selection;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export function buildClaudeAcpConfig(
  config: Record<string, unknown>,
  inheritedEnv: Record<string, unknown> = {},
): Record<string, unknown> {
  // Never forward a Claude subscription token into the ACP engine.
  const env = withoutClaudeSubscriptionTokens(parseObject(config.env));
  const model = resolveClaudeModel(config.model, { ...inheritedEnv, ...env });
  const agentCommand = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  const stateDir = firstNonEmptyString(config.stateDir, config.acpStateDir);
  const mode = firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE;
  const permissionMode =
    firstNonEmptyString(config.permissionMode, config.acpPermissionMode) ??
    DEFAULT_ACP_ENGINE_PERMISSION_MODE;
  const nonInteractivePermissions =
    firstNonEmptyString(config.nonInteractivePermissions, config.acpNonInteractivePermissions) ??
    DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS;
  const warmHandleIdleMs =
    config.warmHandleIdleMs ??
    config.acpWarmHandleIdleMs ??
    DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS;

  const hasEnv = config.env !== undefined;
  return {
    ...config,
    model,
    ...(hasEnv ? { env } : {}),
    // ACP reads ANTHROPIC_MODEL at startup; keep it aligned with CLI precedence.
    ...(model ? { env: { ...env, ANTHROPIC_MODEL: model } } : {}),
    agent: "claude",
    mode,
    permissionMode,
    nonInteractivePermissions,
    warmHandleIdleMs,
    ...(agentCommand ? { agentCommand } : {}),
    ...(stateDir ? { stateDir } : {}),
  };
}

/**
 * Classify ACP billing so runs land in the cost ledger with a real
 * provider/billingType instead of acpx/unknown. Host env only counts for local
 * execution targets; remote targets see just the adapter-config env.
 *
 * The ACP engine never runs on a Claude subscription: the credential gate
 * (`resolveClaudeCredentialPolicyViolation`) refuses to launch it without an
 * API credential. So an ACP run is never labelled `subscription`. The shared
 * `resolveClaudeBillingIdentity` (also used by the CLI engine) picks the
 * billing type and biller.
 */
export function resolveClaudeAcpBillingIdentity(
  ctx: Pick<AdapterExecutionContext, "config"> &
    Partial<Pick<AdapterExecutionContext, "executionTarget" | "executionTransport">>,
): { provider: string; biller: string; billingType: AdapterBillingType } {
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  return resolveClaudeBillingIdentity({
    engine: "acp",
    targetIsRemote: target?.kind === "remote",
    env: parseObject(parseObject(ctx.config).env),
  });
}

/**
 * File names under which Claude Code stores a Claude sign-in in its config dir
 * (`CLAUDE_CONFIG_DIR`, default `~/.claude`). A remote target runs only with an
 * Anthropic API key, so these files are never staged into a sandbox and never
 * synced back from one.
 */
export const CLAUDE_CONFIG_CREDENTIAL_FILE_NAMES = [".credentials.json", "credentials.json"] as const;

function workspaceRelativePath(workspaceLocalDir: string, candidate: string): string | null {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  const relative = path.relative(path.resolve(workspaceLocalDir), path.resolve(candidate));
  if (relative.length === 0) return "";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join(path.posix.sep);
}

/**
 * Workspace-relative paths of the Claude sign-in files of every Claude config
 * dir that lives inside the staged workspace: the agent's explicit
 * `CLAUDE_CONFIG_DIR`, the server's own `CLAUDE_CONFIG_DIR`, and the default
 * `~/.claude` (when the workspace contains the home directory). The remote ACP
 * lane excludes them from both the workspace upload and the teardown sync-back.
 */
export function claudeConfigCredentialWorkspaceExcludes(input: {
  workspaceLocalDir: string;
  configDirs: ReadonlyArray<string | null | undefined>;
}): string[] {
  const excludes = new Set<string>();
  for (const configDir of input.configDirs) {
    const trimmed = typeof configDir === "string" ? configDir.trim() : "";
    const relative = workspaceRelativePath(input.workspaceLocalDir, trimmed);
    if (relative === null) continue;
    for (const name of CLAUDE_CONFIG_CREDENTIAL_FILE_NAMES) {
      excludes.add(relative ? `${relative}/${name}` : name);
    }
  }
  return [...excludes];
}

/**
 * Claude remote managed-home seed for the runner-backed remote sandbox ACP lane.
 * Mirrors the Claude CLI lane (`claude-local/execute.ts`): ship a sanitized
 * config seed (settings.json + CLAUDE.md, no credentials) as the `config-seed`
 * asset, materialize it into an in-sandbox config dir, then repoint
 * `CLAUDE_CONFIG_DIR` onto that in-sandbox config dir. The run authenticates
 * with an Anthropic API key, so no Claude sign-in file is copied in and none is
 * copied back. The teardown hook therefore only syncs the sandbox workspace back
 * to the host; it does not touch credentials.
 *
 * An explicit `CLAUDE_CONFIG_DIR` (user-managed) is never forwarded to the
 * sandbox: a host-only path cannot reach it, and a path inside the staged
 * workspace would ship that directory's Claude sign-in with the workspace. Both
 * are ignored in favor of the managed config seed. The sign-in files of any
 * Claude config dir inside the workspace are excluded from the workspace upload
 * and from the sync-back. The engine's `useRemoteProcessSession` gate already
 * guarantees the remote sandbox (managed-home) target.
 */
async function prepareClaudeRemoteManagedHome(
  input: AcpxRemoteManagedHomeContext,
): Promise<AcpxRemoteManagedHomeResult> {
  const { env, runId, onLog, executionTarget } = input;
  // Fail-open workspace sync-back for every exit path (mirrors the Claude CLI
  // lane's restore-hook finally and the Codex ACP seam's teardown). Claude has no
  // credential copy-back, so the teardown only syncs the sandbox workspace back to
  // the host. A restore miss is logged and never fails the run.
  const registerWorkspaceSyncBack = (
    stagedRuntime: AcpxRemoteManagedHomeResult["stagedRuntime"],
  ): AcpxRemoteManagedHomeResult["teardown"] =>
    createWorkspaceRestoreTeardown({
      stagedRuntime,
      onLog,
      startMessage: "[paperclip] Restoring workspace changes from the sandbox.\n",
      failurePrefix: "[paperclip] Claude ACP teardown workspace restore failed",
    });
  const envConfig = parseObject(input.config.env);
  const explicitClaudeConfigDir =
    typeof envConfig.CLAUDE_CONFIG_DIR === "string" && envConfig.CLAUDE_CONFIG_DIR.trim().length > 0
      ? envConfig.CLAUDE_CONFIG_DIR.trim()
      : "";
  const workspaceExclude = claudeConfigCredentialWorkspaceExcludes({
    workspaceLocalDir: input.workspaceLocalDir,
    configDirs: [
      explicitClaudeConfigDir,
      process.env.CLAUDE_CONFIG_DIR,
      path.join(os.homedir(), ".claude"),
    ],
  });
  if (explicitClaudeConfigDir && !input.config.managedAiConnection) {
    // User-managed override. Unlike the Claude CLI lane (`claude-local/execute.ts`),
    // which runs the process on the same host and can forward the operator's
    // path verbatim, the remote ACP lane spawns Claude inside a sandbox. A
    // host-only path cannot cross into the sandbox, and a path inside the staged
    // workspace would carry that directory's Claude sign-in into the sandbox.
    // The remote lane runs only with an API key, so ignore the override either
    // way and seed the managed config instead (falling through below). Logged
    // loudly so the substitution is diagnosable.
    const insideWorkspace =
      workspaceRelativePath(input.workspaceLocalDir, explicitClaudeConfigDir) !== null;
    await onLog(
      "stderr",
      insideWorkspace
        ? `[paperclip] operator-provided CLAUDE_CONFIG_DIR=${explicitClaudeConfigDir} is inside the staged workspace; ignoring it on the remote target (its Claude sign-in files are neither staged nor synced back) and seeding the managed Claude config instead.\n`
        : `[paperclip] operator-provided CLAUDE_CONFIG_DIR=${explicitClaudeConfigDir} is outside the staged workspace and cannot reach the remote sandbox; ignoring the host-only path and seeding the managed Claude config instead.\n`,
    );
  }

  // Content-addressed sanitized seed (managed cache under the instance root, not
  // a temp dir — reused across runs, so no teardown cleanup).
  const claudeConfigSeedDir = input.config.managedAiConnection
    ? explicitClaudeConfigDir
    : await prepareClaudeConfigSeed(process.env, onLog, input.companyId);
  // Ship the per-run skill bundle, staged only when the run selected at
  // least one skill. The bundle directory holds a plain copy of each
  // selected skill's files (`materializePaperclipSkillCopy` never copies a
  // symbolic link, at the root or at any depth). So the bundle asset stages
  // with `followSymlinks: false`: staging never needs to carry a symbolic
  // link's target content, and refusing to follow one stops a link planted
  // in the bundle directory after materialization (for example by a
  // concurrent writer) from pulling an arbitrary host file into the sandbox.
  // The engine rewrites the prompt onto the in-sandbox copy once this asset
  // is staged.
  // The config seed never carries a Claude sign-in file: the managed seed holds
  // only settings.json and CLAUDE.md, and a managed AI connection's config dir
  // is staged with its sign-in files excluded.
  const stagedRuntime = await input.stage(
    [
      {
        key: "config-seed",
        localDir: claudeConfigSeedDir,
        followSymlinks: true,
        exclude: [...CLAUDE_CONFIG_CREDENTIAL_FILE_NAMES],
      },
      ...(input.skillsBundleDir
        ? [{ key: "skills", localDir: input.skillsBundleDir, followSymlinks: false }]
        : []),
    ],
    workspaceExclude.length > 0 ? { workspaceExclude } : undefined,
  );

  const remoteClaudeRuntimeRoot =
    stagedRuntime.runtimeRootDir ??
    path.posix.join(stagedRuntime.workspaceRemoteDir ?? input.workspaceLocalDir, ".paperclip-runtime", "claude");
  const remoteClaudeConfigSeedDir =
    stagedRuntime.assetDirs["config-seed"] ?? path.posix.join(remoteClaudeRuntimeRoot, "config-seed");
  const remoteClaudeConfigDir = path.posix.join(remoteClaudeRuntimeRoot, "config");

  await onLog("stdout", `[paperclip] Materializing Claude config into ${remoteClaudeConfigDir}.\n`);
  await materializeRemoteClaudeConfig({
    runId,
    target: executionTarget,
    remoteClaudeConfigDir,
    remoteClaudeConfigSeedDir,
    options: {
      cwd: stagedRuntime.workspaceRemoteDir ?? input.workspaceLocalDir,
      env,
      timeoutSec: Math.max(input.timeoutSec, 15),
      graceSec: 20,
      onLog,
    },
  });
  // Repoint CLAUDE_CONFIG_DIR onto the in-sandbox config dir.
  env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
  return { stagedRuntime, teardown: registerWorkspaceSyncBack(stagedRuntime) };
}

export function classifyClaudeTerminalSessionFailure(
  failure: AcpxTerminalSessionFailure,
  now: Date,
): AcpxTerminalFailureClassification | null {
  // `limit` also includes context, turn, rate and configured budget limits.
  // Only the provider's quota wording qualifies for a quota wait.
  if (failure.category !== "limit") return null;
  const surface = { errorMessage: [failure.title, failure.details].filter(Boolean).join("\n") };
  if (!isClaudeProviderQuotaError(surface)) return null;
  const retryNotBefore = extractClaudeRetryNotBefore(surface, now)?.toISOString();
  return {
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    ...(retryNotBefore ? { retryNotBefore } : {}),
  };
}

function withClaudeAcpDefaults(options: ClaudeAcpExecutorOptions): AcpxEngineExecutorOptions {
  return {
    resolveBillingIdentity: resolveClaudeAcpBillingIdentity,
    prepareRemoteManagedHome: prepareClaudeRemoteManagedHome,
    classifyTerminalSessionFailure: classifyClaudeTerminalSessionFailure,
    ...options,
    adapterType: "claude_local",
    moduleDir,
    packageRootDir,
  };
}

/**
 * The generic error code the shared acpx engine emits when a run fails because
 * the agent has no ready authentication. The shared engine stays vendor-neutral,
 * so it keeps this generic code. See `adapter-utils/acpx-engine/execute.ts`.
 */
const ACPX_AUTH_REQUIRED_ERROR_CODE = "acpx_auth_required";

/**
 * The Claude-specific auth-required error code the user interface reads on a
 * run. The Claude CLI lane already emits this code. See `execute.ts` and the
 * user interface gate in `ui/src/pages/AgentDetail.tsx`.
 */
const CLAUDE_AUTH_REQUIRED_ERROR_CODE = "claude_auth_required";

/**
 * Translate the generic acpx auth-required code into the Claude-specific code at
 * the claude-local boundary. The shared acpx engine reports the generic
 * `acpx_auth_required` code for every adapter. The user interface run gate reads
 * the Claude-specific `claude_auth_required` code, the same code the Claude CLI
 * lane emits. Without this translation an ACP run never reports the same
 * auth-required state as the CLI lane. The function changes only the error code
 * and keeps every other field, so the error message and the error metadata stay
 * intact.
 */
export function mapClaudeAcpAuthErrorCode(
  result: AdapterExecutionResult,
): AdapterExecutionResult {
  if (result.errorCode !== ACPX_AUTH_REQUIRED_ERROR_CODE) return result;
  return { ...result, errorCode: CLAUDE_AUTH_REQUIRED_ERROR_CODE };
}

export function createClaudeAcpExecutor(options: ClaudeAcpExecutorOptions = {}): ClaudeAcpExecutor {
  let executor: ClaudeAcpExecutor | null = null;
  return async (ctx) => {
    const target = readAdapterExecutionTarget({
      executionTarget: ctx.executionTarget,
      legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
    });
    // The ACP engine never runs on a Claude subscription. Refuse to launch it
    // without an API credential, even when a caller skips the engine resolver.
    const credentialViolation = resolveClaudeCredentialPolicyViolation({
      engine: "acp",
      config: parseObject(ctx.config),
      target,
    });
    if (credentialViolation) {
      await ctx.onLog?.("stderr", `[paperclip] ${credentialViolation}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "adapter_engine_unavailable",
        errorMessage: credentialViolation,
        resultJson: {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        },
      };
    }
    let currentExecutor = executor;
    if (!currentExecutor) {
      const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
      currentExecutor = createAcpxEngineExecutor(withClaudeAcpDefaults(options));
      executor = currentExecutor;
    }
    const result = await currentExecutor({
      ...ctx,
      config: buildClaudeAcpConfig(ctx.config, target?.kind === "remote" ? {} : process.env),
    });
    return mapClaudeAcpAuthErrorCode(result);
  };
}

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nodeVersionMeetsClaudeAcpMinimum(version = process.version): boolean {
  const [major, minor, patch] = parseVersion(version);
  const [minMajor, minMinor, minPatch] = parseVersion(MIN_ACP_NODE_VERSION);
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function looksLikeShellCommand(command: string): boolean {
  return /\s/.test(command.trim());
}

async function findCommandOnPath(binName: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) continue;
    const candidate = path.join(segment, binName);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function findAncestorBin(startDir: string, binName: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "node_modules", ".bin", binName);
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function commandIsResolvable(
  command: string,
  input?: ClaudeEngineResolutionInput,
): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (looksLikeShellCommand(trimmed)) return true;
  const target = readAdapterExecutionTarget({
    executionTarget: input?.executionTarget,
    legacyRemoteExecution: input?.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote") {
    try {
      await ensureAdapterExecutionTargetCommandResolvable(
        trimmed,
        target,
        resolveAdapterExecutionTargetCwd(target, asString(input?.config.cwd, ""), process.cwd()),
        process.env,
      );
      return true;
    } catch {
      return false;
    }
  }
  if (path.isAbsolute(trimmed) || hasPathSeparator(trimmed)) return pathExists(trimmed);
  return (await findCommandOnPath(trimmed)) !== null;
}

async function resolveClaudeAcpCommand(config: Record<string, unknown>): Promise<string> {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  return (
    (await findAncestorBin(packageRootDir, "claude-agent-acp")) ??
    (await findCommandOnPath("claude-agent-acp")) ??
    path.join(packageRootDir, "node_modules", ".bin", "claude-agent-acp")
  );
}

function sandboxTargetHasProcessSessionBridge(
  target: ReturnType<typeof readAdapterExecutionTarget>,
): boolean {
  return target?.kind === "remote" && target.transport === "sandbox" && Boolean(target.runner);
}

async function resolveClaudeAcpCommandForTarget(
  config: Record<string, unknown>,
  target: ReturnType<typeof readAdapterExecutionTarget>,
): Promise<string> {
  const configured = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (configured) return configured;
  if (target?.kind === "remote") return "claude-agent-acp";
  return resolveClaudeAcpCommand(config);
}

async function claudeAcpUnavailableReason(
  input: ClaudeEngineResolutionInput,
): Promise<string | null> {
  const target = readAdapterExecutionTarget({
    executionTarget: input.executionTarget,
    legacyRemoteExecution: input.executionTransport?.remoteExecution,
  });
  if (target?.kind === "remote" && !sandboxTargetHasProcessSessionBridge(target)) {
    if (target.transport === "sandbox") {
      return "Claude ACP requires a bidirectional remote process target; this sandbox exposes only one-shot command execution.";
    }
    return "Claude ACP supports sandbox remote targets only; this run targets a non-sandbox remote environment.";
  }
  if (!nodeVersionMeetsClaudeAcpMinimum()) {
    return `Node ${process.version} (${process.execPath}) does not satisfy Claude ACP's Node >=${MIN_ACP_NODE_VERSION} prerequisite.`;
  }
  const command = await resolveClaudeAcpCommandForTarget(input.config, target);
  if (!(await commandIsResolvable(command, input))) {
    return `Claude ACP server command is not available: ${command}.`;
  }
  return null;
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function testClaudeAcpEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";

  checks.push({
    code: "claude_engine_selected",
    level: "info",
    message: "Execution engine selected: ACP.",
    hint: "Set engine=cli to use the existing Claude Code CLI lane.",
  });

  // The ACP engine never runs on a Claude subscription. The engine resolver
  // already fails the Test before this point; keep the gate here for direct callers.
  const credentialViolation = resolveClaudeCredentialPolicyViolation({ engine: "acp", config, target });
  if (credentialViolation) {
    checks.push({
      code: "claude_acp_api_key_required",
      level: "error",
      message: credentialViolation,
      hint: "Add ANTHROPIC_API_KEY to this agent's environment as a secret, or set engine=cli.",
    });
  }

  // Always name the target the Test probed, so a pass result never hides which
  // target it checked. A local probe reports the fixed host label.
  checks.push(
    buildAdapterTestTargetCheck({ targetIsRemote, environmentName: ctx.environmentName }),
  );

  if (targetIsRemote) {
    checks.push({
      code: "claude_acp_remote_target",
      level: "info",
      message: "Claude ACP will run against the remote execution environment.",
      hint: "Remote ACP requires a bidirectional process target such as SSH or Paperclip's sandbox process-session bridge.",
    });
  }

  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  try {
    await ensureAdapterExecutionTargetDirectory(`claude-acp-envtest-${Date.now()}`, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "claude_acp_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_acp_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  checks.push({
    code: nodeVersionMeetsClaudeAcpMinimum() ? "claude_acp_node_supported" : "claude_acp_node_unsupported",
    level: nodeVersionMeetsClaudeAcpMinimum() ? "info" : "error",
    message: nodeVersionMeetsClaudeAcpMinimum()
      ? `Node ${process.version} satisfies Claude ACP runtime requirements.`
      : `Node ${process.version} (${process.execPath}) does not satisfy Claude ACP runtime requirements.`,
    hint: nodeVersionMeetsClaudeAcpMinimum()
      ? undefined
      : `Run Claude ACP with Node >=${MIN_ACP_NODE_VERSION} or switch engine=cli.`,
  });

  const command = await resolveClaudeAcpCommandForTarget(config, target);
  const commandResolvable = await commandIsResolvable(command, {
    config,
    executionTarget: ctx.executionTarget,
  });
  checks.push({
    code: commandResolvable ? "claude_acp_command_resolvable" : "claude_acp_command_missing",
    level: commandResolvable ? "info" : "error",
    message: commandResolvable
      ? `Claude ACP server command is executable: ${command}`
      : `Claude ACP server command is not available: ${command}`,
    hint: commandResolvable
      ? undefined
      : "Install dependencies so @agentclientprotocol/claude-agent-acp is present, or set agentCommand to a valid Claude ACP server command.",
  });

  // A Claude subscription token is never forwarded into the ACP lane.
  const envConfig = withoutClaudeSubscriptionTokens(parseObject(config.env));
  const considerHostEnv = !targetIsRemote && !config.managedAiConnection;
  const hasBedrock =
    envConfig.CLAUDE_CODE_USE_BEDROCK === "1" ||
    envConfig.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "1") ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "true") ||
    isNonEmpty(envConfig.ANTHROPIC_BEDROCK_BASE_URL) ||
    (considerHostEnv && isNonEmpty(process.env.ANTHROPIC_BEDROCK_BASE_URL));
  const configApiKey = envConfig.ANTHROPIC_API_KEY;
  const hostApiKey = considerHostEnv ? process.env.ANTHROPIC_API_KEY : undefined;
  if (hasBedrock) {
    checks.push({
      code: "claude_acp_bedrock_auth",
      level: "info",
      message: "AWS Bedrock auth detected. Claude ACP will use Bedrock for inference.",
      hint: "Ensure AWS credentials and AWS_REGION are configured in this environment.",
    });
  } else if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    const selectedApiKey = Boolean(config.managedAiConnection) || isNonEmpty(configApiKey);
    // The ACP engine always uses API-key auth; it never runs on a subscription.
    checks.push({
      code: "claude_acp_anthropic_api_key_detected",
      level: "info",
      message: selectedApiKey ? "Using the selected Claude API connection." : "ANTHROPIC_API_KEY is set. Claude ACP will use API-key auth.",
      detail: `Detected in ${source}.`,
      hint: undefined,
    });
  }

  const mode = firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE;
  const warmHandleIdleMs = asNumber(
    config.warmHandleIdleMs ?? config.acpWarmHandleIdleMs,
    DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
  );
  checks.push({
    code: "claude_acp_runtime_scaffold",
    level: "info",
    message: "Claude ACP runtime execution is available through the shared ACP engine.",
    detail: `mode=${mode}; warmHandleIdleMs=${warmHandleIdleMs}`,
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
