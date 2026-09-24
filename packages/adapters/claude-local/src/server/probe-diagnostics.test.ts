import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeLoginRequiredHint,
  classifyThrownErrorClass,
  logSandboxProbeDiagnostic,
} from "./probe-diagnostics.js";

describe("buildClaudeLoginRequiredHint", () => {
  it("tells the operator to sign in with the claude CLI on the Paperclip host", () => {
    const hint = buildClaudeLoginRequiredHint({ targetIsRemote: false });
    expect(hint).toContain("run `claude` as the user Paperclip runs as");
    expect(hint).toContain("`/login`");
    expect(hint).not.toContain("ANTHROPIC_API_KEY");
  });

  it("points a remote target at ANTHROPIC_API_KEY instead of a sign-in", () => {
    const hint = buildClaudeLoginRequiredHint({ targetIsRemote: true });
    expect(hint).toContain("ANTHROPIC_API_KEY");
    expect(hint).not.toContain("/login");
  });
});

describe("classifyThrownErrorClass", () => {
  it("returns the constructor name for an Error", () => {
    expect(classifyThrownErrorClass(new TypeError("boom"))).toBe("TypeError");
    expect(classifyThrownErrorClass(new Error("boom"))).toBe("Error");
  });

  it("returns null for a non-Error value", () => {
    expect(classifyThrownErrorClass("a raw secret string")).toBeNull();
    expect(classifyThrownErrorClass(null)).toBeNull();
    expect(classifyThrownErrorClass({ message: "opaque" })).toBeNull();
  });
});

describe("logSandboxProbeDiagnostic", () => {
  it("logs only the fixed context and the allowlisted classification", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSandboxProbeDiagnostic("probe failed", "auth_required");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[paperclip] probe failed", {
      classification: "auth_required",
    });
    warnSpy.mockRestore();
  });

  it("adds a finite exit code as a structured field", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSandboxProbeDiagnostic("probe failed", "nonzero_exit", { exitCode: 3 });
    expect(warnSpy).toHaveBeenCalledWith("[paperclip] probe failed", {
      classification: "nonzero_exit",
      exitCode: 3,
    });
    warnSpy.mockRestore();
  });

  it("drops a null or non-finite exit code", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSandboxProbeDiagnostic("probe failed", "nonzero_exit", { exitCode: null });
    logSandboxProbeDiagnostic("probe failed", "nonzero_exit", { exitCode: Number.NaN });
    for (const call of warnSpy.mock.calls) {
      expect(call[1]).toEqual({ classification: "nonzero_exit" });
    }
    warnSpy.mockRestore();
  });

  it("sanitizes the error class to an identifier and bounds its length", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A crafted error class name that carries an opaque marker and a proxy URL.
    // The sanitizer must strip every non-identifier character and bound the
    // length, so no structured secret shape reaches the log.
    logSandboxProbeDiagnostic("probe failed", "spawn_error", {
      errorClass: `MARKER-LEAK http://user:pass@proxy.internal:8080/path?t=${"x".repeat(200)}`,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const detail = warnSpy.mock.calls[0]![1] as { errorClass?: string };
    expect(detail.errorClass).toMatch(/^[A-Za-z0-9_$]+$/);
    expect(detail.errorClass!.length).toBeLessThanOrEqual(64);
    // The separators and the proxy structure do not survive.
    expect(detail.errorClass).not.toContain("-");
    expect(detail.errorClass).not.toContain(":");
    expect(detail.errorClass).not.toContain("/");
    warnSpy.mockRestore();
  });

  it("drops an empty or non-string error class", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSandboxProbeDiagnostic("probe failed", "spawn_error", { errorClass: null });
    logSandboxProbeDiagnostic("probe failed", "spawn_error", { errorClass: "***" });
    for (const call of warnSpy.mock.calls) {
      expect(call[1]).toEqual({ classification: "spawn_error" });
    }
    warnSpy.mockRestore();
  });
});
