// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuotaWindow } from "@paperclipai/shared";
import { ProviderQuotaCard } from "./ProviderQuotaCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const codexWindows: QuotaWindow[] = [
  { label: "5h limit", usedPercent: 12, resetsAt: null, valueLabel: null, detail: null },
];

describe("ProviderQuotaCard subscription quota", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<Parameters<typeof ProviderQuotaCard>[0]> & { provider: string }) {
    act(() => {
      root.render(
        <ProviderQuotaCard
          rows={[]}
          budgetMonthlyCents={0}
          totalCompanySpendCents={0}
          weekSpendCents={0}
          windowRows={[]}
          showDeficitNotch={false}
          {...props}
        />,
      );
    });
  }

  it("shows no Claude usage section while loading, with an empty result, or with a stale error", () => {
    render({ provider: "anthropic", quotaLoading: true });
    expect(container.textContent).not.toContain("Subscription quota");

    render({ provider: "anthropic", quotaWindows: [], quotaSource: null });
    expect(container.textContent).not.toContain("Subscription quota");

    render({ provider: "anthropic", quotaError: "Claude CLI /usage failed", quotaSource: "claude-cli" });
    expect(container.textContent).not.toContain("Subscription quota");
    expect(container.textContent).not.toContain("Claude CLI /usage failed");
  });

  it("still shows the Codex subscription quota section", () => {
    render({ provider: "openai", quotaWindows: codexWindows, quotaSource: "codex-rpc" });
    expect(container.textContent).toContain("Subscription quota");
    expect(container.textContent).toContain("5h limit");
  });
});
