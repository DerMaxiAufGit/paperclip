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
