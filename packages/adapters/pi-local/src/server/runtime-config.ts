import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readHarnessCliFlagValues } from "@paperclipai/adapter-utils/claude-subscription-harness-guard";

type PreparedPiRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  /** The managed agent-config dir, or null when no provider config was written. */
  agentConfigDir: string | null;
  cleanup: () => Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. an LLM-gateway virtual key) into models.json
// SERVER-SIDE, where the value is reliably present. Pi resolves a provider apiKey
// by trying it as an env var name first, then as a literal -- but the (possibly
// sandboxed) run process env plumbing is not guaranteed to carry the key, so we
// resolve it here. Unresolvable placeholders are left intact; an env var set to
// an empty string counts as unresolvable (the placeholder stays for Pi to try).
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

type ParsedProviderConfig = {
  providers: Record<string, unknown> | null;
  warning: string | null;
};

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
): ParsedProviderConfig {
  // Unset/empty (or an empty JSON object) is the normal "feature off" case: no warning.
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { providers: null, warning: null };
  }
  // A SET but unusable value is a misconfiguration; surface it so the run does
  // not proceed silently unconfigured and fail later with an opaque
  // model-not-found error pointing nowhere near the env var.
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {
        providers: null,
        warning: "PAPERCLIP_PI_PROVIDERS is set but is not a JSON object; custom providers ignored.",
      };
    }
    // Only keep provider entries that are themselves objects; surface the ones
    // we drop so a malformed entry is just as diagnosable as malformed JSON.
    const providers: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
      else skipped.push(key);
    }
    return {
      providers: Object.keys(providers).length > 0 ? providers : null,
      warning: skipped.length > 0
        ? `PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`
        : null,
    };
  } catch {
    return {
      providers: null,
      warning: "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    };
  }
}

/**
 * True when a Pi model reference talks to Anthropic directly: the `anthropic`
 * provider, or a bare `claude-*` model ID without a provider (Pi then matches
 * it against its catalog, where Anthropic serves it). Anthropic models reached
 * through another provider (OpenRouter, Bedrock, Vertex, a gateway) do not
 * count.
 */
export function isPiAnthropicModel(model: string | null | undefined): boolean {
  const trimmed = (model ?? "").trim().toLowerCase();
  if (!trimmed) return false;
  const slash = trimmed.indexOf("/");
  if (slash >= 0) return trimmed.slice(0, slash).trim() === "anthropic";
  return trimmed.startsWith("claude");
}

/**
 * `isPiAnthropicModel` for the command line Pi actually gets. Paperclip appends
 * the agent's extra args after its own `--provider` and `--model`, and the last
 * value wins, so an extra `--provider anthropic` or an extra Anthropic model
 * also makes the run an Anthropic run.
 */
export function isPiAnthropicRun(input: {
  model: string | null | undefined;
  extraArgs?: readonly string[] | null;
}): boolean {
  if (isPiAnthropicModel(input.model)) return true;
  const extraProviders = readHarnessCliFlagValues(input.extraArgs, ["--provider"]).map((value) =>
    value.toLowerCase(),
  );
  if (extraProviders.includes("anthropic")) return true;
  const configuredModel = (input.model ?? "").trim();
  const slash = configuredModel.indexOf("/");
  const configuredProvider = slash > 0 ? configuredModel.slice(0, slash).trim().toLowerCase() : "";
  const effectiveProvider = extraProviders.at(-1) ?? configuredProvider;
  return readHarnessCliFlagValues(input.extraArgs, ["--model"]).some((model) =>
    model.includes("/") || !effectiveProvider ? isPiAnthropicModel(model) : effectiveProvider === "anthropic",
  );
}

/**
 * Env keys Pi reads as an Anthropic API credential. `ANTHROPIC_OAUTH_TOKEN` is
 * Pi's Claude sign-in slot and never counts; the spawn layer drops it.
 */
export const PI_ANTHROPIC_API_KEY_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

// Pi's stored logins (`/login`) live in `auth.json` in the agent config dir, and
// a stored credential wins over every env key. Leave it (and its lock) out of a
// managed agent dir so an Anthropic run authenticates with the API key.
function isPiStoredLoginEntry(name: string): boolean {
  return name === "auth.json" || name.startsWith("auth.json.");
}

function resolveHostPiAgentDir(env: Record<string, string>): string {
  const fromEnv = (env.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? "").trim();
  return fromEnv || path.join(os.homedir(), ".pi", "agent");
}

// Link every entry of the host agent dir except the stored logins, so Pi keeps
// its settings, models, extensions and tools. Only the directory listing is
// read; no file content is.
async function linkHostPiAgentDirWithoutLogins(sourceDir: string, targetDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return 0;
    throw err;
  }
  let linked = 0;
  for (const name of entries) {
    if (isPiStoredLoginEntry(name)) continue;
    await fs.symlink(path.join(sourceDir, name), path.join(targetDir, name));
    linked += 1;
  }
  return linked;
}

// Materialize custom Pi providers supplied via PAPERCLIP_PI_PROVIDERS (a JSON
// object in Pi's models.json "providers" shape) into a managed agent-config dir.
//
// Pi has no base-url CLI flag or env var: the only mechanism for pointing it at a
// custom/OpenAI- or Anthropic-compatible endpoint is a models.json file in its
// agent config dir, which Pi resolves from $PI_CODING_AGENT_DIR (falling back to
// $HOME/.pi/agent). Pi resolves `--provider P --model M` by an exact (provider,
// model id) match against that registry, so routing a gateway model requires the
// provider entry to enumerate its models explicitly. We accept the providers as
// config (not hard-coded) so the gateway URL, key, and model list stay declarative.
//
// When PAPERCLIP_PI_PROVIDERS is set we write {"providers": ...} to a fresh temp
// dir and point PI_CODING_AGENT_DIR at it; the managed dir intentionally replaces
// the host agent dir (credentials travel inside the providers config itself, via
// a literal apiKey or a server-side-expanded {env:VAR} placeholder). For remote
// execution targets, execute.ts ships the dir to the sandbox as a runtime asset
// and repoints PI_CODING_AGENT_DIR at the in-sandbox copy.
//
// With `hideStoredLogins` (an Anthropic run), Pi also never sees the host
// `auth.json`: only the official claude binary may use a Claude subscription,
// and a stored Pi login would win over ANTHROPIC_API_KEY. Without custom
// providers, a local run gets a managed agent dir that links every host entry
// except `auth.json`; a remote run gets an empty one (shipped by execute.ts), so
// the remote Pi does not read a login stored there either.
export async function preparePiRuntimeConfig(input: {
  env: Record<string, string>;
  hideStoredLogins?: boolean;
  targetIsRemote?: boolean;
}): Promise<PreparedPiRuntimeConfig> {
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const { providers, warning } = parseProviderConfig(
    input.env.PAPERCLIP_PI_PROVIDERS ?? process.env.PAPERCLIP_PI_PROVIDERS,
    resolveEnv,
  );
  if (!providers && input.hideStoredLogins) {
    const agentConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-agent-config-"));
    try {
      if (!input.targetIsRemote) {
        await linkHostPiAgentDirWithoutLogins(resolveHostPiAgentDir(input.env), agentConfigDir);
      }
    } catch (err) {
      await fs.rm(agentConfigDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    return {
      env: {
        ...input.env,
        PI_CODING_AGENT_DIR: agentConfigDir,
      },
      notes: [
        ...(warning ? [warning] : []),
        "Anthropic model: Pi runs with an agent config dir without auth.json, so it uses the Anthropic API key instead of a stored login.",
      ],
      agentConfigDir,
      cleanup: async () => {
        await fs.rm(agentConfigDir, { recursive: true, force: true });
      },
    };
  }
  if (!providers) {
    return {
      env: input.env,
      notes: warning ? [warning] : [],
      agentConfigDir: null,
      cleanup: async () => {},
    };
  }

  const agentConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-agent-config-"));
  try {
    await fs.writeFile(
      path.join(agentConfigDir, "models.json"),
      `${JSON.stringify({ providers }, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    // Never leak the temp dir when the write fails (e.g. disk-full): the
    // caller only receives the cleanup handle on success.
    await fs.rm(agentConfigDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    env: {
      ...input.env,
      PI_CODING_AGENT_DIR: agentConfigDir,
    },
    notes: [
      ...(warning ? [warning] : []),
      `Injected ${Object.keys(providers).length} custom Pi provider(s) from PAPERCLIP_PI_PROVIDERS into a managed models.json: ${Object.keys(providers).join(", ")}.`,
    ],
    agentConfigDir,
    cleanup: async () => {
      await fs.rm(agentConfigDir, { recursive: true, force: true });
    },
  };
}
