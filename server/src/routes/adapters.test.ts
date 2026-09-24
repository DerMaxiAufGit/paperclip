import { describe, expect, it } from "vitest";
import type { AdapterLoginCapability, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { requireServerAdapter } from "../adapters/registry.js";
import { buildAdapterCapabilities } from "./adapters.js";

// The adapter listing projects the safe scalar login fields to the client. The
// projection carries the panel mode, the sandbox transport, and the timeout
// policy. It never carries a function member or a secret. An adapter with no
// login capability projects no `login` object.

function makeAdapter(overrides: Partial<ServerAdapterModule> = {}): ServerAdapterModule {
  return {
    type: "vendor_local",
    execute: async () => {
      throw new Error("not used");
    },
    testEnvironment: async () => {
      throw new Error("not used");
    },
    ...overrides,
  } as ServerAdapterModule;
}

const displayedCodeLogin: AdapterLoginCapability = {
  panelMode: "displayed_code",
  timeoutPolicy: "caller_bounded",
  getCommand: () => "vendor login",
  parsePrompt: () => null,
};

describe("buildAdapterCapabilities login projection", () => {
  it("projects the safe scalar login fields", () => {
    const caps = buildAdapterCapabilities(makeAdapter({ loginCapability: displayedCodeLogin }));
    expect(caps.login).toEqual({
      panelMode: "displayed_code",
      timeoutPolicy: "caller_bounded",
    });
  });

  it("omits the login object when the adapter declares no capability", () => {
    const caps = buildAdapterCapabilities(makeAdapter());
    expect(caps.login).toBeUndefined();
  });

  it("never projects the function members", () => {
    const caps = buildAdapterCapabilities(makeAdapter({ loginCapability: displayedCodeLogin }));
    expect(caps.login).not.toHaveProperty("getCommand");
    expect(caps.login).not.toHaveProperty("parsePrompt");
  });

  it("projects no login object for claude_local, which has no in-app login", () => {
    const caps = buildAdapterCapabilities(requireServerAdapter("claude_local"));
    expect(caps.login).toBeUndefined();
  });

  it("projects panelMode and timeoutPolicy for the registered grok_local adapter, with no function member", () => {
    const caps = buildAdapterCapabilities(requireServerAdapter("grok_local"));
    expect(caps.login).toEqual({
      panelMode: "displayed_code",
      timeoutPolicy: "caller_bounded",
    });
    expect(caps.login).not.toHaveProperty("getCommand");
    expect(caps.login).not.toHaveProperty("parsePrompt");
  });
});
