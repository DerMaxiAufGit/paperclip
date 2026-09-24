import { describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";
import { buildLoginLeaseAcquireArgs } from "./adapter-login-lease.js";

// A minimal environment stand-in. The helper copies the reference without a
// read, so the test does not need a full environment row.
const ENVIRONMENT = { id: "env-1", name: "Sandbox", driver: "sandbox" } as unknown as Environment;

describe("buildLoginLeaseAcquireArgs", () => {
  it("sets the fixed lease arguments of the login service", () => {
    const args = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT, adapterType: "codex_local" },
    });

    // A null issue, a null heartbeat run, and a null execution workspace disable
    // lease reuse, so the login session always runs in a fresh sandbox.
    expect(args.issueId).toBeNull();
    expect(args.heartbeatRunId).toBeNull();
    expect(args.persistedExecutionWorkspace).toBeNull();
    // The helper applies the active custom-image template.
    expect(args.applyCustomImageTemplate).toBe(true);
  });

  it("passes the lease metadata through to the acquire arguments", () => {
    const args = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT, adapterType: "grok_local" },
    });

    expect(args.companyId).toBe("co-1");
    expect(args.environment).toBe(ENVIRONMENT);
    expect(args.adapterType).toBe("grok_local");
  });

  it("defaults the adapter type to null when the caller omits it", () => {
    const args = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT },
    });

    expect(args.adapterType).toBeNull();
  });

  it("binds no agent to the login lease", () => {
    const args = buildLoginLeaseAcquireArgs({
      metadata: { companyId: "co-1", environment: ENVIRONMENT },
    });
    expect(args.agentId).toBeNull();
  });
});
