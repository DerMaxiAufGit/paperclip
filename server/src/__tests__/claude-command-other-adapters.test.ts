import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  CLAUDE_COMMAND_ON_OTHER_ADAPTER_REASON,
  claudeCommandOnOtherAdapterRefusal,
} from "../services/claude-subscription-target.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("claudeCommandOnOtherAdapterRefusal", () => {
  it.each([
    ["codex_local", { command: "claude" }],
    ["kimi_local", { command: "/usr/local/bin/claude", extraArgs: ["-p"] }],
    ["gemini_local", { command: "C:\\npm\\claude.cmd" }],
    ["grok_local", { command: "npx", extraArgs: ["-y", "@anthropic-ai/claude-code"] }],
    ["cursor", { command: "bunx", args: ["claude"] }],
    ["opencode_local", { command: "env", args: ["FOO=bar", "claude"] }],
    ["pi_local", { command: "env", args: ["--frobnicate", "claude"] }],
    ["hermes_local", { hermesCommand: "claude" }],
    ["hermes_local", { hermesCommand: "hermes", command: "claude" }],
    ["some_plugin_adapter", { command: "node", args: ["/opt/node_modules/@anthropic-ai/claude-code/cli.js"] }],
  ])("refuses %s configured to run the claude binary (%j)", (adapterType, config) => {
    const refusal = claudeCommandOnOtherAdapterRefusal(adapterType, config);
    expect(refusal?.reason).toBe(CLAUDE_COMMAND_ON_OTHER_ADAPTER_REASON);
    expect(refusal?.message).toContain(`${adapterType} is configured to run the claude binary`);
    expect(refusal?.message).toContain("use the claude_local adapter for Claude");
  });

  it.each([
    ["codex_local", { command: "codex" }],
    ["codex_local", {}],
    ["kimi_local", { command: "kimi", extraArgs: ["--model", "claude"] }],
    ["gemini_local", { command: "npx", extraArgs: ["-y", "@google/gemini-cli"] }],
    ["opencode_local", { command: "opencode", extraArgs: ["--model", "anthropic/claude-sonnet-4"] }],
    ["pi_local", { command: "pi", args: ["--provider", "anthropic"] }],
    ["cursor", { command: "agent" }],
    ["hermes_local", { hermesCommand: "hermes" }],
    ["codex_local", { command: 42 }],
    ["codex_local", { command: "claude-helper" }],
  ])("leaves %s with its own command alone (%j)", (adapterType, config) => {
    expect(claudeCommandOnOtherAdapterRefusal(adapterType, config)).toBeNull();
  });

  it("leaves claude_local and process to the Claude subscription lane gates", () => {
    expect(claudeCommandOnOtherAdapterRefusal("claude_local", { command: "claude" })).toBeNull();
    expect(claudeCommandOnOtherAdapterRefusal("process", { command: "claude" })).toBeNull();
    expect(claudeCommandOnOtherAdapterRefusal(null, { command: "claude" })).toBeNull();
  });

  it("does not echo the configured command", () => {
    const refusal = claudeCommandOnOtherAdapterRefusal("codex_local", { command: "/home/owner/secret-dir/claude" });
    expect(refusal?.message).not.toContain("secret-dir");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat refusal for other adapters configured to run claude", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const adapterTypes = ["codex_local", "kimi_local"] as const;
  const originals = new Map(adapterTypes.map((type) => [type, getServerAdapter(type)]));

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-command-other-adapters-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "claude-command-other-adapters");
    database = await startEmbeddedPostgresTestDatabase("paperclip-claude-command-other-adapters-db-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const [type, original] of originals) {
      unregisterServerAdapter(type);
      registerServerAdapter(original);
    }
  });

  function fakeAdapter(type: string, issueId: string) {
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
    });
    registerServerAdapter({
      type,
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({ adapterType: type, status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
    });
    return execute;
  }

  async function fixture(adapterType: string, adapterConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Claude command on other adapters",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const now = new Date();
    const userId = `user-${companyId}`;
    await db.insert(authUsers).values({
      id: userId,
      name: userId,
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: adapterType,
        role: "engineer",
        adapterType,
        adapterConfig: { cwd: home, ...adapterConfig },
        runtimeConfig: { heartbeat: { enabled: false } },
      })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Claude command task",
        status: "todo",
        assigneeAgentId: agent!.id,
        createdByUserId: userId,
      })
      .returning();
    return { companyId, agent: agent!, issue: issue!, ownerUserId: userId };
  }

  async function assignAsOwner(
    heartbeat: ReturnType<typeof heartbeatService>,
    f: { agent: { id: string }; issue: { id: string }; ownerUserId: string },
  ) {
    const run = await heartbeat.invoke(
      f.agent.id,
      "assignment",
      { issueId: f.issue.id, wakeReason: "issue_assigned" },
      "system",
      { actorType: "user", actorId: f.ownerUserId },
    );
    expect(run).not.toBeNull();
    await expect
      .poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 })
      .toMatch(/^(succeeded|failed)$/);
    return heartbeat.getRun(run!.id);
  }

  async function cleanup(heartbeat: ReturnType<typeof heartbeatService>, f: { agent: { id: string } }) {
    await heartbeat.drainActiveRunExecutions();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.agentId, f.agent.id));
  }

  it.each([
    ["codex_local", { command: "claude" }],
    ["kimi_local", { command: "claude", extraArgs: ["-p"] }],
    ["codex_local", { command: "npx", extraArgs: ["-y", "@anthropic-ai/claude-code"] }],
  ])("refuses a %s agent whose command runs claude (%j), before the adapter runs", async (adapterType, adapterConfig) => {
    const f = await fixture(adapterType, adapterConfig);
    const execute = fakeAdapter(adapterType, f.issue.id);
    const heartbeat = heartbeatService(db);
    try {
      const finished = await assignAsOwner(heartbeat, f);
      expect(finished?.status).toBe("failed");
      expect(finished?.errorCode).toBe("configuration_incomplete");
      expect(finished?.error).toContain(`${adapterType} is configured to run the claude binary`);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await cleanup(heartbeat, f);
    }
  });

  it.each([
    ["codex_local", { command: "codex" }],
    ["kimi_local", { command: "kimi" }],
    ["kimi_local", {}],
  ])("runs a %s agent with its own command (%j)", async (adapterType, adapterConfig) => {
    const f = await fixture(adapterType, adapterConfig);
    const execute = fakeAdapter(adapterType, f.issue.id);
    const heartbeat = heartbeatService(db);
    try {
      const finished = await assignAsOwner(heartbeat, f);
      expect(finished?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup(heartbeat, f);
    }
  });
});
