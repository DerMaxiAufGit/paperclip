import type { Environment } from "@paperclipai/shared";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

/**
 * The argument object that the runtime `acquireRunLease` seam accepts. The type
 * derives from the service method, so a change to the acquire input stays in
 * sync with this helper.
 */
export type AcquireLoginLeaseArgs = Parameters<EnvironmentRuntimeService["acquireRunLease"]>[0];

/**
 * The lease metadata that identifies the login sandbox. The helper copies these
 * fields to the acquire arguments without a change.
 */
export interface LoginLeaseMetadata {
  companyId: string;
  environment: Environment;
  /** The agent adapter type for this login (mixed-harness environments). */
  adapterType?: string | null;
}

/**
 * The options for one login lease acquire. The helper sets the fixed arguments
 * and passes the lease metadata through to the acquire arguments.
 */
export interface BuildLoginLeaseAcquireArgsOptions {
  /** The lease metadata that identifies the login sandbox. */
  metadata: LoginLeaseMetadata;
}

/**
 * Build the fixed sandbox lease arguments for the device login service. The
 * login acquires a lease with no agent, a null issue, a null heartbeat run, and
 * a null execution workspace, and applies the active custom-image template.
 * This helper sets those fixed arguments in one place.
 */
export function buildLoginLeaseAcquireArgs(
  options: BuildLoginLeaseAcquireArgsOptions,
): AcquireLoginLeaseArgs {
  return {
    companyId: options.metadata.companyId,
    environment: options.metadata.environment,
    adapterType: options.metadata.adapterType ?? null,
    // A company-and-environment scoped login carries no target agent.
    agentId: null,
    // A null issue, a null heartbeat run, and a null execution workspace disable
    // lease reuse, so the login session always runs in a fresh sandbox.
    issueId: null,
    heartbeatRunId: null,
    persistedExecutionWorkspace: null,
    // Apply the active custom-image template, so the sandbox binds to the
    // trusted image and runtime identity.
    applyCustomImageTemplate: true,
  };
}
