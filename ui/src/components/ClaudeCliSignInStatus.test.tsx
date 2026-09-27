// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_API_CREDENTIAL_REJECTED_ACTION,
  CLAUDE_API_CREDENTIAL_TITLE,
  CLAUDE_AUTH_REQUIRED_API_KEY_HINT,
  CLAUDE_CLI_SIGNED_IN_BUT_REJECTED_NOTE,
  CLAUDE_CLI_SIGN_IN_TITLE,
  ClaudeAuthRequiredRunGuidance,
  ClaudeCliSignInStatus,
  claudeRunUsesApiCredential,
} from "./ClaudeCliSignInStatus";

const getAdapterAuthSignal = vi.hoisted(() => vi.fn());
vi.mock("@/api/agents", () => ({ agentsApi: { getAdapterAuthSignal } }));

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

afterEach(() => {
  flushSync(() => root?.unmount());
  host?.remove();
  client?.clear();
  vi.resetAllMocks();
});

async function mount(node = <ClaudeCliSignInStatus companyId="c1" environmentId={null} />) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        {node}
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
}

describe("ClaudeCliSignInStatus", () => {
  it("says the claude CLI is not installed, instead of asking to sign in, when the binary is missing", async () => {
    getAdapterAuthSignal.mockResolvedValue({ status: "unknown", reason: "cli_missing" });
    await mount();
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        "The claude CLI is not installed for the user Paperclip runs as on this server.",
      ),
    );
    expect(host.textContent).toContain("Install Claude Code for the user Paperclip runs as");
    expect(host.textContent).not.toContain("/login");
    expect(host.textContent).toContain("Check again");
  });

  it("says a subscription cannot be used on an instance with other users, without sign-in steps", async () => {
    getAdapterAuthSignal.mockResolvedValue({ status: "absent", reason: "subscription_not_allowed" });
    await mount();
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        "Claude subscription runs are limited to the server owner's own use. This instance has other users, so give this agent an Anthropic API key.",
      ),
    );
    expect(host.textContent).not.toContain("/login");
    expect(host.textContent).not.toContain("Check again");
  });

  it("keeps the rejection panel free of sign-in steps after an auth failure on such an instance", async () => {
    getAdapterAuthSignal.mockResolvedValue({ status: "absent", reason: "subscription_not_allowed" });
    await mount(<ClaudeCliSignInStatus companyId="c1" environmentId={null} afterAuthFailure />);
    await vi.waitFor(() => expect(host.textContent).toContain("limited to the server owner's own use"));
    expect(host.textContent).not.toContain("/login");
  });

  it("does not count a subscription token in ANTHROPIC_API_KEY as an API credential", () => {
    expect(
      claudeRunUsesApiCredential({ adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-oat01-x" } } } }),
    ).toBe(false);
    expect(
      claudeRunUsesApiCredential({ adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api03-x" } } } }),
    ).toBe(true);
  });

  it("keeps the sign-in steps for an unconfirmed status with no reason", async () => {
    getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
    await mount();
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Could not confirm the claude CLI sign-in on this server."),
    );
    expect(host.textContent).toContain("/login");
  });

  it("guides a run that failed with claude_auth_required to the server sign-in, with no sign-in button", async () => {
    getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
    await mount(<ClaudeAuthRequiredRunGuidance companyId="c1" />);
    await vi.waitFor(() =>
      expect(host.textContent).toContain("The claude CLI on this server is not signed in."),
    );
    expect(getAdapterAuthSignal).toHaveBeenCalledWith("c1", "claude_local", null);
    expect(host.textContent).toContain("Open a shell on the server as the user Paperclip runs as.");
    expect(host.textContent).toContain("/login");
    expect(host.textContent).toContain(CLAUDE_AUTH_REQUIRED_API_KEY_HINT);
    expect(host.textContent).not.toContain("Login to Claude Code");
    const buttons = Array.from(host.querySelectorAll("button")).map((button) => button.textContent);
    expect(buttons).toEqual(["Check again"]);
  });

  it("hides the sign-in steps on the plain status panel when the CLI reports a sign-in", async () => {
    getAdapterAuthSignal.mockResolvedValue({ status: "present" });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain("The claude CLI on this server is signed in."));
    expect(host.textContent).not.toContain("/login");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps the re-sign-in steps and Check again for a failed run when the CLI still reports a sign-in", async () => {
    getAdapterAuthSignal.mockResolvedValue({ status: "present" });
    await mount(<ClaudeAuthRequiredRunGuidance companyId="c1" adapterConfig={{}} contextSnapshot={null} />);
    await vi.waitFor(() => expect(host.textContent).toContain("The claude CLI on this server is signed in."));
    expect(host.textContent).toContain(CLAUDE_CLI_SIGNED_IN_BUT_REJECTED_NOTE);
    expect(host.textContent).toContain("Open a shell on the server as the user Paperclip runs as.");
    expect(host.textContent).toContain("/login");
    const buttons = Array.from(host.querySelectorAll("button")).map((button) => button.textContent);
    expect(buttons).toEqual(["Check again"]);
  });

  it("checks the run's own local environment", async () => {
    getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
    await mount(
      <ClaudeAuthRequiredRunGuidance
        companyId="c1"
        adapterConfig={{}}
        contextSnapshot={{ paperclipEnvironment: { id: "env-local", driver: "local" } }}
      />,
    );
    await vi.waitFor(() =>
      expect(host.textContent).toContain("The claude CLI on this server is not signed in."),
    );
    expect(getAdapterAuthSignal).toHaveBeenCalledWith("c1", "claude_local", "env-local");
  });

  it.each([
    ["the ACP engine", { engine: "acp" }, null],
    ["an API key secret", { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s1", version: "latest" } } }, null],
    ["a gateway token", { env: { ANTHROPIC_AUTH_TOKEN: { type: "plain", value: "gw-token" } } }, null],
    ["Vertex", { env: { CLAUDE_CODE_USE_VERTEX: "1" } }, null],
    ["a managed Anthropic connection", {}, { aiConnection: { provider: "anthropic", method: "api_key" } }],
  ])("points a run that used %s at the API credential, not the server sign-in", async (_label, adapterConfig, contextSnapshot) => {
    await mount(
      <ClaudeAuthRequiredRunGuidance companyId="c1" adapterConfig={adapterConfig} contextSnapshot={contextSnapshot} />,
    );
    expect(host.textContent).toContain(CLAUDE_API_CREDENTIAL_TITLE);
    expect(host.textContent).toContain("This agent runs with an Anthropic API credential");
    expect(host.textContent).toContain(CLAUDE_API_CREDENTIAL_REJECTED_ACTION);
    expect(host.textContent).not.toContain(CLAUDE_CLI_SIGN_IN_TITLE);
    expect(host.textContent).not.toContain("/login");
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(getAdapterAuthSignal).not.toHaveBeenCalled();
  });

  it("points a run on a remote environment at the API credential, not the server sign-in", async () => {
    await mount(
      <ClaudeAuthRequiredRunGuidance
        companyId="c1"
        adapterConfig={{}}
        contextSnapshot={{ paperclipEnvironment: { id: "env-ssh", driver: "ssh" } }}
      />,
    );
    expect(host.textContent).toContain(CLAUDE_API_CREDENTIAL_TITLE);
    expect(host.textContent).toContain("Claude on this environment runs with an Anthropic API credential");
    expect(host.textContent).not.toContain("/login");
    expect(getAdapterAuthSignal).not.toHaveBeenCalled();
  });
});

describe("claudeRunUsesApiCredential", () => {
  it("ignores unset bindings and a subscription token in ANTHROPIC_AUTH_TOKEN", () => {
    expect(
      claudeRunUsesApiCredential({
        adapterConfig: {
          engine: "cli",
          env: {
            ANTHROPIC_API_KEY: { type: "plain", value: "" },
            ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-subscription",
            CLAUDE_CODE_USE_BEDROCK: "0",
            ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com",
          },
        },
      }),
    ).toBe(false);
  });
});
