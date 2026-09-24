// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderConnection } from "./AgentProviderConnection";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  personal: vi.fn(),
  organization: vi.fn(),
  loginPanel: vi.fn(),
}));
const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
  loginResult: vi.fn(async () => ({ connectionId: "login-account", grantId: "login-grant" })),
  connectLocal: vi.fn(async () => ({ connectionId: "local-account", grantId: "local-grant" })),
  startLocalLogin: vi.fn(async () => ({ sessionId: "local-attempt", command: "CODEX_HOME='/fixture/isolated-login' codex login", expiresAt: "2026-09-11T20:00:00Z" })),
  checkLocalLogin: vi.fn(async (): Promise<{ status: "ready" | "sign_in_required" | "expired" }> => ({ status: "sign_in_required" })),
  cancelLocalLogin: vi.fn(async () => ({})),
  create: vi.fn(async () => ({ connectionId: "managed-connection", grantId: "managed-grant" })),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
vi.mock("@/api/agents", () => ({
  agentsApi: {
    getAdapterAuthSignal: mocks.auth,
  },
}));
vi.mock("@/api/secrets", () => ({
  secretsApi: { listMyUserSecrets: mocks.personal, list: mocks.organization },
}));
vi.mock("../AgentConfigForm", () => ({
  AdapterLoginPanel: (props: unknown) => { mocks.loginPanel(props); return <div>New subscription login</div>; },
}));
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
afterEach(() => {
  flushSync(() => root?.unmount());
  host?.remove();
  client?.clear();
  vi.resetAllMocks();
});
type MountOptions = {
  canLogin?: boolean;
  codexSubscriptions?: boolean;
  savedApiKeys?: boolean;
  managedAccount?: Parameters<typeof AgentProviderConnection>[0]["managedAccount"];
  localEnvironment?: boolean;
  deploymentMode?: "local_trusted" | "authenticated";
  localAiLoginSupported?: boolean;
  authStatus?: "present" | "absent" | "unknown";
  environmentId?: string | null;
  apiKeyOnly?: boolean;
};
async function mount(
  adapterType: "claude_local" | "codex_local" = "claude_local",
  {
    canLogin = true,
    codexSubscriptions = false,
    savedApiKeys = true,
    managedAccount,
    localEnvironment = false,
    deploymentMode = "local_trusted",
    localAiLoginSupported = true,
    authStatus,
    environmentId = "e1",
    apiKeyOnly = false,
  }: MountOptions = {},
) {
  const key =
    adapterType === "claude_local" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  mocks.auth.mockResolvedValue({
    status: authStatus ?? (codexSubscriptions ? "unknown" : "present"),
  });
  mocks.personal.mockResolvedValue([
    {
      definition: {
        id: "d1",
        companyId: "c1",
        key: `${key}.setup.1`,
        name: "Personal key",
        status: "active",
      },
      secret: { companyId: "c1", status: "active" },
    },
  ]);
  mocks.organization.mockResolvedValue([
    {
      id: "s1",
      companyId: "c1",
      key,
      name: "Company key",
      scope: "company",
      status: "active",
    },
    ...(codexSubscriptions
      ? [
          {
            id: "codex-home",
            companyId: "c1",
            name: "CODEX_HOME_team",
            scope: "company",
            status: "active",
          },
        ]
      : []),
  ]);
  if (!savedApiKeys) {
    mocks.personal.mockResolvedValue([]);
    mocks.organization.mockResolvedValue([]);
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["health"], { deploymentMode, localAiLoginSupported });
  client.setQueryDefaults(["health"], { staleTime: Infinity });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const test = vi.fn().mockResolvedValue(true);
  const connected = vi.fn();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AgentProviderConnection
          companyId="c1"
          adapterType={adapterType}
          environmentId={environmentId}
          canLogin={canLogin}
          localEnvironment={localEnvironment}
          apiKeyOnly={apiKeyOnly}
          onBack={() => {}}
          testConnection={test}
          onConnected={connected}
          managedAccount={managedAccount}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(mocks.personal).toHaveBeenCalled());
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  if (savedApiKeys && !managedAccount) await vi.waitFor(() => expect(host.textContent).toContain("2 saved API keys"));
  return { test, connected, key };
}
function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  )!;
  expect(button).toBeTruthy();
  flushSync(() => button.click());
}
function openProvider() {
  flushSync(() =>
    (host.querySelector('[role="radio"]') as HTMLElement).click(),
  );
}
const codexIntent = (name: string, overrides: Partial<{ ownership: "personal" | "shared"; agentIds: string[] }> = {}) => ({
  provider: "openai" as const,
  method: "subscription" as const,
  name,
  ownership: "personal" as const,
  agentIds: [] as string[],
  allAgents: false,
  ...overrides,
});
describe("AgentProviderConnection reuse", () => {
  it("does not offer a server-host command when health disables local login", async () => {
    const onComplete = vi.fn();
    const intent = codexIntent("Hosted account");
    await mount("codex_local", { canLogin: false, savedApiKeys: false, managedAccount: { intent, onComplete }, localEnvironment: true, deploymentMode: "authenticated", localAiLoginSupported: false });
    openProvider();
    expect(host.textContent).toContain("This environment does not support browser sign-in");
    expect(host.textContent).not.toContain("Run this in a terminal");
    expect(managedApi.startLocalLogin).not.toHaveBeenCalled();
    click("Connect");
    expect(managedApi.connectLocal).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("prepares and completes an isolated subscription on an authenticated self-hosted instance", async () => {
    const onComplete = vi.fn();
    const command = "CODEX_HOME='/isolated/codex' codex login --device-auth";
    managedApi.startLocalLogin.mockResolvedValue({ sessionId: "local-attempt", command, expiresAt: "2099-01-01T00:00:00Z" });
    managedApi.checkLocalLogin.mockResolvedValue({ status: "sign_in_required" });
    managedApi.connectLocal.mockResolvedValue({ connectionId: "local-account", grantId: "local-grant" });
    const intent = codexIntent("Self-hosted account");
    await mount("codex_local", { canLogin: false, savedApiKeys: false, managedAccount: { intent, onComplete }, localEnvironment: true, deploymentMode: "authenticated" });
    openProvider();
    await vi.waitFor(() => expect(host.textContent).toContain(command));
    expect(host.textContent).toContain("Your existing terminal login stays separate");
    expect(managedApi.startLocalLogin).toHaveBeenCalledWith("c1", intent);
    expect(managedApi.checkLocalLogin).toHaveBeenCalledWith("c1", { ...intent, localSessionId: "local-attempt" });
    click("Connect");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(managedApi.connectLocal).toHaveBeenCalledWith("c1", { ...intent, localSessionId: "local-attempt" });
  });
  it("connects a local subscription without a sandbox and supports retry", async () => {
    const onComplete = vi.fn();
    managedApi.startLocalLogin.mockResolvedValue({ sessionId: "local-attempt", command: "CODEX_HOME='/fixture/isolated-login' codex login", expiresAt: "2099-01-01T00:00:00Z" });
    managedApi.checkLocalLogin.mockResolvedValue({ status: "sign_in_required" });
    managedApi.cancelLocalLogin.mockResolvedValue({});
    const intent = codexIntent("My account");
    await mount("codex_local", { canLogin: false, savedApiKeys: false, managedAccount: { intent, onComplete }, localEnvironment: true });
    openProvider();
    await vi.waitFor(() => expect(host.textContent).toContain("codex login"));
    expect(host.textContent).toContain("machine running Paperclip");
    expect(host.textContent).not.toContain("sandbox");
    managedApi.connectLocal.mockRejectedValueOnce(new Error("Run local login and try again"));
    click("Connect");
    await vi.waitFor(() => expect(host.textContent).toContain("Run local login and try again"));
    expect(onComplete).not.toHaveBeenCalled();
    click("Start sign-in again");
    await vi.waitFor(() => expect(host.textContent).not.toContain("Run local login and try again"));
    await vi.waitFor(() => expect(managedApi.cancelLocalLogin).toHaveBeenCalledWith("c1", "local-attempt"));
    await vi.waitFor(() => expect(host.textContent).toContain("codex login"));
    managedApi.connectLocal.mockResolvedValue({ connectionId: "local-account", grantId: "local-grant" });
    click("Connect");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ connectionId: "local-account", grantId: "local-grant", method: "subscription" }));
    expect(managedApi.connectLocal).toHaveBeenCalledWith("c1", { ...intent, localSessionId: "local-attempt" });
    expect(mocks.loginPanel).not.toHaveBeenCalled();
  });
  it("leaves a completed local account saved when its host is cancelled", async () => {
    let finish!: (result: { connectionId: string; grantId: string }) => void;
    managedApi.startLocalLogin.mockResolvedValue({ sessionId: "local-attempt", command: "codex login", expiresAt: "2099-01-01T00:00:00Z" });
    managedApi.checkLocalLogin.mockResolvedValue({ status: "ready" });
    managedApi.connectLocal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const onComplete = vi.fn();
    await mount("codex_local", { canLogin: false, savedApiKeys: false, managedAccount: { intent: codexIntent("My account"), onComplete }, localEnvironment: true });
    openProvider();
    await vi.waitFor(() => expect(host.textContent).toContain("is signed in"));
    click("Connect");
    await vi.waitFor(() => expect(managedApi.connectLocal).toHaveBeenCalled());
    flushSync(() => root.unmount());
    finish({ connectionId: "saved", grantId: "saved-grant" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("does not import local credentials for an unsupported remote environment", async () => {
    const onComplete = vi.fn();
    const intent = codexIntent("Engineering subscription", { ownership: "shared", agentIds: ["nova"] });
    const { test } = await mount("codex_local", { canLogin: false, managedAccount: { intent, onComplete } });
    openProvider();
    expect(host.textContent).toContain("This environment does not support browser sign-in");
    expect(host.textContent).not.toContain("login on this machine");
    click("Connect");
    expect(onComplete).not.toHaveBeenCalled();
    expect(managedApi.create).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
  });

  it("drives onboarding's provider redirect and completion", async () => {
    const onComplete = vi.fn();
    managedApi.loginResult.mockResolvedValue({ connectionId: "login-account", grantId: "login-grant" });
    const intent = codexIntent("My account");
    await mount("codex_local", { savedApiKeys: false, managedAccount: { intent, onComplete } });
    openProvider();
    const panel = () => mocks.loginPanel.mock.calls.at(-1)![0];
    expect(panel().chrome).toBe("onboarding");
    expect(panel().autoStart).toBe(true);
    expect(panel().aiConnection).toEqual(intent);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      flushSync(() => panel().onPromptReady("https://provider.example/authorize"));
      click("Sign in to OpenAI");
      expect(open).toHaveBeenCalledWith("https://provider.example/authorize", "_blank", "noreferrer,noopener");
      expect(host.textContent).toContain("Waiting for code");
      flushSync(() => panel().onConnected("session-1"));
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ connectionId: "login-account", grantId: "login-grant", method: "subscription" }));
      expect(managedApi.loginResult).toHaveBeenCalledWith("c1", "session-1");
    } finally { open.mockRestore(); }
  });

  it("does not advance after Back while the saved login result is loading", async () => {
    let finish!: (result: { connectionId: string; grantId: string }) => void;
    managedApi.loginResult.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const onComplete = vi.fn();
    await mount("codex_local", { savedApiKeys: false, managedAccount: { intent: codexIntent("My account"), onComplete } });
    openProvider();
    flushSync(() => mocks.loginPanel.mock.calls.at(-1)![0].onConnected("session-1"));
    click("Back");
    finish({ connectionId: "saved", grantId: "grant" });
    await Promise.resolve();
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("starts the existing browser login when adding an account even if the environment is authenticated", async () => {
    await mount("codex_local", { managedAccount: { intent: codexIntent("My second account"), onComplete: vi.fn() } });
    openProvider();
    expect(host.textContent).toContain("New subscription login");
    expect(host.textContent).not.toContain("Use saved subscription");
  });

  it("defaults to subscription when no saved credentials exist", async () => {
    await mount("claude_local", { savedApiKeys: false, localEnvironment: true });
    expect(host.textContent).toContain("Use API key instead");
    click("Use API key instead");
    openProvider();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });

  it.each([
    ["a local environment", "e1"],
    ["this server (no environment)", null],
  ] as const)("uses the claude CLI signed in on the server for a Claude subscription in %s", async (_label, environmentId) => {
    const { test, connected } = await mount("claude_local", { canLogin: false, savedApiKeys: false, authStatus: "absent", localEnvironment: environmentId !== null, environmentId });
    openProvider();
    const status = host.querySelector('[data-testid="claude-cli-sign-in-status"]');
    expect(status?.textContent).toContain("Uses the claude CLI signed in on this server");
    await vi.waitFor(() => expect(status?.textContent).toContain("is not signed in"));
    expect(mocks.auth).toHaveBeenCalledWith("c1", "claude_local", environmentId ?? undefined);
    expect(mocks.loginPanel).not.toHaveBeenCalled();
    expect(managedApi.startLocalLogin).not.toHaveBeenCalled();
    expect(host.querySelector("input")).toBeNull();
    click("Connect");
    await vi.waitFor(() => expect(connected).toHaveBeenCalledWith({ env: {} }));
    expect(test).toHaveBeenCalledWith({ env: {} });
    expect(managedApi.create).not.toHaveBeenCalled();
    expect(managedApi.connectLocal).not.toHaveBeenCalled();
  });

  it("asks for an API key, not the server's claude CLI, when the agent runs in a sandbox", async () => {
    const { test } = await mount("claude_local", { canLogin: true, savedApiKeys: false, authStatus: "unknown" });
    // A non-local target defaults to the API key card.
    openProvider();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="claude-cli-sign-in-status"]')).toBeNull();
    // Choosing a subscription anyway explains why it cannot work here.
    click("Back");
    click("Use subscription instead");
    openProvider();
    expect(host.querySelector('[data-testid="claude-cli-sign-in-status"]')).toBeNull();
    expect(host.textContent).toContain("Claude on this environment needs an Anthropic API key.");
    expect(mocks.loginPanel).not.toHaveBeenCalled();
    const connect = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect"))!;
    expect(connect.hasAttribute("disabled")).toBe(true);
    expect(test).not.toHaveBeenCalled();
  });

  it("offers only the API key step for a runner's Claude lane", async () => {
    await mount("claude_local", { savedApiKeys: false, localEnvironment: true, apiKeyOnly: true });
    expect(host.textContent).not.toContain("Use subscription instead");
    expect(host.textContent).not.toContain("Use API key instead");
    openProvider();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="claude-cli-sign-in-status"]')).toBeNull();
  });

  it("never offers a saved Claude subscription connection", async () => {
    managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [{
      id: "account", grantId: "grant", companyId: "c1", provider: "anthropic",
      method: "subscription", name: "My Claude subscription", ownership: "personal",
      ownerUserId: "user-1", isDefault: true, status: "connected",
    }] } as never);
    const { test, connected } = await mount("claude_local", { savedApiKeys: false, localEnvironment: true });
    openProvider();
    expect(host.querySelector('select[aria-label="Saved subscription"]')).toBeNull();
    expect(host.textContent).not.toContain("Use saved subscription");
    expect(host.querySelector('[data-testid="claude-cli-sign-in-status"]')).not.toBeNull();
    click("Connect");
    await vi.waitFor(() => expect(connected).toHaveBeenCalledWith({ env: {} }));
    expect(test).toHaveBeenCalledWith({ env: {} });
  });

  it("reuses a saved ChatGPT account when the sandbox auth signal is unknown", async () => {
    const { test, connected } = await mount("codex_local", { codexSubscriptions: true });
    openProvider();
    expect(host.textContent).not.toContain("New subscription login");
    click("Use saved subscription");
    await vi.waitFor(() =>
      expect(connected).toHaveBeenCalledWith({
        env: {
          CODEX_HOME: {
            type: "secret_ref",
            secretId: "codex-home",
            version: "latest",
          },
        },
      }),
    );
    expect(test).toHaveBeenCalledWith(connected.mock.calls[0][0]);
    flushSync(() => {
      const select = host.querySelector("select")!;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("New subscription login");
  });
  it.each(["claude_local", "codex_local"] as const)(
    "passes a personal reference without credentials for %s",
    async (adapter) => {
      const { test, connected, key } = await mount(adapter);
      openProvider();
      const select = host.querySelector("select")!;
      expect(select.value).toBe("user:d1");
      click("Use saved API key");
      await vi.waitFor(() =>
        expect(connected).toHaveBeenCalledWith({
          env: {
            [key]: {
              type: "user_secret_ref",
              key: `${key}.setup.1`,
              version: "latest",
            },
          },
        }),
      );
      expect(test).toHaveBeenCalledWith(connected.mock.calls[0][0]);
    },
  );
  it("uses an organization reference and requires a new key after switching away", async () => {
    const { connected, key } = await mount();
    openProvider();
    const select = host.querySelector("select")!;
    flushSync(() => {
      select.value = "company:s1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click("Use saved API key");
    await vi.waitFor(() =>
      expect(connected).toHaveBeenCalledWith({
        env: {
          [key]: { type: "secret_ref", secretId: "s1", version: "latest" },
        },
      }),
    );
    flushSync(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    const button = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Connect"),
    )!;
    expect(button.disabled).toBe(true);
    await client.invalidateQueries();
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(host.querySelector("select")!.value).toBe("");
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });
  it("uses a managed subscription through the upstream chooser", async () => {
    managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [{
      id: "account", grantId: "grant", companyId: "c1", provider: "openai",
      method: "subscription", name: "My subscription", ownership: "personal",
      ownerUserId: "user-1", isDefault: true, status: "connected",
    }] } as never);
    const { connected } = await mount("codex_local", { savedApiKeys: false });
    openProvider();
    expect(host.querySelector('select[aria-label="Saved subscription"]')?.textContent).toContain("My subscription (Your default)");
    click("Use saved subscription");
    await vi.waitFor(() => expect(connected).toHaveBeenCalledWith({ env: {}, aiConnection: { provider: "openai", method: "subscription", mode: "responsible_user" } }));
    expect(managedApi.create).not.toHaveBeenCalled();
    flushSync(() => {
      const select = host.querySelector("select")!;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("New subscription login");
    await client.invalidateQueries();
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(host.querySelector("select")!.value).toBe("");
    expect(host.textContent).toContain("New subscription login");
  });
  it("never offers a saved Codex home in Claude's subscription chooser", async () => {
    await mount("claude_local", { codexSubscriptions: true });
    click("Use subscription instead");
    openProvider();
    expect(host.querySelector('select[aria-label="Saved subscription"]')).toBeNull();
    expect(host.textContent).not.toContain("ChatGPT account");
  });

});
