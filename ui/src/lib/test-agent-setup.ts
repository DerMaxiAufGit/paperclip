import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";

/** ACP readiness checks do not authenticate a provider. Verify credentials with
 * the adapter's existing read-only CLI hello probe before calling setup connected. */
export async function testAgentSetup(input: {
  companyId: string;
  agentId?: string;
  adapterType: string;
  providerAdapter: string;
  adapterConfig: Record<string, unknown>;
  aiConnection?: import("@paperclipai/shared").AiConnectionBinding;
  testCredentials?: Record<string, string>;
  environmentId: string | null;
}): Promise<AdapterEnvironmentTestResult> {
  const payload = {
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.aiConnection ? { aiConnection: input.aiConnection } : {}),
    adapterConfig: input.adapterConfig,
    ...(input.testCredentials ? { testCredentials: input.testCredentials } : {}),
    environmentId: input.environmentId,
  };
  const runtime = await agentsApi.testEnvironment(
    input.companyId,
    input.adapterType,
    payload,
  );
  if (
    runtime.status === "fail" ||
    runtime.checks.some(
      (check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE,
    ) ||
    runtime.checks.some((check) => check.code.includes("hello_probe")) ||
    !["claude_local", "codex_local"].includes(input.providerAdapter)
  )
    return runtime;
  // A Paperclip Runner's Claude lane (ACPX / Agent SDK) never runs on a Claude
  // subscription. Without an API key the claude_local CLI probe below would
  // pass on the server's own claude sign-in, which the runner cannot use.
  if (input.adapterType === "paperclip_runner" && input.providerAdapter === "claude_local") {
    const env = (input.adapterConfig.env ?? {}) as Record<string, unknown>;
    const hasKey =
      Boolean(input.testCredentials?.ANTHROPIC_API_KEY) ||
      input.aiConnection?.provider === "anthropic" ||
      Boolean(env.ANTHROPIC_API_KEY);
    if (!hasKey) {
      return {
        adapterType: input.adapterType,
        testedAt: runtime.testedAt,
        status: "fail",
        checks: [
          ...runtime.checks,
          {
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            level: "error",
            message:
              "Claude on a Paperclip Runner (ACPX) needs an Anthropic API key. A Claude subscription works only with the local claude CLI engine.",
          },
        ],
      };
    }
  }
  const provider = await agentsApi.testEnvironment(
    input.companyId,
    input.providerAdapter,
    {
      ...payload,
      adapterConfig: { ...input.adapterConfig, engine: "cli" },
    },
  );
  const checks = [
    ...new Map(
      [...runtime.checks, ...provider.checks].map((check) => [
        check.code,
        check,
      ]),
    ).values(),
  ];
  return {
    adapterType: input.adapterType,
    testedAt: provider.testedAt,
    status:
      provider.status === "fail"
        ? "fail"
        : runtime.status === "warn" || provider.status === "warn"
          ? "warn"
          : "pass",
    checks,
  };
}
