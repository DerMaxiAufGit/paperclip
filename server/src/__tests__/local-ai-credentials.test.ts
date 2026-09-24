import { afterEach, describe, expect, it, vi } from "vitest";
import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";
const mocks = vi.hoisted(() => ({ codex: vi.fn(), codexQuota: vi.fn(), readFile: vi.fn() }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ readCodexAuthInfo: mocks.codex, fetchCodexQuota: mocks.codexQuota }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.readFile } }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("explicit local subscription import", () => {
  it.each([undefined, "/isolated/claude"])("never imports a Claude sign-in (login home %s)", async (loginHome) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(readVerifiedLocalAiCredential("anthropic", loginHome)).rejects.toMatchObject({
      status: 422,
      message: "Claude subscriptions are used through the claude CLI signed in on this server; Paperclip does not import Claude sign-ins.",
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads Codex refresh credentials only from the isolated login home", async () => {
    mocks.codex.mockResolvedValue({ accessToken: "access", refreshToken: "refresh", idToken: "identity", accountId: "account", lastRefresh: "date" });
    const result = JSON.parse(await readVerifiedLocalAiCredential("openai", "/isolated/login"));
    expect(result.tokens).toEqual({ access_token: "access", refresh_token: "refresh", id_token: "identity", account_id: "account" });
    expect(mocks.codexQuota).toHaveBeenCalledWith("access", "account");
    expect(mocks.codex).toHaveBeenCalledWith("/isolated/login");
  });
  it("verifies a Grok subscription against a fixed endpoint before saving", async () => {
    const credential = JSON.stringify({ "https://issuer.x.ai::11111111-1111-4111-8111-111111111111": { key: "fixture-key", refresh_token: "fixture-refresh" } });
    mocks.readFile.mockResolvedValue(credential);
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await expect(readVerifiedLocalAiCredential("xai", "/isolated/grok")).resolves.toBe(credential);
    expect(mocks.readFile).toHaveBeenCalledWith("/isolated/grok/auth.json", "utf8");
    expect(fetch).toHaveBeenCalledWith("https://api.x.ai/v1/models", expect.objectContaining({ redirect: "error" }));
  });
  it("rejects missing and invalid logins with actionable, redacted errors", async () => {
    mocks.codex.mockResolvedValue({ accessToken: "incomplete" });
    await expect(readVerifiedLocalAiCredential("openai", "/isolated/login")).rejects.toThrow("sign-in command shown");
    expect(mocks.codexQuota).not.toHaveBeenCalled();
    mocks.codex.mockResolvedValue({ accessToken: "fixture-secret", refreshToken: "refresh", idToken: "identity", accountId: "account" });
    mocks.codexQuota.mockRejectedValue(new Error("credential fixture-secret rejected"));
    await expect(readVerifiedLocalAiCredential("openai", "/isolated/login")).rejects.toThrow(/^Could not verify the local subscription\. Run the sign-in command shown for this connection, finish signing in, then try Connect again\.$/);
  });
  it("requires an API key for OpenRouter", async () => {
    await expect(readVerifiedLocalAiCredential("openrouter", "/isolated/login")).rejects.toThrow("OpenRouter requires an API key.");
  });
  it.each(["openai", "xai"] as const)("never clones the ambient rotating %s login", async (provider) => {
    await expect(readVerifiedLocalAiCredential(provider)).rejects.toThrow("separate local sign-in");
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
