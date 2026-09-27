import { z } from "zod";
import {
  SECRET_BINDING_TARGET_TYPES,
  SECRET_MANAGED_MODES,
  SECRET_PROJECTION_CLASSES,
  SECRET_PROVIDER_CONFIG_STATUSES,
  SECRET_PROVIDERS,
  SECRET_STATUSES,
} from "../constants.js";

const secretKeySchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/);
const secretVersionSelectorSchema = z.union([z.literal("latest"), z.number().int().positive()]);
const creatableSecretStatusSchema = z.enum(["active", "disabled", "archived"]);

export const envBindingPlainSchema = z.object({
  type: z.literal("plain"),
  value: z.string(),
});

export const envBindingSecretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().guid(),
  version: secretVersionSelectorSchema.optional(),
  projectionClass: z.enum(SECRET_PROJECTION_CLASSES).optional(),
  projectionAllowlistKey: z.string().trim().min(1).max(160).optional().nullable(),
});

export const envBindingUserSecretRefSchema = z.object({
  type: z.literal("user_secret_ref"),
  key: secretKeySchema,
  version: secretVersionSelectorSchema.optional(),
  required: z.boolean().optional().default(true),
  allowMissingOverride: z.boolean().optional().default(false),
});

// Backward-compatible union that accepts legacy inline values.
export const envBindingSchema = z.union([
  z.string(),
  envBindingPlainSchema,
  envBindingSecretRefSchema,
  envBindingUserSecretRefSchema,
]);

export const envConfigSchema = z.record(z.string(), envBindingSchema);

// Paperclip never reads, stores, or forwards a Claude subscription credential.
// A Claude subscription runs through the `claude` CLI that is signed in on the
// server; API-key access uses `ANTHROPIC_API_KEY`. So no env map (agent,
// project, routine, environment) and no secret may carry a subscription token:
// not under one of the env keys that name it (in any letter case), and not as a
// value (`sk-ant-oat…`, `sk-ant-ort…`, `sk-ant-sid…`) under any key.
export const CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Env keys that carry a Claude subscription credential, or point the `claude`
 * binary at one, compared in upper case: the OAuth access token
 * (`claude setup-token`), the refresh-token sign-in
 * (`CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, used with `CLAUDE_CODE_OAUTH_SCOPES`),
 * the token file and file-descriptor handoffs, the host credentials file, and a
 * remote session access token.
 */
export const CLAUDE_SUBSCRIPTION_TOKEN_ENV_KEYS: readonly string[] = [
  CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY,
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CCR_OAUTH_TOKEN_FILE",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
];

/** Prefix of a Claude subscription OAuth access token (`claude setup-token`, Claude.ai sign-in). */
export const CLAUDE_SUBSCRIPTION_TOKEN_VALUE_PREFIX = "sk-ant-oat";

/**
 * Prefixes of every Claude.ai credential value: the OAuth access token
 * (`sk-ant-oat`), the OAuth refresh token (`sk-ant-ort`), and the Claude.ai
 * session key (`sk-ant-sid`). Compared in lower case after trimming.
 */
export const CLAUDE_SUBSCRIPTION_TOKEN_VALUE_PREFIXES: readonly string[] = [
  CLAUDE_SUBSCRIPTION_TOKEN_VALUE_PREFIX,
  "sk-ant-ort",
  "sk-ant-sid",
];

export const CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE =
  "Claude subscription tokens (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_REFRESH_TOKEN, ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_TOKEN, or any sk-ant-oat, sk-ant-ort or sk-ant-sid value) are not supported. Claude subscriptions are used through the claude CLI signed in on this server; use ANTHROPIC_API_KEY for API-key access.";

/** Kept for existing imports; the message covers every subscription token key and value. */
export const CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE = CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE;

/**
 * A claude_local run on the Claude subscription lane (the `claude` CLI signed
 * in on this server, with no API credential) is limited to the server owner's
 * own use. These messages explain why such a run was refused.
 */
export const CLAUDE_SUBSCRIPTION_OWNER_ONLY_MESSAGE =
  "Claude subscription runs are limited to the server owner's own use. This instance has other users, so give this agent an Anthropic API key. Paperclip sees an API key, Bedrock, Vertex or Foundry only in the agent or server env, not in the claude CLI's settings.json or an apiKeyHelper, so set it there.";

export const CLAUDE_SUBSCRIPTION_EXTERNAL_TRIGGER_MESSAGE =
  "This run was started from outside Paperclip (chat guest, email, webhook or plugin). Claude subscription runs are for the server owner only; give this agent an Anthropic API key.";

/** Returns true when `key` names a Claude subscription token env var (case-insensitive). */
export function isClaudeSubscriptionTokenEnvKey(key: string): boolean {
  return CLAUDE_SUBSCRIPTION_TOKEN_ENV_KEYS.includes(key.trim().toUpperCase());
}

/**
 * Returns true when `value` is a Claude subscription credential (`sk-ant-oat…`,
 * `sk-ant-ort…` or `sk-ant-sid…`), whatever env key or secret carries it.
 * Non-string values are never tokens.
 */
export function isClaudeSubscriptionTokenValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return CLAUDE_SUBSCRIPTION_TOKEN_VALUE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * The literal value an env binding stores, for a legacy string binding or a
 * `plain` binding. Secret references have no literal value here.
 */
function plainEnvBindingValue(binding: unknown): string | null {
  if (typeof binding === "string") return binding;
  if (typeof binding === "object" && binding !== null && !Array.isArray(binding)) {
    const record = binding as Record<string, unknown>;
    if (record.type === "plain" && typeof record.value === "string") return record.value;
  }
  return null;
}

/** True when an env entry (key and binding) carries a Claude subscription token. */
export function isClaudeSubscriptionTokenEnvEntry(key: string, binding: unknown): boolean {
  return isClaudeSubscriptionTokenEnvKey(key) || isClaudeSubscriptionTokenValue(plainEnvBindingValue(binding));
}

/**
 * Adds one zod issue per env entry that carries a Claude subscription token: a
 * key that names one, or a literal value that is one. The issue path is
 * `[...pathPrefix, key]`. A non-object `env` adds no issue; the env shape check
 * reports that case.
 */
export function rejectClaudeSubscriptionTokenEnvKeys(
  env: unknown,
  ctx: z.RefinementCtx,
  pathPrefix: ReadonlyArray<string | number> = [],
): void {
  if (typeof env !== "object" || env === null || Array.isArray(env)) return;
  for (const [key, binding] of Object.entries(env)) {
    if (!isClaudeSubscriptionTokenEnvEntry(key, binding)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
      path: [...pathPrefix, key],
    });
  }
}

/** Adds an issue at `path` when a secret value is a Claude subscription token. */
function rejectClaudeSubscriptionTokenSecretValue(
  value: string | null | undefined,
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number> = ["value"],
): void {
  if (!isClaudeSubscriptionTokenValue(value)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
    path: [...path],
  });
}

/**
 * The env map schema for every request that writes an env map (agent
 * adapterConfig.env, project env, routine env, environment envVars). It rejects
 * a Claude subscription token key in any letter case, and a subscription token
 * value under any key, with a clean 400.
 */
export const envConfigWithoutClaudeSubscriptionTokenSchema = envConfigSchema.superRefine((env, ctx) => {
  rejectClaudeSubscriptionTokenEnvKeys(env, ctx);
});

export const createSecretSchema = z.object({
  name: z.string().min(1),
  key: secretKeySchema.optional(),
  provider: z.enum(SECRET_PROVIDERS).optional(),
  providerConfigId: z.string().guid().optional().nullable(),
  managedMode: z.enum(SECRET_MANAGED_MODES).optional(),
  value: z.string().min(1).optional().nullable(),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
  providerMetadata: z.record(z.string(), z.unknown()).optional().nullable(),
  providerVersionRef: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  rejectClaudeSubscriptionTokenSecretValue(value.value, ctx);
  if ((value.managedMode ?? "paperclip_managed") === "external_reference") {
    if (!value.externalRef?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalRef"],
        message: "External reference secrets require externalRef",
      });
    }
    return;
  }
  if (value.externalRef?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["externalRef"],
      message: "Managed secrets cannot set externalRef",
    });
  }
  if (!value.value?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Managed secrets require value",
    });
  }
});

export type CreateSecret = z.infer<typeof createSecretSchema>;

function requireSecretRotationInput(
  value: {
    value?: string | null;
    externalRef?: string | null;
    providerVersionRef?: string | null;
    providerConfigId?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  rejectClaudeSubscriptionTokenSecretValue(value.value, ctx);
  if (
    !value.value?.trim() &&
    !value.externalRef?.trim() &&
    value.providerVersionRef == null &&
    value.providerConfigId == null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Secret rotation requires value, externalRef, providerVersionRef, or providerConfigId",
    });
  }
}

export const rotateSecretSchema = z.object({
  value: z.string().min(1).optional().nullable(),
  externalRef: z.string().optional().nullable(),
  providerVersionRef: z.string().optional().nullable(),
  providerConfigId: z.string().guid().optional().nullable(),
}).superRefine(requireSecretRotationInput);

export type RotateSecret = z.infer<typeof rotateSecretSchema>;

export const updateSecretSchema = z.object({
  name: z.string().min(1).optional(),
  key: secretKeySchema.optional(),
  status: z.enum(SECRET_STATUSES).optional(),
  providerConfigId: z.string().guid().optional().nullable(),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
  providerMetadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type UpdateSecret = z.infer<typeof updateSecretSchema>;

export const secretBindingTargetSchema = z.object({
  targetType: z.enum(SECRET_BINDING_TARGET_TYPES),
  targetId: z.string().min(1),
  configPath: z.string().min(1),
});

export const createSecretBindingSchema = secretBindingTargetSchema.extend({
  secretId: z.string().guid(),
  versionSelector: secretVersionSelectorSchema.default("latest"),
  required: z.boolean().default(true),
  label: z.string().optional().nullable(),
  projectionClass: z.enum(SECRET_PROJECTION_CLASSES).optional(),
  projectionAllowlistKey: z.string().trim().min(1).max(160).optional().nullable(),
});

export type CreateSecretBinding = z.infer<typeof createSecretBindingSchema>;

export const createUserSecretDefinitionSchema = z.object({
  key: secretKeySchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).optional().nullable(),
  status: creatableSecretStatusSchema.optional(),
  provider: z.enum(SECRET_PROVIDERS).optional(),
  providerConfigId: z.string().guid().optional().nullable(),
  managedMode: z.enum(SECRET_MANAGED_MODES).optional(),
  providerMetadata: z.record(z.string(), z.unknown()).optional().nullable(),
  usageGuidance: z.string().trim().max(1000).optional().nullable(),
});

export type CreateUserSecretDefinition = z.infer<typeof createUserSecretDefinitionSchema>;

export const updateUserSecretDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  status: z.enum(SECRET_STATUSES).optional(),
  providerConfigId: z.string().guid().optional().nullable(),
  providerMetadata: z.record(z.string(), z.unknown()).optional().nullable(),
  usageGuidance: z.string().trim().max(1000).optional().nullable(),
});

export type UpdateUserSecretDefinition = z.infer<typeof updateUserSecretDefinitionSchema>;

export const createUserSecretValueSchema = z.object({
  definitionKey: secretKeySchema.optional(),
  definitionId: z.string().guid().optional(),
  value: z.string().min(1).optional().nullable(),
  externalRef: z.string().optional().nullable(),
  providerVersionRef: z.string().optional().nullable(),
  providerConfigId: z.string().guid().optional().nullable(),
}).superRefine((value, ctx) => {
  rejectClaudeSubscriptionTokenSecretValue(value.value, ctx);
  if (!value.definitionKey && !value.definitionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["definitionId"],
      message: "User secret value requires definitionId or definitionKey",
    });
  }
  if (!value.value?.trim() && !value.externalRef?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "User secret value requires value or externalRef",
    });
  }
});

export type CreateUserSecretValue = z.infer<typeof createUserSecretValueSchema>;

export const updateUserSecretValueSchema = z.object({
  status: z.enum(SECRET_STATUSES).optional(),
  value: z.string().min(1).optional().nullable(),
  externalRef: z.string().min(1).optional().nullable(),
  providerVersionRef: z.string().min(1).optional().nullable(),
  providerConfigId: z.string().guid().optional().nullable(),
}).superRefine((value, ctx) => {
  rejectClaudeSubscriptionTokenSecretValue(value.value, ctx);
});

export type UpdateUserSecretValue = z.infer<typeof updateUserSecretValueSchema>;

export const rotateUserSecretValueSchema = z.object({
  value: z.string().min(1).optional().nullable(),
  externalRef: z.string().min(1).optional().nullable(),
  providerVersionRef: z.string().min(1).optional().nullable(),
  providerConfigId: z.string().guid().optional().nullable(),
}).superRefine(requireSecretRotationInput);

export type RotateUserSecretValue = z.infer<typeof rotateUserSecretValueSchema>;

export const createUserSecretDeclarationSchema = secretBindingTargetSchema.extend({
  definitionKey: secretKeySchema,
  envKey: z.string().trim().min(1),
  versionSelector: secretVersionSelectorSchema.default("latest"),
  required: z.boolean().default(true),
  allowMissingOverride: z.boolean().default(false),
  label: z.string().optional().nullable(),
});

export type CreateUserSecretDeclaration = z.infer<typeof createUserSecretDeclarationSchema>;

const safeShortText = z.string().trim().min(1).max(160);
const optionalSafeShortText = safeShortText.optional().nullable();

const deniedProviderConfigKeyPattern =
  /^(access[-_]?key([-_]?id)?|secret[-_]?access[-_]?key|secret[-_]?key|token|password|passwd|credential|credentials|private[-_]?key|pem|jwt|session[-_]?token|service[-_]?account([-_]?json)?|client[-_]?secret|secret[-_]?id|unseal[-_]?key|recovery[-_]?key|key[-_]?file([-_]?path)?|token[-_]?file([-_]?path)?)$/i;

function rejectSensitiveProviderConfigKeys(value: unknown, ctx: z.RefinementCtx) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!deniedProviderConfigKeyPattern.test(key)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config", key],
      message: `Provider vault config cannot persist sensitive field: ${key}`,
    });
  }
}

export const localEncryptedProviderConfigSchema = z.object({
  backupReminderAcknowledged: z.boolean().optional(),
}).strict();

export const awsSecretsManagerProviderConfigSchema = z.object({
  region: z.string().trim().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/, "Invalid AWS region"),
  namespace: optionalSafeShortText,
  secretNamePrefix: optionalSafeShortText,
  kmsKeyId: z.string().trim().min(1).max(512).optional().nullable(),
  ownerTag: optionalSafeShortText,
  environmentTag: optionalSafeShortText,
}).strict();

export const gcpSecretManagerProviderConfigSchema = z.object({
  projectId: z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9-]{4,127}$/).optional().nullable(),
  location: optionalSafeShortText,
  namespace: optionalSafeShortText,
  secretNamePrefix: optionalSafeShortText,
}).strict();

const vaultAddressSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim() : value,
  z.string().url().superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const hasPath = url.pathname !== "" && url.pathname !== "/";
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      hasPath
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Vault address must be an origin-only HTTP(S) URL without credentials, path, query, or fragment",
      });
    }
  }).transform((value) => new URL(value).origin),
);

function rejectUnsafeVaultAddress(value: unknown, ctx: z.RefinementCtx) {
  if (value === undefined || value === null) return;
  const parsed = vaultAddressSchema.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      ...issue,
      path: ["config", "address", ...issue.path],
    });
  }
}

export const vaultProviderConfigSchema = z.object({
  address: vaultAddressSchema.optional().nullable(),
  namespace: optionalSafeShortText,
  mountPath: optionalSafeShortText,
  secretPathPrefix: optionalSafeShortText,
}).strict();

export const secretProviderConfigPayloadSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local_encrypted"), config: localEncryptedProviderConfigSchema }),
  z.object({ provider: z.literal("aws_secrets_manager"), config: awsSecretsManagerProviderConfigSchema }),
  z.object({ provider: z.literal("gcp_secret_manager"), config: gcpSecretManagerProviderConfigSchema }),
  z.object({ provider: z.literal("vault"), config: vaultProviderConfigSchema }),
]);

export const createSecretProviderConfigSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS),
  displayName: z.string().trim().min(1).max(120),
  status: z.enum(SECRET_PROVIDER_CONFIG_STATUSES).optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
}).superRefine((value, ctx) => {
  rejectSensitiveProviderConfigKeys(value.config, ctx);
  const parsed = secretProviderConfigPayloadSchema.safeParse({
    provider: value.provider,
    config: value.config,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: issue.path[0] === "config" ? issue.path : ["config", ...issue.path],
      });
    }
  }
  const status = value.status ?? (["gcp_secret_manager", "vault"].includes(value.provider) ? "coming_soon" : "ready");
  if ((value.provider === "gcp_secret_manager" || value.provider === "vault") && status !== "coming_soon" && status !== "disabled") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: `${value.provider} provider vaults are locked while coming soon`,
    });
  }
  if ((status === "coming_soon" || status === "disabled") && value.isDefault) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["isDefault"],
      message: "Only ready or warning provider vaults can be default",
    });
  }
});

export type CreateSecretProviderConfig = z.infer<typeof createSecretProviderConfigSchema>;

export const updateSecretProviderConfigSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  status: z.enum(SECRET_PROVIDER_CONFIG_STATUSES).optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).superRefine((value, ctx) => {
  if (value.config !== undefined) {
    rejectSensitiveProviderConfigKeys(value.config, ctx);
    rejectUnsafeVaultAddress(value.config.address, ctx);
  }
  if ((value.status === "coming_soon" || value.status === "disabled") && value.isDefault) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["isDefault"],
      message: "Only ready or warning provider vaults can be default",
    });
  }
});

export type UpdateSecretProviderConfig = z.infer<typeof updateSecretProviderConfigSchema>;

export const remoteSecretImportPreviewSchema = z.object({
  providerConfigId: z.string().guid(),
  query: z.string().trim().max(200).optional().nullable(),
  nextToken: z.string().trim().min(1).max(4096).optional().nullable(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export type RemoteSecretImportPreview = z.infer<typeof remoteSecretImportPreviewSchema>;

export const secretProviderConfigDiscoveryPreviewSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS),
  config: z.record(z.string(), z.unknown()).default({}),
  query: z.string().trim().max(200).optional().nullable(),
  nextToken: z.string().trim().min(1).max(4096).optional().nullable(),
  pageSize: z.number().int().min(1).max(100).optional(),
}).superRefine((value, ctx) => {
  rejectSensitiveProviderConfigKeys(value.config, ctx);
  const parsed = secretProviderConfigPayloadSchema.safeParse({
    provider: value.provider,
    config: value.config,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: issue.path[0] === "config" ? issue.path : ["config", ...issue.path],
      });
    }
  }
});

export type SecretProviderConfigDiscoveryPreview = z.infer<typeof secretProviderConfigDiscoveryPreviewSchema>;

export const remoteSecretImportSelectionSchema = z.object({
  externalRef: z.string().trim().min(1).max(2048),
  name: z.string().trim().min(1).max(160).optional().nullable(),
  key: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  providerVersionRef: z.string().trim().min(1).max(512).optional().nullable(),
  providerMetadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const remoteSecretImportSchema = z.object({
  providerConfigId: z.string().guid(),
  secrets: z.array(remoteSecretImportSelectionSchema).min(1).max(100),
});

export type RemoteSecretImportSelection = z.infer<typeof remoteSecretImportSelectionSchema>;
export type RemoteSecretImport = z.infer<typeof remoteSecretImportSchema>;
