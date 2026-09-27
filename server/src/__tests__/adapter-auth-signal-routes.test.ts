import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cheap host-local authentication-signal route. It reads no sandbox and
// runs no model process; for claude_local it asks the local `claude` binary for
// its own sign-in status (`claude auth status`), which the test mocks. Every test
// drives the route through a plain in-process Express app with fake services --
// no database, no sandbox provider, and no adapter execution.

const COMPANY_1 = "company-1";
const OTHER_COMPANY = "company-2";
const OWNER_A = "user-a";
const ENVIRONMENT_1 = "11111111-1111-4111-8111-111111111111";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(async () => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(async () => null),
  listPrincipalGrants: vi.fn(async () => []),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  collectMissingRuntimeBindings: vi.fn(async () => [] as Array<Record<string, unknown>>),
  resolveEnvBindings: vi.fn(async () => ({
    env: {} as Record<string, string>,
    secretKeys: new Set<string>(),
    manifest: [],
  })),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  releaseLease: vi.fn(),
  listBoundCompanyIds: vi.fn(async () => [] as string[]),
}));

const mockEnvironmentRuntime = vi.hoisted(() => ({
  acquireRunLease: vi.fn(),
  realizeWorkspace: vi.fn(),
  getDriver: vi.fn(() => ({ releaseRunLease: vi.fn(async () => undefined) })),
}));

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn());
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  getExperimental: vi.fn(async () => ({ enableManagedSandboxOnly: false })),
}));

// The one host-local Codex readiness predictor the route calls. The test
// controls its resolved value and its failure, so it stays independent of a
// real Codex home on disk.
const mockEvaluateCodexCredentialReadiness = vi.hoisted(() => vi.fn());

// The `claude auth status` reader. The route calls it for claude_local on this
// server (no environment or a local-driver environment). The test controls its
// resolved value, so no real `claude` binary runs.
type ClaudeAuthStatusResult = {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
} | null;
const mockReadClaudeAuthStatus = vi.hoisted(() => vi.fn(async (): Promise<ClaudeAuthStatusResult> => null));
// The route calls `probeClaudeCliAuth`, which also says whether the binary is
// missing. By default it wraps the status mock above with the binary present.
const mockProbeClaudeCliAuth = vi.hoisted(() =>
  vi.fn(async (): Promise<{ status: ClaudeAuthStatusResult; binaryMissing: boolean }> => ({
    status: await mockReadClaudeAuthStatus(),
    binaryMissing: false,
  })),
);

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
    resolveRequestedSkillKeys: vi.fn(async () => []),
  }),
  budgetService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(),
    cancelActiveForAgent: vi.fn(),
  }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntime,
}));

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: mockResolveEnvironmentExecutionTarget,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

const mockResolveClaudeSubscriptionEligibility = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, unknown>> => ({ allowed: true })),
);
vi.mock("../services/claude-subscription-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/claude-subscription-policy.js")>()),
  resolveClaudeSubscriptionEligibility: mockResolveClaudeSubscriptionEligibility,
}));

vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>();
  return {
    ...actual,
    readClaudeAuthStatus: mockReadClaudeAuthStatus,
    probeClaudeCliAuth: mockProbeClaudeCliAuth,
  };
});

vi.mock("@paperclipai/adapter-codex-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-codex-local/server")>();
  return {
    ...actual,
    evaluateCodexCredentialReadiness: mockEvaluateCodexCredentialReadiness,
  };
});

let currentActor: Record<string, unknown>;

function boardActor(userId: string, companyIds: string[] = [COMPANY_1, OTHER_COMPANY]): Record<string, unknown> {
  return {
    type: "board",
    userId,
    companyIds,
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = currentActor;
    next();
  });
  app.use("/api", agentRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const authSignalPath = (companyId: string, type: string, environmentId?: string) =>
  `/api/companies/${companyId}/adapters/${type}/auth-signal${environmentId ? `?environmentId=${environmentId}` : ""}`;

describe("adapter auth-signal route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    currentActor = boardActor(OWNER_A);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: ENVIRONMENT_1,
      companyId: COMPANY_1,
      name: "Sandbox QA",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake-plugin" },
      envVars: {},
    });
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValue([]);
    mockSecretService.resolveEnvBindings.mockResolvedValue({
      env: {},
      secretKeys: new Set<string>(),
      manifest: [],
    });
    mockReadClaudeAuthStatus.mockResolvedValue(null);
    mockEvaluateCodexCredentialReadiness.mockResolvedValue({
      managed: true,
      authMode: "subscription",
      ready: false,
      effectiveHome: "/tmp/codex-home",
      sharedSourceHome: "/tmp/codex-shared-home",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns present for codex_local when the readiness predictor reports ready", async () => {
    mockEvaluateCodexCredentialReadiness.mockResolvedValueOnce({
      managed: true,
      authMode: "subscription",
      ready: true,
      effectiveHome: "/tmp/codex-home",
      sharedSourceHome: "/tmp/codex-shared-home",
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "codex_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "present" });
    expect(mockEvaluateCodexCredentialReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_1 }),
    );
  });

  it("returns absent for codex_local when the readiness predictor reports not ready", async () => {
    mockEvaluateCodexCredentialReadiness.mockResolvedValueOnce({
      managed: true,
      authMode: "subscription",
      ready: false,
      effectiveHome: "/tmp/codex-home",
      sharedSourceHome: "/tmp/codex-shared-home",
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "codex_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "absent" });
  });

  it("returns unknown for codex_local when the readiness predictor throws", async () => {
    mockEvaluateCodexCredentialReadiness.mockRejectedValueOnce(new Error("boom"));
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "codex_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "unknown" });
  });

  it("returns unknown for codex_local on a sandbox environment even when the host reports ready", async () => {
    // The host readiness predictor is ready, but the selected sandbox holds no
    // credential of its own. The route must not let the unrelated host login
    // hide the sandbox's own sign-in panel.
    mockEvaluateCodexCredentialReadiness.mockResolvedValueOnce({
      managed: true,
      authMode: "subscription",
      ready: true,
      effectiveHome: "/tmp/codex-home",
      sharedSourceHome: "/tmp/codex-shared-home",
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "codex_local", ENVIRONMENT_1));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "unknown" });
    expect(mockEvaluateCodexCredentialReadiness).not.toHaveBeenCalled();
  });

  it("returns present for codex_local on a sandbox environment that holds its own API key", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: ENVIRONMENT_1,
      companyId: COMPANY_1,
      name: "Sandbox QA",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake-plugin" },
      envVars: {
        OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" },
      },
    });
    mockSecretService.resolveEnvBindings.mockResolvedValueOnce({
      env: { OPENAI_API_KEY: "resolved-key" },
      secretKeys: new Set(["OPENAI_API_KEY"]),
      manifest: [],
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "codex_local", ENVIRONMENT_1));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "present" });
    expect(mockEvaluateCodexCredentialReadiness).not.toHaveBeenCalled();
  });

  it("uses the host readiness predictor for codex_local on a local-driver environment", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: ENVIRONMENT_1,
      companyId: COMPANY_1,
      name: "Local host",
      driver: "local",
      status: "active",
      config: {},
      envVars: {},
    });
    mockEvaluateCodexCredentialReadiness.mockResolvedValueOnce({
      managed: true,
      authMode: "subscription",
      ready: true,
      effectiveHome: "/tmp/codex-home",
      sharedSourceHome: "/tmp/codex-shared-home",
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "codex_local", ENVIRONMENT_1));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "present" });
    expect(mockEvaluateCodexCredentialReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_1 }),
    );
  });

  it("returns present for claude_local when the local claude CLI reports it is signed in", async () => {
    mockReadClaudeAuthStatus.mockResolvedValueOnce({
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "max",
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "present" });
    expect(mockReadClaudeAuthStatus).toHaveBeenCalledOnce();
    // The route reads no stored credential and resolves no secret for the host.
    expect(mockSecretService.resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("reports subscription_not_allowed for claude_local on an instance with other users, without probing", async () => {
    mockResolveClaudeSubscriptionEligibility.mockResolvedValueOnce({
      allowed: false,
      reason: "subscription_not_allowed",
      message: "owner only",
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "absent", reason: "subscription_not_allowed" });
    expect(mockProbeClaudeCliAuth).not.toHaveBeenCalled();
  });

  it("returns absent for claude_local when the local claude CLI reports it is not signed in", async () => {
    mockReadClaudeAuthStatus.mockResolvedValueOnce({
      loggedIn: false,
      authMethod: null,
      subscriptionType: null,
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "absent" });
  });

  it("returns unknown for claude_local when the claude binary is missing or its output is unreadable", async () => {
    mockReadClaudeAuthStatus.mockResolvedValueOnce(null);
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "unknown" });
  });

  it("returns unknown with reason cli_missing for claude_local when the claude binary is not installed", async () => {
    mockProbeClaudeCliAuth.mockResolvedValueOnce({ status: null, binaryMissing: true });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "unknown", reason: "cli_missing" });
  });

  it("returns unknown for claude_local when the claude CLI status read throws", async () => {
    mockReadClaudeAuthStatus.mockRejectedValueOnce(new Error("boom"));
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "unknown" });
  });

  it("uses the local claude CLI status for claude_local on a local-driver environment", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: ENVIRONMENT_1,
      companyId: COMPANY_1,
      name: "Local host",
      driver: "local",
      status: "active",
      config: {},
      envVars: {},
    });
    mockReadClaudeAuthStatus.mockResolvedValueOnce({
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: null,
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local", ENVIRONMENT_1));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "present" });
    expect(mockReadClaudeAuthStatus).toHaveBeenCalledOnce();
  });

  it("returns present for claude_local on a sandbox environment that holds its own Anthropic API key", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: ENVIRONMENT_1,
      companyId: COMPANY_1,
      name: "Sandbox QA",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake-plugin" },
      envVars: {
        ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "secret-1" },
      },
    });
    mockSecretService.resolveEnvBindings.mockResolvedValueOnce({
      env: { ANTHROPIC_API_KEY: "resolved-key" },
      secretKeys: new Set(["ANTHROPIC_API_KEY"]),
      manifest: [],
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local", ENVIRONMENT_1));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "present" });
    expect(mockSecretService.resolveEnvBindings).toHaveBeenCalledWith(
      COMPANY_1,
      { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
      expect.anything(),
    );
    // A remote environment cannot use this server's claude sign-in.
    expect(mockReadClaudeAuthStatus).not.toHaveBeenCalled();
  });

  it("returns unknown for claude_local on a sandbox environment with no Anthropic API key, even when this server's claude CLI is signed in", async () => {
    mockReadClaudeAuthStatus.mockResolvedValue({
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "max",
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local", ENVIRONMENT_1));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "unknown" });
    expect(mockReadClaudeAuthStatus).not.toHaveBeenCalled();
  });

  it("returns unknown for claude_local on a sandbox environment whose Anthropic API key resolves empty", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: ENVIRONMENT_1,
      companyId: COMPANY_1,
      name: "Sandbox QA",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake-plugin" },
      envVars: {
        ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "secret-1" },
      },
    });
    mockSecretService.resolveEnvBindings.mockResolvedValueOnce({
      env: { ANTHROPIC_API_KEY: "" },
      secretKeys: new Set(["ANTHROPIC_API_KEY"]),
      manifest: [],
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local", ENVIRONMENT_1));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "unknown" });
  });

  it("returns unknown for an adapter type that has no cheap signal", async () => {
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "cursor_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "unknown" });
    expect(mockEvaluateCodexCredentialReadiness).not.toHaveBeenCalled();
    expect(mockReadClaudeAuthStatus).not.toHaveBeenCalled();
  });

  it("rejects an environment that belongs to another company", async () => {
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValueOnce([OTHER_COMPANY]);
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local", ENVIRONMENT_1));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockSecretService.resolveEnvBindings).not.toHaveBeenCalled();
    expect(mockReadClaudeAuthStatus).not.toHaveBeenCalled();
  });

  it("rejects a caller who cannot create agents for the company", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      reason: "deny_no_grant",
      explanation: "Not allowed by any grant",
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "claude_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockEnvironmentService.getById).not.toHaveBeenCalled();
    expect(mockReadClaudeAuthStatus).not.toHaveBeenCalled();
  });

  it("returns a response body that holds only the status field", async () => {
    mockEvaluateCodexCredentialReadiness.mockResolvedValueOnce({
      managed: true,
      authMode: "subscription",
      ready: true,
      effectiveHome: "/tmp/codex-home",
      sharedSourceHome: "/tmp/codex-shared-home",
    });
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "codex_local"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body)).toEqual(["status"]);
  });

  it("takes no sandbox lease and starts no model process", async () => {
    const app = await createApp();

    const res = await request(app).get(authSignalPath(COMPANY_1, "codex_local", ENVIRONMENT_1));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockEnvironmentRuntime.acquireRunLease).not.toHaveBeenCalled();
    expect(mockResolveEnvironmentExecutionTarget).not.toHaveBeenCalled();
  });
});
