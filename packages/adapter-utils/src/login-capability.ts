// The adapter login capability. An adapter declares this optional capability to
// describe how the server drives an interactive device login (for example the
// Codex or Grok device-auth flow) in a sandbox. The module holds the capability
// types, the fixed value sets, and one runtime validator. The validator fails
// closed: it rejects a malformed capability shape with a clear error, so the
// loader never accepts a partial capability.
//
// Security (secret handling): the capability holds no secret and never reads
// one. The scalar fields carry only a fixed, non-secret value. The device-login
// flow writes its credential inside the sandbox, so Paperclip never captures a
// credential from the login terminal. API-key-only vendors declare no login
// capability.

/**
 * The login panel mode. `displayed_code` shows a one-time code that the user
 * enters in the browser.
 */
export const ADAPTER_LOGIN_PANEL_MODES = ["displayed_code"] as const;
export type AdapterLoginPanelMode = (typeof ADAPTER_LOGIN_PANEL_MODES)[number];

/**
 * The host-side timeout policy. `caller_bounded` lets the caller set the
 * timeout. `fixed` binds the timeout to a fixed adapter value.
 */
export const ADAPTER_LOGIN_TIMEOUT_POLICIES = ["caller_bounded", "fixed"] as const;
export type AdapterLoginTimeoutPolicy = (typeof ADAPTER_LOGIN_TIMEOUT_POLICIES)[number];

/**
 * The normalized login prompt. `url` is the validated authorization URL. `code`
 * is the one-time code to show once the login output holds it. A prompt carries
 * no credential secret.
 */
export interface AdapterLoginPrompt {
  url: string;
  code?: string;
}

/**
 * The optional adapter login capability. It declares how the server drives an
 * interactive device login in a sandbox for the adapter. The capability holds
 * no secret. An adapter with no interactive login (for example an API-key-only
 * vendor) declares no capability.
 */
export interface AdapterLoginCapability {
  /** The login panel mode. */
  panelMode: AdapterLoginPanelMode;
  /** The host-side timeout policy. */
  timeoutPolicy: AdapterLoginTimeoutPolicy;
  /** Returns the fixed, non-secret login command. */
  getCommand: () => string;
  /**
   * Parses the authorization prompt from the login output. Returns null when the
   * output holds no prompt yet. The parser keeps every input byte out of its
   * result and out of every thrown error.
   */
  parsePrompt: (output: string) => AdapterLoginPrompt | null;
}

function isOneOf<T extends readonly string[]>(values: T, candidate: unknown): candidate is T[number] {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate);
}

/**
 * Validates one login capability. The function fails closed: it throws a clear
 * error for a malformed shape. It checks each scalar field against its fixed
 * value set and checks each required function member. `adapterType` names the
 * adapter in the error text.
 */
export function assertValidAdapterLoginCapability(
  value: unknown,
  adapterType: string,
): asserts value is AdapterLoginCapability {
  const prefix = `Adapter "${adapterType}" declares an invalid login capability`;
  if (typeof value !== "object" || value === null) {
    throw new Error(`${prefix}: the capability must be an object.`);
  }
  const cap = value as Record<string, unknown>;

  if (!isOneOf(ADAPTER_LOGIN_PANEL_MODES, cap.panelMode)) {
    throw new Error(
      `${prefix}: "panelMode" must be one of ${ADAPTER_LOGIN_PANEL_MODES.join(", ")}.`,
    );
  }
  if (!isOneOf(ADAPTER_LOGIN_TIMEOUT_POLICIES, cap.timeoutPolicy)) {
    throw new Error(
      `${prefix}: "timeoutPolicy" must be one of ${ADAPTER_LOGIN_TIMEOUT_POLICIES.join(", ")}.`,
    );
  }
  if (typeof cap.getCommand !== "function") {
    throw new Error(`${prefix}: "getCommand" must be a function.`);
  }
  if (typeof cap.parsePrompt !== "function") {
    throw new Error(`${prefix}: "parsePrompt" must be a function.`);
  }
}

/**
 * Validates the optional login capability of an adapter module. The function is
 * a no-op when the module declares no login capability. It throws a clear error
 * when the module declares a malformed capability, so the loader fails closed.
 */
export function validateAdapterLoginCapability(mod: {
  type?: unknown;
  loginCapability?: unknown;
}): void {
  if (mod.loginCapability === undefined) return;
  const adapterType = typeof mod.type === "string" && mod.type.length > 0 ? mod.type : "unknown";
  assertValidAdapterLoginCapability(mod.loginCapability, adapterType);
}
