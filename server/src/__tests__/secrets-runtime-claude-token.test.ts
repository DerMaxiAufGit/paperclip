import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping runtime Claude token resolution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Every caller that resolves an env map or adapter config for a run or a probe
// (heartbeat, the adapter environment Test, skills list/sync, the auth signal)
// goes through resolveAdapterConfigForRuntime or resolveEnvBindings. A secret
// stored before Paperclip checked values, or a value held in an external
// provider, can resolve to a Claude subscription token; neither may hand it on.
describeEmbeddedPostgres("runtime secret resolution drops Claude subscription tokens", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secrets-claude-token-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secrets-claude-token");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = secretService(db);
    const create = (value: string) =>
      svc.create(companyId, { name: `secret-${randomUUID()}`, provider: "local_encrypted", value });
    // The secret service refuses to store a token today, so the provider
    // stands in for a value stored before that check (or held externally).
    const storedToken = await create("placeholder");
    const apiKey = await create("sk-ant-api03-real-key");
    const tokenNamed = await create("named-after-a-token-key");
    const original = localEncryptedProvider.resolveVersion.bind(localEncryptedProvider);
    const resolveVersion = vi
      .spyOn(localEncryptedProvider, "resolveVersion")
      .mockImplementation(async (input) =>
        input.context?.secretId === storedToken.id ? " SK-ANT-OAT01-stored-before-checks" : original(input),
      );
    const env = {
      ANTHROPIC_API_KEY: { type: "secret_ref", secretId: storedToken.id, version: "latest" },
      GOOD_KEY: { type: "secret_ref", secretId: apiKey.id, version: "latest" },
      LEGACY_REFRESH: { type: "plain", value: "sk-ant-ort01-legacy" },
      LEGACY_SESSION: "sk-ant-sid01-legacy",
      claude_code_oauth_token: { type: "secret_ref", secretId: tokenNamed.id, version: "latest" },
      KEEP: "kept",
    };
    const decrypted = (secretId: string) =>
      resolveVersion.mock.calls.some(([input]) => input.context?.secretId === secretId);
    return { companyId, svc, env, storedToken, apiKey, tokenNamed, decrypted };
  }

  it("resolveAdapterConfigForRuntime drops token values and never resolves a token key", async () => {
    const { companyId, svc, env, apiKey, tokenNamed, decrypted } = await seed();

    const result = await svc.resolveAdapterConfigForRuntime(companyId, { model: "claude-opus", env });

    expect(result.config.env).toEqual({ GOOD_KEY: "sk-ant-api03-real-key", KEEP: "kept" });
    expect(result.config.model).toBe("claude-opus");
    expect([...result.secretKeys]).toEqual(["GOOD_KEY"]);
    expect(result.manifest.map((entry) => entry.secretId)).toEqual([apiKey.id]);
    expect(decrypted(tokenNamed.id)).toBe(false);
  });

  it("resolveAdapterConfigForRuntime drops an adapter secret field that resolves to a token", async () => {
    const { companyId, svc, storedToken, apiKey } = await seed();

    const tokenField = await svc.resolveAdapterConfigForRuntime(
      companyId,
      { apiKey: { type: "secret_ref", secretId: storedToken.id, version: "latest" } },
      undefined,
      { adapterType: "hermes_gateway" },
    );
    expect(tokenField.config).toEqual({});
    expect(tokenField.secretKeys.size).toBe(0);
    expect(tokenField.manifest).toEqual([]);

    const keyField = await svc.resolveAdapterConfigForRuntime(
      companyId,
      { apiKey: { type: "secret_ref", secretId: apiKey.id, version: "latest" } },
      undefined,
      { adapterType: "hermes_gateway" },
    );
    expect(keyField.config).toEqual({ apiKey: "sk-ant-api03-real-key" });
  });

  it("resolveEnvBindings drops token values and never resolves a token key", async () => {
    const { companyId, svc, env, apiKey, tokenNamed, decrypted } = await seed();

    const result = await svc.resolveEnvBindings(companyId, env);

    expect(result.env).toEqual({ GOOD_KEY: "sk-ant-api03-real-key", KEEP: "kept" });
    expect([...result.secretKeys]).toEqual(["GOOD_KEY"]);
    expect(result.manifest.map((entry) => entry.secretId)).toEqual([apiKey.id]);
    expect(decrypted(tokenNamed.id)).toBe(false);
  });
});
