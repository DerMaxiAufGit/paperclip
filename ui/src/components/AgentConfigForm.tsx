import { AiConnectionField } from "./ai-connections/AiConnectionField";
import { aiConnectionBindingSchema } from "@paperclipai/shared";
import { testAgentSetup } from "@/lib/test-agent-setup";
import { setupEfforts } from "../lib/agent-setup-fields";
import { RuntimeTestCard } from "./RuntimeTestCard";
import { useState, useEffect, useRef, useMemo, useCallback, Children, isValidElement, type ReactNode } from "react";
import type { AdapterConfigSection } from "../adapters/types";
import { useConfigSchema } from "../adapters/schema-config-fields";
import { schemaFieldSection } from "../adapters/config-sections";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  AdapterAuthSessionPrompt,
  AdapterAuthSessionStatus,
  CodexAccountBindingClaim,
  AdapterEnvironmentTestResult,
  CompanySecret,
  EnvBinding,
  EnvSecretRefBinding,
  Environment,
} from "@paperclipai/shared";
import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS, supportedEnvironmentDriversForAdapter, ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import type { AdapterModel } from "../api/agents";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { secretsApi } from "../api/secrets";
import { assetsApi } from "../api/assets";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CLAUDE_LOCAL_MODEL } from "@paperclipai/adapter-claude-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_KIMI_LOCAL_MODEL } from "@paperclipai/adapter-kimi-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { FolderOpen, Heart, ChevronDown, X, Copy, Check, ExternalLink, Loader2, TriangleAlert, Bug } from "lucide-react";
import { asBoolean, asFiniteNumber, asObject, cn } from "../lib/utils";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  connectSourceName,
  ProviderSubscriptionCard,
  OnboardingLoginCodeRow,
  type AdapterLoginChrome,
} from "./AdapterLoginChrome";
import {
  resolveAdapterTestEnvironmentId,
  resolveLocalDefaultEnvironmentId,
  resolveManagedSandboxEnvironmentId,
} from "../lib/adapter-test-environment";
import { environmentDisplayLabel } from "../lib/managed-sandbox-environment";
import { extractModelName, extractProviderId } from "../lib/model-utils";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import {
  Field,
  ToggleField,
  ToggleWithNumber,
  CollapsibleSection,
  DraftInput,
  DraftNumberInput,
  help,
  adapterLabels,
} from "./agent-config-primitives";
import { defaultCreateValues } from "./agent-config-defaults";
import { getUIAdapter } from "../adapters";
import { ClaudeLocalAdvancedFields } from "../adapters/claude-local/config-fields";
import { MarkdownEditor } from "./MarkdownEditor";
import { ChoosePathButton } from "./PathInstructionsModal";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import { ReportsToPicker } from "./ReportsToPicker";
import {
  EnvironmentVariablesEditor,
  type EnvironmentVariablesEditorHandle,
} from "./environment-variables-editor";
import { AgentSecretAccessEditor } from "./AgentSecretAccessEditor";
import { ClaudeCliSignInStatus } from "./ClaudeCliSignInStatus";
import { useProposalReview } from "../pages/secrets/proposal-review";
import { AGENT_ACCESS_CONFIG_PATH_PREFIX } from "../lib/secret-delivery";
import { shouldShowLegacyWorkingDirectoryField } from "../lib/legacy-agent-config";
import { listAdapterOptions, listVisibleAdapterTypes } from "../adapters/metadata";
import { getAdapterDisplay, getAdapterLabel } from "../adapters/adapter-display-registry";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { buildAgentUpdatePatch, omitUndefinedEntries, type AgentConfigOverlay } from "../lib/agent-config-patch";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { resolveForcedKubernetesEnvironment } from "../lib/forced-kubernetes-environment";
import { codexReasoningEffortOptions } from "../lib/codex-reasoning-effort";

/* ---- Create mode values ---- */

// Canonical type lives in @paperclipai/adapter-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  paperclipRunnerTransitionConfig,
  type CreateConfigValues,
} from "@paperclipai/adapter-utils";
import { Badge } from "@/components/ui/badge";

/* ---- Props ---- */

type AgentConfigFormProps = {
  adapterModels?: AdapterModel[];
  onDirtyChange?: (dirty: boolean) => void;
  onSaveActionChange?: (save: (() => void) | null) => void;
  onCancelActionChange?: (cancel: (() => void) | null) => void;
  onTestActionChange?: (test: (() => void) | null) => void;
  onTestActionStateChange?: (state: { disabled: boolean; pending: boolean }) => void;
  onTestFeedbackChange?: (feedback: {
    errorMessage: string | null;
    result: AdapterEnvironmentTestResult | null;
    // The login panel descriptor when the current target is a sandbox with no
    // ready authentication, otherwise null. A parent that lifts the test
    // feedback must render `AdapterLoginPanel` from this descriptor. The inline
    // feedback branch renders the panel itself, so this descriptor is the only
    // way the panel reaches a parent that hides the inline branch.
    login: AdapterLoginDescriptor | null;
  }) => void;
  hideInlineSave?: boolean;
  showAdapterTypeField?: boolean;
  showAdapterTestEnvironmentButton?: boolean;
  compactTestFeedback?: boolean;
  showCreateRunPolicySection?: boolean;
  hideInstructionsFile?: boolean;
  /** Allow instance administrators to configure short-lived raw provider capture. */
  canConfigureProviderTrace?: boolean;
  /** Hide the prompt template field from the Identity section (used when it's shown in a separate Prompts tab). */
  hidePromptTemplate?: boolean;
  /** Render the main configuration sections or the dedicated edit-only Secrets surface. */
  content?: "configuration" | "secrets";
  /** Keep variable bindings beside secret access in a unified edit surface. */
  environmentVariablesPlacement?: "configuration" | "secrets";
  /** "cards" renders each section as heading + bordered card (for settings pages). Default: "inline" (border-b dividers). */
  sectionLayout?: "inline" | "cards";
  /** Optional settings composition; sorting changes DOM order as well as visual order. */
  sectionOrder?: readonly string[];
  sectionTitles?: Record<string, string>;
} & (
  | {
      mode: "create";
      values: CreateConfigValues;
      onChange: (patch: Partial<CreateConfigValues>) => void;
    }
  | {
      mode: "edit";
      agent: Agent;
      onSave: (patch: Record<string, unknown>) => void | Promise<unknown>;
      isSaving?: boolean;
    }
);

/* ---- Edit mode overlay (dirty tracking) ---- */

const emptyOverlay: AgentConfigOverlay = {
  identity: {},
  adapterConfig: {},
  heartbeat: {},
  debug: {},
  runtime: {},
};

/** Stable empty object used as fallback for missing env config to avoid new-object-per-render. */
const EMPTY_ENV: Record<string, EnvBinding> = {};

export function supportsAdapterModelRefresh(adapterType: string): boolean {
  return adapterType === "claude_local" || adapterType === "codex_local" || adapterType === "paperclip_runner" || adapterType === "opencode_local";
}

export function resolvePaperclipRunnerTransitionModel(
  previousAdapterType: string,
  previousModel: unknown,
): string {
  return paperclipRunnerTransitionConfig(previousAdapterType, previousModel).model as string;
}

function isOverlayDirty(o: AgentConfigOverlay): boolean {
  return (
    Object.keys(o.identity).length > 0 ||
    o.adapterType !== undefined ||
    Object.keys(o.adapterConfig).length > 0 ||
    Object.keys(o.heartbeat).length > 0 ||
    Object.keys(o.debug).length > 0 ||
    Object.keys(o.runtime).length > 0
  );
}

/**
 * Structural equality for overlay entry values. Overlay values are
 * JSON-shaped (scalars, env maps, argument arrays), so a reference compare
 * alone would keep an edit-then-restore of a structured value falsely dirty
 * after a refresh subtracts the persisted snapshot.
 */
export function overlayValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => overlayValuesEqual(item, b[index]));
  }
  if (
    typeof a === "object" && a !== null && !Array.isArray(a) &&
    typeof b === "object" && b !== null && !Array.isArray(b)
  ) {
    const aEntries = Object.entries(a as Record<string, unknown>);
    const bRecord = b as Record<string, unknown>;
    return (
      aEntries.length === Object.keys(bRecord).length &&
      aEntries.every(([key, value]) => key in bRecord && overlayValuesEqual(value, bRecord[key]))
    );
  }
  return false;
}

/**
 * Remove from `current` every entry `persisted` carried with a structurally
 * equal value, keeping entries the user added or changed after `persisted`
 * was snapshotted. The refresh that follows a background save consumes this
 * so edits made while that save was in flight survive as pending dirty state
 * instead of being wiped with the rest of the overlay.
 */
export function subtractPersistedOverlay(
  current: AgentConfigOverlay,
  persisted: AgentConfigOverlay,
): AgentConfigOverlay {
  const subtractGroup = (
    currentGroup: Record<string, unknown>,
    persistedGroup: Record<string, unknown>,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(currentGroup).filter(
        ([field, value]) =>
          !(field in persistedGroup) || !overlayValuesEqual(value, persistedGroup[field]),
      ),
    );
  return {
    identity: subtractGroup(current.identity, persisted.identity),
    ...(current.adapterType !== undefined && current.adapterType !== persisted.adapterType
      ? { adapterType: current.adapterType }
      : {}),
    adapterConfig: subtractGroup(current.adapterConfig, persisted.adapterConfig),
    heartbeat: subtractGroup(current.heartbeat, persisted.heartbeat),
    debug: subtractGroup(current.debug, persisted.debug),
    runtime: subtractGroup(current.runtime, persisted.runtime),
  };
}

/* ---- Shared input class ---- */
const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatArgList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .join(", ");
  }
  return typeof value === "string" ? value : "";
}

const openCodeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
  { id: "max", label: "Max" },
] as const;

const cursorModeOptions = [
  { id: "", label: "Auto" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
] as const;

const claudeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
] as const;

// Kimi exposes low/high/max (no "medium") via each model's support_efforts;
// the kimi_local adapter maps a legacy "medium" onto "high" at runtime.
const kimiThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const;

const MAX_TURN_CONTINUATION_DEFAULT_MAX_ATTEMPTS = 2;
const MAX_TURN_CONTINUATION_MAX_ATTEMPTS_CAP = 10;
const MAX_TURN_CONTINUATION_DEFAULT_DELAY_SEC = 1;
const MAX_TURN_CONTINUATION_MAX_DELAY_SEC = 300;

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampDelayMsFromSeconds(value: number) {
  return clampInteger(value, 0, MAX_TURN_CONTINUATION_MAX_DELAY_SEC) * 1000;
}

function ConfigSections({ order, className, children }: {
  order?: readonly string[];
  className: string;
  children: ReactNode;
}) {
  if (!order) return <div className={className}>{children}</div>;
  const rank = (child: ReactNode) => {
    const key = isValidElement<{ "data-config-section"?: string }>(child)
      ? child.props["data-config-section"]
      : undefined;
    const index = key ? order.indexOf(key) : -1;
    return index < 0 ? order.length : index;
  };
  const sections = Children.toArray(children).sort((a, b) => rank(a) - rank(b));
  return <div className={className}>{sections}</div>;
}

/* ---- Form ---- */

export function AgentConfigForm(props: AgentConfigFormProps) {
  const { mode, adapterModels: externalModels } = props;
  const isCreate = mode === "create";
  const cards = props.sectionLayout === "cards";
  const showAdapterTypeField = props.showAdapterTypeField ?? true;
  const showAdapterTestEnvironmentButton = props.showAdapterTestEnvironmentButton ?? true;
  const showInlineAdapterTestEnvironmentButton =
    showAdapterTestEnvironmentButton && !props.onTestActionChange && !props.compactTestFeedback;
  const showInlineAdapterTestEnvironmentFeedback = !props.onTestFeedbackChange;
  const showCreateRunPolicySection = props.showCreateRunPolicySection ?? true;
  const hideInstructionsFile = props.hideInstructionsFile ?? false;
  const canConfigureProviderTrace = props.canConfigureProviderTrace === true;
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const environmentVariablesEditorRef = useRef<EnvironmentVariablesEditorHandle | null>(null);

  // Sync disabled adapter types from server so dropdown filters them out.
  const disabledTypes = useDisabledAdaptersSync();

  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  // User-secret definitions power the "User secret" env binding source. Requires
  // secret-admin; non-admins simply get the free-text key fallback in the editor.
  const { data: userSecretDefinitions = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.userDefinitions(selectedCompanyId)
      : ["user-secret-definitions", "none"],
    queryFn: () => secretsApi.listUserSecretDefinitions(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  // Pending binding proposals targeting this agent (PAP-14731). Board-only route;
  // non-permitted viewers simply get an empty list.
  const editAgentId = !isCreate ? props.agent.id : null;
  const { data: pendingProposals = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.proposals(selectedCompanyId, "pending")
      : ["secret-proposals", "none"],
    queryFn: () => secretsApi.listProposals(selectedCompanyId!, "pending"),
    enabled: Boolean(selectedCompanyId) && !isCreate,
    retry: false,
  });
  const agentBindingProposals = useMemo(
    () =>
      pendingProposals.filter(
        (proposal) => proposal.kind === "binding" && proposal.target?.id === editAgentId,
      ),
    [pendingProposals, editAgentId],
  );
  const proposalReview = useProposalReview(selectedCompanyId, []);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const adapterPickerDisabledTypes = useMemo(() => {
    const next = new Set(disabledTypes);
    // Fail closed while settings load. Existing native agents still render
    // their current value in edit mode, but the picker does not offer a fresh
    // native selection until the explicit experimental opt-in is known true.
    if (experimentalSettings?.enableNativeRunner !== true) {
      next.add("paperclip_runner");
    }
    return next;
  }, [disabledTypes, experimentalSettings?.enableNativeRunner]);
  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;
  // Managed-sandbox-only policy: every agent runs in the platform-managed
  // environment, so the form hides each host filesystem path and each
  // execution-engine choice. Declared here because the field gates below and
  // the adapter field props both read it.
  const managedSandboxOnly = experimentalSettings?.enableManagedSandboxOnly === true;
  // The gate the host-path fields use. It fails closed whenever the policy is
  // unknown — in flight and also on a failed read: an unresolved policy reads as
  // "not managed", which would show a stored working directory or
  // instructions-file path.
  const hideHostPaths = experimentalSettings === undefined || managedSandboxOnly;

  // Instance execution policy (general settings). When `executionMode` is
  // "kubernetes" the instance FORCES all execution onto the managed Kubernetes
  // sandbox; "any"/absent leaves the full environment/adapter choice intact.
  // Reuses the same general-settings query the rest of the UI uses.
  const { data: generalSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    retry: false,
  });
  const { data: instanceSettings } = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    retry: false,
  });

  const { data: environments = [] } = useQuery<Environment[]>({
    queryKey: selectedCompanyId ? queryKeys.environments.list(selectedCompanyId) : ["environments", "none"],
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    // Load environments when the picker is enabled OR when execution is forced
    // onto Kubernetes (so we can resolve and default to the managed K8s env even
    // when the experimental environments picker is otherwise hidden).
    enabled:
      Boolean(selectedCompanyId) &&
      (environmentsEnabled || generalSettings?.executionMode === "kubernetes"),
  });

  // Setting-driven: resolve whether the instance forces Kubernetes execution and
  // which loaded environment is the managed Kubernetes sandbox.
  const { forced: forcedKubernetes, kubernetesEnvironment } = useMemo(
    () => resolveForcedKubernetesEnvironment(generalSettings?.executionMode, environments),
    [generalSettings?.executionMode, environments],
  );
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select an organization to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });

  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!selectedCompanyId) throw new Error("Select an organization to upload images");
      return assetsApi.uploadImage(selectedCompanyId, file, namespace);
    },
  });

  // ---- Edit mode: overlay for dirty tracking ----
  const [overlay, setOverlay] = useState<AgentConfigOverlay>(emptyOverlay);
  const [environmentDraftDirty, setEnvironmentDraftDirty] = useState(false);
  const [environmentEditorKey, setEnvironmentEditorKey] = useState(0);
  const agentRef = useRef<Agent | null>(null);
  // The overlay snapshot a background account-binding save persisted. The form
  // stays editable while that save is in flight, so the agent refresh that
  // follows it must not wipe edits made during the save. The refresh subtracts
  // only what the save persisted; a user-initiated Save leaves the snapshot
  // null and keeps the full wipe. An UNRELATED refresh can land while the save
  // is still in flight — that refresh does not carry the persisted binding
  // yet, so it must neither consume the snapshot nor subtract it: subtracting
  // would drop the binding entry from the overlay while `props.agent` also
  // lacks it, and an ordinary Save racing the binding refresh would then
  // replace the config without the binding and undo the just-persisted bind.
  // The overlay stays untouched until the save settles; the refresh after
  // settlement consumes the snapshot and subtracts it.
  const backgroundSaveOverlayRef = useRef<AgentConfigOverlay | null>(null);
  const backgroundSaveInFlightRef = useRef(false);

  // Clear overlay when agent data refreshes (after save)
  useEffect(() => {
    if (!isCreate) {
      if (
        agentRef.current !== null &&
        props.agent !== agentRef.current &&
        !backgroundSaveInFlightRef.current
      ) {
        const persisted = backgroundSaveOverlayRef.current;
        backgroundSaveOverlayRef.current = null;
        setOverlay((prev) =>
          persisted ? subtractPersistedOverlay(prev, persisted) : { ...emptyOverlay },
        );
      }
      agentRef.current = props.agent;
    }
  }, [isCreate, !isCreate ? props.agent : undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = !isCreate && (isOverlayDirty(overlay) || environmentDraftDirty);

  type RecordOverlayGroup = "identity" | "adapterConfig" | "heartbeat" | "debug" | "runtime";

  /** Read effective value: overlay if dirty, else original */
  function eff<T>(group: RecordOverlayGroup, field: string, original: T): T {
    const o = overlay[group];
    if (field in o) return o[field] as T;
    return original;
  }

  /** Mark field dirty in overlay */
  function mark(group: RecordOverlayGroup, field: string, value: unknown) {
    setOverlay((prev) => ({
      ...prev,
      [group]: { ...prev[group], [field]: value },
    }));
  }

  function flushEnvironmentDraft() {
    return environmentVariablesEditorRef.current?.flushPendingDraft() ?? null;
  }

  /**
   * Replace the agent's API-access grants (top-level `access.<ALIAS>` keys) with
   * the complete set emitted by the Secret access editor. Added/changed aliases
   * are marked into the overlay; aliases dropped from the set are marked
   * `undefined` so `buildAgentUpdatePatch` strips them.
   */
  const applyAccessGrants = useCallback((next: Record<string, EnvSecretRefBinding>) => {
    if (isCreate) return;
    setOverlay((prev) => {
      const effective = { ...(props.agent.adapterConfig ?? {}), ...prev.adapterConfig } as Record<string, unknown>;
      const nextAdapterConfig: Record<string, unknown> = { ...prev.adapterConfig };
      for (const [alias, binding] of Object.entries(next)) {
        nextAdapterConfig[`${AGENT_ACCESS_CONFIG_PATH_PREFIX}${alias}`] = binding;
      }
      for (const key of Object.keys(effective)) {
        if (!key.startsWith(AGENT_ACCESS_CONFIG_PATH_PREFIX)) continue;
        const alias = key.slice(AGENT_ACCESS_CONFIG_PATH_PREFIX.length);
        if (!(alias in next)) nextAdapterConfig[key] = undefined;
      }
      return { ...prev, adapterConfig: nextAdapterConfig };
    });
  }, [isCreate, !isCreate ? props.agent : undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Build accumulated patch and send to parent */
  const handleCancel = useCallback(() => {
    setOverlay({ ...emptyOverlay });
    setEnvironmentDraftDirty(false);
    setEnvironmentEditorKey(key => key + 1);
  }, []);

  const handleSave = useCallback(async () => {
    if (isCreate) return;
    const flushedEnv = flushEnvironmentDraft();
    const nextOverlay = flushedEnv
      ? {
          ...overlay,
          adapterConfig: {
            ...overlay.adapterConfig,
            env: flushedEnv,
          },
        }
      : overlay;
    if (!isOverlayDirty(nextOverlay)) return;
    await props.onSave(buildAgentUpdatePatch(props.agent, nextOverlay));
  }, [isCreate, isDirty, overlay, props]);

  useEffect(() => {
    if (!isCreate) {
      props.onDirtyChange?.(isDirty);
      props.onSaveActionChange?.(handleSave);
      props.onCancelActionChange?.(handleCancel);
    }
  }, [isCreate, isDirty, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange, handleSave, handleCancel]);

  useEffect(() => {
    if (isCreate) return;
    return () => {
      props.onSaveActionChange?.(null);
      props.onCancelActionChange?.(null);
      props.onDirtyChange?.(false);
    };
  }, [isCreate, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange]);

  // ---- Resolve values ----
  const config = !isCreate ? ((props.agent.adapterConfig ?? {}) as Record<string, unknown>) : {};
  const runtimeConfig = !isCreate ? ((props.agent.runtimeConfig ?? {}) as Record<string, unknown>) : {};
  const heartbeat = !isCreate ? ((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>) : {};
  const debug = !isCreate ? ((runtimeConfig.debug ?? {}) as Record<string, unknown>) : {};

  const adapterType = isCreate
    ? props.values.adapterType
    : overlay.adapterType ?? props.agent.adapterType;
  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);
  const isLocal = adapterCaps.supportsInstructionsBundle || adapterCaps.supportsSkills || adapterCaps.supportsLocalAgentJwt;
  
  // The legacy working directory is an absolute path on the host, so the
  // managed-sandbox-only policy hides it. A stored value stays untouched; it is
  // inert while every run happens in the platform-managed environment.
  const showLegacyWorkingDirectoryField =
    isLocal
    && !hideHostPaths
    && shouldShowLegacyWorkingDirectoryField({ isCreate, adapterConfig: config });
  const uiAdapter = useMemo(() => getUIAdapter(adapterType), [adapterType]);
  const supportedEnvironmentDrivers = useMemo(
    () => new Set(supportedEnvironmentDriversForAdapter(adapterType)),
    [adapterType],
  );
  const val = isCreate ? props.values : null;
  const set = isCreate
    ? (patch: Partial<CreateConfigValues>) => props.onChange(patch)
    : null;

  // A Codex account binding points CODEX_HOME at a company secret. The
  // user-secret-definitions list in the cache is read once at page load, so it
  // can be stale after the bind. The bound row then compares its key against the
  // stale list and shows a false "no longer exists" health error. Invalidate the
  // list so the row reads the fresh definitions and clears the error.
  const invalidateUserSecretDefinitions = () => {
    if (!selectedCompanyId) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.secrets.userDefinitions(selectedCompanyId),
    });
  };

  // Edit mode: a Codex login that signed in to a DIFFERENT account than the
  // company default cannot take effect through the shared company home — the
  // promotion never displaces another account's claim there. Bind this
  // agent's CODEX_HOME to the login's account-home secret and persist it at
  // once, so no manual bind step remains.
  // Same-account logins skip the bind on purpose: the company-home refresh
  // already carried them, and an unbound agent keeps following the company
  // default across later credential rotations. No claim flag is needed —
  // the secret already exists company-scoped, so this is an ordinary
  // secret-reference binding through the normal agent-update patch.
  const handleCodexAccountBindingEdit = async (claim: CodexAccountBindingClaim) => {
    if (isCreate || !claim.companyIdentityDiffers) return;
    const flushedEnv = flushEnvironmentDraft();
    const baseEnv =
      flushedEnv ??
      (eff("adapterConfig", "env", (config.env ?? EMPTY_ENV) as Record<string, EnvBinding>));
    const nextEnv: Record<string, EnvBinding> = {
      ...baseEnv,
      CODEX_HOME: { type: "secret_ref", secretId: claim.secretId, version: "latest" },
    };
    const nextOverlay: AgentConfigOverlay = {
      ...overlay,
      adapterConfig: { ...overlay.adapterConfig, env: nextEnv },
    };
    setOverlay(nextOverlay);
    // This save runs in the background while the form stays editable. Record
    // exactly what it persists so the agent refresh it triggers keeps edits
    // made during the save (see the refresh effect) instead of wiping them
    // with the persisted entries. The in-flight flag protects the snapshot
    // from an unrelated refresh landing mid-save. A failed save never
    // refreshes the agent with the binding, so clear the snapshot there — a
    // later unrelated refresh then wipes normally.
    backgroundSaveOverlayRef.current = nextOverlay;
    backgroundSaveInFlightRef.current = true;
    try {
      await props.onSave(buildAgentUpdatePatch(props.agent, nextOverlay));
    } catch (err) {
      backgroundSaveOverlayRef.current = null;
      throw err;
    } finally {
      backgroundSaveInFlightRef.current = false;
    }
    invalidateUserSecretDefinitions();
  };

  const rawCurrentDefaultEnvironmentId = isCreate
    ? val!.defaultEnvironmentId ?? ""
    : eff("identity", "defaultEnvironmentId", props.agent.defaultEnvironmentId ?? "");
  const currentDefaultEnvironmentId = useMemo(() => {
    if (!rawCurrentDefaultEnvironmentId) return "";
    const selected = environments.find((environment) => environment.id === rawCurrentDefaultEnvironmentId) ?? null;
    return selected?.driver === "local" ? "" : rawCurrentDefaultEnvironmentId;
  }, [environments, rawCurrentDefaultEnvironmentId]);
  const currentDefaultEnvironment = useMemo(
    () => environments.find((environment) => environment.id === currentDefaultEnvironmentId) ?? null,
    [currentDefaultEnvironmentId, environments],
  );
  const instanceDefaultEnvironmentId = useMemo(() => {
    const environmentId = instanceSettings?.defaultEnvironmentId ?? null;
    if (!environmentId) return "";
    const selected = environments.find((environment) => environment.id === environmentId) ?? null;
    return selected?.driver === "local" ? "" : environmentId;
  }, [environments, instanceSettings?.defaultEnvironmentId]);
  const instanceDefaultEnvironment = useMemo(
    () => environments.find((environment) => environment.id === instanceDefaultEnvironmentId) ?? null,
    [environments, instanceDefaultEnvironmentId],
  );

  // The environment a login session runs in. It mirrors the Test resolution: the
  // agent's own environment wins, otherwise the instance default, otherwise the
  // local default. The login affordance shows only when this environment is a
  // sandbox, because the canonical auth-missing check comes only from a sandbox
  // target. The claude_local CLI sign-in status shows only when it is local.
  //
  // The resolution passes the same managed-sandbox-only policy inputs as the
  // adapter Test target, so both resolve to the same environment. Under the
  // policy a resolution that lands on the local environment redirects to the
  // managed sandbox the real run uses. Without the redirect the login target
  // stays local while the Test and the real run use the managed sandbox, so the
  // login affordance reads the wrong target. The resolver throws when the policy
  // is on but no managed sandbox is available; a render must not throw, so this
  // resolution catches that case and resolves no login environment. The Test
  // mutation surfaces the same case as a fail-closed error.
  const effectiveLoginEnvironmentId = useMemo(() => {
    try {
      return resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: rawCurrentDefaultEnvironmentId || null,
        instanceDefaultEnvironmentId: instanceSettings?.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(environments),
        managedSandboxOnly: experimentalSettings?.enableManagedSandboxOnly === true,
        managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(environments),
        // The policy hides the local environment, so an agent default that still
        // points at the hidden local row names no visible environment. Pass the
        // visible ids so the resolver redirects that stale local default to the
        // managed sandbox instead of the hidden local id.
        visibleEnvironmentIds: environments.map((environment) => environment.id),
      });
    } catch {
      return null;
    }
  }, [
    rawCurrentDefaultEnvironmentId,
    instanceSettings?.defaultEnvironmentId,
    environments,
    experimentalSettings?.enableManagedSandboxOnly,
  ]);
  const effectiveLoginEnvironment = useMemo(
    () => environments.find((environment) => environment.id === effectiveLoginEnvironmentId) ?? null,
    [environments, effectiveLoginEnvironmentId],
  );
  // Load the sandbox provider capabilities. A login that runs on a real
  // pseudo-terminal needs a provider that advertises the login pseudo-terminal
  // capability. The login panel gate reads this to hide the panel for a provider
  // without the capability. Enable the query when the adapter declares a login
  // capability: every login runs on a real pseudo-terminal, so every login
  // consults this data. The gate is advisory; the server resolves the capability
  // again and fails closed.
  const { data: environmentCapabilities } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.environments.capabilities(selectedCompanyId)
      : ["environment-capabilities", "none"],
    queryFn: () => environmentsApi.capabilities(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && adapterCaps.login != null,
  });

  // When the instance forces Kubernetes execution, new agents must default to the
  // managed Kubernetes sandbox environment (never the implicit local default).
  // Only applies in create mode and only once the K8s environment is loaded; if
  // none is available the UI surfaces a notice instead of silently selecting it.
  useEffect(() => {
    if (!isCreate || !set || !forcedKubernetes || !kubernetesEnvironment) return;
    if (currentDefaultEnvironmentId === kubernetesEnvironment.id) return;
    set({ defaultEnvironmentId: kubernetesEnvironment.id });
  }, [isCreate, set, forcedKubernetes, kubernetesEnvironment, currentDefaultEnvironmentId]);

  const runnableEnvironments = useMemo(
    () => environments.filter((environment) => {
      if (!supportedEnvironmentDrivers.has(environment.driver)) return false;
      if (environment.driver === "local") return false;
      if (environment.driver !== "sandbox") return true;
      const provider = typeof environment.config?.provider === "string" ? environment.config.provider : null;
      return provider !== null && provider !== "fake";
    }),
    [environments, supportedEnvironmentDrivers],
  );
  const environmentOptions = useMemo(() => {
    if (!currentDefaultEnvironment) return runnableEnvironments;
    if (runnableEnvironments.some((environment) => environment.id === currentDefaultEnvironment.id)) {
      return runnableEnvironments;
    }
    return [...runnableEnvironments, currentDefaultEnvironment];
  }, [currentDefaultEnvironment, runnableEnvironments]);
  // `runnableEnvironments` excludes the always-available Local environment, so a
  // single entry already means the user has more than one environment configured
  // (Local + that environment) and the override selector is meaningful.
  const showEnvironmentOverrideControl = environmentsEnabled && (
    forcedKubernetes ||
    currentDefaultEnvironmentId.length > 0 ||
    runnableEnvironments.length >= 1
  );
  const inheritedEnvironmentLabel = instanceDefaultEnvironment
    ? environmentDisplayLabel(instanceDefaultEnvironment)
    : managedSandboxOnly
      ? "Paperclip Computer"
      : "Local";

  const runnerProvider = adapterType === "paperclip_runner"
    ? String(isCreate ? props.values.adapterSchemaValues?.provider ?? "codex"
      : eff("adapterConfig", "provider", config.provider === "acpx" && config.acpxAgent === "codex" ? "codex" : config.provider ?? "codex"))
    : undefined;
  const modelProvider = adapterType === "opencode_local" && aiConnectionBindingSchema.safeParse(
    (overlay.runtime.runtimeConfig as Record<string, unknown> | undefined)?.aiConnection ?? runtimeConfig.aiConnection,
  ).data?.provider === "openrouter" ? "openrouter" : runnerProvider;
  // Fetch adapter models for the effective provider, including unsaved changes.
  const modelQueryKey = selectedCompanyId
    ? queryKeys.agents.adapterModels(selectedCompanyId, adapterType, currentDefaultEnvironmentId || null, modelProvider)
    : ["agents", "none", "adapter-models", adapterType];
  const {
    data: fetchedModels,
    error: fetchedModelsError,
  } = useQuery({
    queryKey: modelQueryKey,
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, adapterType, {
      environmentId: currentDefaultEnvironmentId || null,
      provider: modelProvider,
    }),
    enabled: Boolean(selectedCompanyId),
  });
  const [refreshModelsError, setRefreshModelsError] = useState<string | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const models = fetchedModels ?? externalModels ?? [];
  const adapterCommandField = "command";
  const {
    data: detectedModelData,
    refetch: refetchDetectedModel,
  } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.detectModel(selectedCompanyId, adapterType)
      : ["agents", "none", "detect-model", adapterType],
    queryFn: () => {
      if (!selectedCompanyId) {
        throw new Error("Select an organization to detect the model");
      }
      return agentsApi.detectModel(selectedCompanyId, adapterType);
    },
    enabled: Boolean(selectedCompanyId && isLocal && adapterType !== "opencode_local" && adapterType !== "paperclip_runner"),
  });
  const detectedModel = detectedModelData?.model ?? null;
  const detectedModelCandidates = detectedModelData?.candidates ?? [];

  const { data: companyAgents = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none", "list"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(!isCreate && selectedCompanyId),
  });

  /** Props passed to adapter-specific config field components */
  const adapterFieldProps = {
    mode,
    isCreate,
    adapterType,
    values: isCreate ? props.values : null,
    set: isCreate ? (patch: Partial<CreateConfigValues>) => props.onChange(patch) : null,
    config,
    eff: eff as <T>(group: "adapterConfig", field: string, original: T) => T,
    mark: mark as (group: "adapterConfig", field: string, value: unknown) => void,
    models,
    // Resolve the effective instructions-file gate once. The instructions file
    // is an absolute host path, so the managed-sandbox-only policy hides it for
    // every adapter without a per-adapter edit.
    hideInstructionsFile: hideInstructionsFile || hideHostPaths,
    managedSandboxOnly: hideHostPaths,
  };

  // Section toggle state — advanced always starts collapsed
  const [runPolicyAdvancedOpen, setRunPolicyAdvancedOpen] = useState(false);
  const [configurationAdvancedOpen, setConfigurationAdvancedOpen] = useState(false);
  const configSchema = useConfigSchema(adapterType);
  const renderAdapterFields = (section: AdapterConfigSection) => (
    <>
      {adapterType === "claude_local" && <ClaudeLocalAdvancedFields {...adapterFieldProps} section={section} />}
      <uiAdapter.ConfigFields {...adapterFieldProps} section={section} hideModel={isLocal} />
    </>
  );
  // Popover states
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingEffortOpen, setThinkingEffortOpen] = useState(false);

  function buildAdapterConfigForTest(adapterConfigPatch?: Record<string, unknown>): Record<string, unknown> {
    if (isCreate) {
      const next = uiAdapter.buildAdapterConfig(val!);
      if (adapterConfigPatch) {
        Object.assign(next, adapterConfigPatch);
      }
      return omitUndefinedEntries(next);
    }
    const base = config as Record<string, unknown>;
    const next = { ...base, ...overlay.adapterConfig };
    if (adapterConfigPatch) {
      Object.assign(next, adapterConfigPatch);
    }
    return omitUndefinedEntries(next);
  }

  const testEnvironment = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) {
        throw new Error("Select an organization to test adapter environment");
      }
      const flushedEnv = flushEnvironmentDraft();
      const adapterConfigPatch = flushedEnv ? { env: flushedEnv } : undefined;
      // Probe where a real run would actually execute: the agent's own
      // environment, else the instance default. Testing the host for an
      // agent that runs in the instance-default sandbox reports failures
      // (e.g. a CLI that only exists in the sandbox image) a real run would
      // never hit. The raw id is sent even for a local environment — the
      // server resolves the driver and probes the host in that case.
      //
      // Test can be clicked before the settings query settles (or after it
      // failed with retry:false), so when the agent relies on the instance
      // default, resolve the settings here rather than trusting the
      // render-time cache. A fetch that still fails FAILS the test with an
      // honest diagnostic — silently probing the host instead would report
      // the exact false command-not-found failure this resolution exists to
      // fix. Agents with their own environment never need the settings.
      let settings = instanceSettings;
      let environmentList = environments;
      let managedSandboxOnly = experimentalSettings?.enableManagedSandboxOnly === true;
      if (!rawCurrentDefaultEnvironmentId) {
        // The agent has no own environment, so the Test resolves the instance
        // default, the local default, or the managed sandbox. Resolve the
        // settings, the environment list, and the managed-sandbox-only policy
        // here, because the render-time queries can be unsettled, or the
        // environments query can be disabled under the managed-sandbox-only
        // policy. A failure surfaces an honest error, not a silent host probe
        // that reports a false result.
        try {
          const [resolvedSettings, resolvedEnvironments, resolvedExperimental] =
            await Promise.all([
              queryClient.ensureQueryData({
                queryKey: queryKeys.instance.settings,
                queryFn: () => instanceSettingsApi.get(),
              }),
              queryClient.ensureQueryData({
                queryKey: queryKeys.environments.list(selectedCompanyId),
                queryFn: () => environmentsApi.list(selectedCompanyId),
              }),
              queryClient.ensureQueryData({
                queryKey: queryKeys.instance.experimentalSettings,
                queryFn: () => instanceSettingsApi.getExperimental(),
              }),
            ]);
          settings = resolvedSettings;
          environmentList = resolvedEnvironments;
          managedSandboxOnly = resolvedExperimental?.enableManagedSandboxOnly === true;
        } catch {
          throw new Error(
            "Could not load environment settings to determine which environment to test in. Retry the test.",
          );
        }
      }
      // Mirror the server run-time resolution, including the managed-sandbox-only
      // redirect: when the resolution lands on the local environment and the
      // policy is on, probe the managed sandbox the real run uses instead. The
      // resolver throws when no managed sandbox is available, which the mutation
      // surfaces as a fail-closed error rather than a local host probe.
      const environmentId = resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: rawCurrentDefaultEnvironmentId || null,
        instanceDefaultEnvironmentId: settings?.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(environmentList),
        managedSandboxOnly,
        managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(environmentList),
        // The policy hides the local environment, so an agent default that still
        // points at the hidden local row names no visible environment. Pass the
        // visible ids so the resolver redirects that stale local default to the
        // managed sandbox instead of sending the hidden local id to the server.
        visibleEnvironmentIds: environmentList.map((environment) => environment.id),
      });
      const adapterConfig = buildAdapterConfigForTest(adapterConfigPatch);
      const agentId = isCreate ? undefined : props.agent.id;
      const aiConnection = isCreate ? undefined : aiConnectionBindingSchema.safeParse(
        (overlay.runtime.runtimeConfig as Record<string, unknown> | undefined)?.aiConnection ?? props.agent.runtimeConfig.aiConnection,
      ).data;
      if (props.compactTestFeedback) {
        const providerAdapter = adapterType === "paperclip_runner"
          ? adapterConfig.provider === "codex" ? "codex_local"
            : adapterConfig.provider === "acpx" && adapterConfig.acpxAgent === "claude" ? "claude_local"
              : adapterType
          : adapterType;
        return testAgentSetup({ companyId: selectedCompanyId, adapterType, providerAdapter, adapterConfig, agentId, aiConnection, environmentId });
      }
      return agentsApi.testEnvironment(selectedCompanyId, adapterType, { adapterConfig, agentId, aiConnection, environmentId });
    },
  });
  const [testActionPending, setTestActionPending] = useState(false);
  const [testActionError, setTestActionError] = useState<string | null>(null);
  const testActionLabel = "Test";
  const isSavePending = !isCreate && Boolean(props.isSaving);
  const testEnvironmentDisabled = testActionPending || isSavePending || !selectedCompanyId;

  // Drop a stale Test result when the adapter type or the effective environment
  // changes. A held result would keep the login affordance visible for a target
  // the user no longer selected. The reset unmounts the login panel too, so its
  // session state clears with it. Hold `reset` in a ref so the effect does not
  // re-run on every render (the mutation object has a new identity each render).
  const resetTestEnvironmentRef = useRef(testEnvironment.reset);
  resetTestEnvironmentRef.current = testEnvironment.reset;

  useEffect(() => {
    resetTestEnvironmentRef.current();
    setTestActionError(null);
  }, [adapterType, effectiveLoginEnvironmentId]);

  // Show the login affordance only for a current sandbox adapter that declares a
  // login capability, and whose most recent Test result carries the canonical
  // auth-missing check. The form reads the projected capability, not the adapter
  // name. The result keeps its own `adapterType`, so the form reads the
  // capability for that result adapter; a result from an adapter with no login
  // capability never gates the panel.
  const adapterSupportsSandboxLogin = adapterCaps.login != null;
  const testResult = testEnvironment.data;
  const testResultSupportsSandboxLogin =
    testResult != null && getCapabilities(testResult.adapterType).login != null;
  const authMissingCheck =
    testResult && testResultSupportsSandboxLogin
      ? testResult.checks.find((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE) ?? null
      : null;
  // A login runs on a real pseudo-terminal, so it needs a provider that
  // advertises the login pseudo-terminal capability. Read the capability for the
  // effective environment provider. The form reads the adapter login capability,
  // not the adapter name: every adapter login gates on this provider capability.
  const effectiveLoginProvider =
    typeof effectiveLoginEnvironment?.config?.provider === "string"
      ? effectiveLoginEnvironment.config.provider
      : null;
  const providerSupportsLoginPty =
    effectiveLoginProvider != null &&
    environmentCapabilities?.sandboxProviders?.[effectiveLoginProvider]?.supportsLoginPty === true;
  const loginNeedsPty = adapterCaps.login != null;
  const showAdapterLogin =
    (isCreate || !((overlay.runtime.runtimeConfig as Record<string, unknown> | undefined)?.aiConnection ?? runtimeConfig.aiConnection)) &&
    adapterSupportsSandboxLogin &&
    effectiveLoginEnvironment?.driver === "sandbox" &&
    Boolean(effectiveLoginEnvironmentId) &&
    Boolean(selectedCompanyId) &&
    Boolean(authMissingCheck) &&
    (!loginNeedsPty || providerSupportsLoginPty);
  // claude_local has no in-app login. A Claude subscription works only through
  // the claude CLI signed in on this server, so when a local Test reports that
  // the CLI is not signed in, show the CLI sign-in status and steps instead. A
  // sandbox or remote target needs ANTHROPIC_API_KEY, which the Test result
  // already says, so nothing extra shows there.
  const showClaudeCliSignInStatus =
    adapterType === "claude_local" &&
    Boolean(selectedCompanyId) &&
    testResult?.adapterType === "claude_local" &&
    testResult.checks.some(
      (check) =>
        check.code === "claude_hello_probe_auth_required" ||
        check.code === ADAPTER_AUTH_MISSING_CHECK_CODE,
    ) &&
    (!effectiveLoginEnvironmentId || effectiveLoginEnvironment?.driver === "local");
  const runEnvironmentTest = useCallback(async () => {
    if (!selectedCompanyId) {
      throw new Error("Select an organization to test adapter environment");
    }
    setTestActionPending(true);
    setTestActionError(null);
    testEnvironment.reset();
    try {
      return await testEnvironment.mutateAsync();
    } catch (error) {
      setTestActionError(error instanceof Error ? error.message : "Environment test failed");
      throw error;
    } finally {
      setTestActionPending(false);
    }
  }, [selectedCompanyId, testEnvironment]);
  // `runEnvironmentTest` (and `testEnvironmentDisabled`) change identity on every
  // render because `useMutation` returns a fresh result object each time. Hold the
  // latest behavior in a ref so the trigger handed to the parent stays referentially
  // stable — otherwise the `onTestActionChange` effect below re-runs every render,
  // pushing a new function into parent state and causing an infinite update loop.
  const triggerRef = useRef<() => void>(() => {});
  useEffect(() => {
    triggerRef.current = () => {
      if (testEnvironmentDisabled) return;
      void runEnvironmentTest().catch(() => undefined);
    };
  }, [runEnvironmentTest, testEnvironmentDisabled]);
  const triggerTestEnvironment = useCallback(() => {
    triggerRef.current();
  }, []);

  useEffect(() => {
    if (!showAdapterTestEnvironmentButton || !props.onTestActionChange) return;
    props.onTestActionChange(triggerTestEnvironment);
    return () => {
      props.onTestActionChange?.(null);
    };
  }, [showAdapterTestEnvironmentButton, props.onTestActionChange, triggerTestEnvironment]);

  useEffect(() => {
    if (!showAdapterTestEnvironmentButton || !props.onTestActionStateChange) return;
    props.onTestActionStateChange({
      disabled: testEnvironmentDisabled,
      pending: testActionPending,
    });
    return () => {
      props.onTestActionStateChange?.({ disabled: true, pending: false });
    };
  }, [
    showAdapterTestEnvironmentButton,
    props.onTestActionStateChange,
    testEnvironmentDisabled,
    testActionPending,
  ]);

  useEffect(() => {
    if (!props.onTestFeedbackChange) return;
    props.onTestFeedbackChange({
      errorMessage: testActionError
        ?? (testEnvironment.error instanceof Error
          ? testEnvironment.error.message
          : testEnvironment.error
            ? "Environment test failed"
            : null),
      result: testEnvironment.data ?? null,
      // `showAdapterLogin` already requires a selected company and a non-empty
      // environment id, so both are present here.
      login:
        showAdapterLogin && selectedCompanyId && effectiveLoginEnvironmentId
          ? { companyId: selectedCompanyId, adapterType, environmentId: effectiveLoginEnvironmentId }
          : null,
    });
    return () => {
      props.onTestFeedbackChange?.({ errorMessage: null, result: null, login: null });
    };
  }, [
    props.onTestFeedbackChange,
    testActionError,
    testEnvironment.data,
    testEnvironment.error,
    showAdapterLogin,
    selectedCompanyId,
    adapterType,
    effectiveLoginEnvironmentId,
  ]);

  // Current model for display
  const currentModelValue = isCreate
    ? val!.model ?? ""
    : eff("adapterConfig", "model", String(config.model ?? ""));
  const currentModelId = typeof currentModelValue === "string" ? currentModelValue : "";

  async function handleRefreshModels() {
    if (!selectedCompanyId) return;
    setRefreshingModels(true);
    setRefreshModelsError(null);
    try {
      const refreshed = await agentsApi.adapterModels(selectedCompanyId, adapterType, { refresh: true, environmentId: currentDefaultEnvironmentId || null, provider: modelProvider });
      queryClient.setQueryData(modelQueryKey, refreshed);
    } catch (error) {
      setRefreshModelsError(error instanceof Error ? error.message : "Failed to refresh adapter models.");
    } finally {
      setRefreshingModels(false);
    }
  }

  const thinkingEffortKey =
    adapterType === "codex_local"
      ? "modelReasoningEffort"
      : adapterType === "cursor"
        ? "mode"
        : adapterType === "opencode_local"
          ? "variant"
          : adapterType === "grok_local" ? "reasoningEffort"
          : adapterType === "pi_local" ? "thinking" : "effort";
  const thinkingEffortOptions =
    adapterType === "codex_local"
      ? codexReasoningEffortOptions(currentModelId, "Auto").map((option) => ({
          id: option.value,
          label: option.label,
        }))
      : adapterType === "cursor"
        ? cursorModeOptions
        : adapterType === "opencode_local"
          ? openCodeThinkingEffortOptions
          : adapterType === "kimi_local"
            ? kimiThinkingEffortOptions
            : adapterType === "pi_local"
              ? [{ id: "", label: "Auto" }, ...["off", "minimal", "low", "medium", "high", "xhigh"].map(id => ({ id, label: id }))]
              : adapterType === "claude_local" || adapterType === "grok_local"
                ? [{ id: "", label: "Auto" }, ...setupEfforts(adapterType, currentModelId).map((id) => ({
                    id,
                    label: id === "xhigh" ? "X-High" : id[0].toUpperCase() + id.slice(1),
                  }))]
                : claudeThinkingEffortOptions;
  const currentThinkingEffort = isCreate
    ? val!.thinkingEffort
    : adapterType === "codex_local"
      ? eff(
          "adapterConfig",
          "modelReasoningEffort",
          String(config.modelReasoningEffort ?? config.reasoningEffort ?? ""),
        )
      : adapterType === "cursor"
        ? eff("adapterConfig", "mode", String(config.mode ?? ""))
        : adapterType === "opencode_local"
          ? eff("adapterConfig", "variant", String(config.variant ?? ""))
          : eff("adapterConfig", thinkingEffortKey, String(config[thinkingEffortKey] ?? ""));
  const showThinkingEffort = adapterType !== "gemini_local"
    && adapterType !== "cursor_cloud"
    && adapterType !== "paperclip_runner";
  const codexSearchEnabled = adapterType === "codex_local"
    ? (isCreate ? Boolean(val!.search) : eff("adapterConfig", "search", Boolean(config.search)))
    : false;
  const effectiveRuntimeConfig = useMemo(() => {
    if (isCreate) {
      return {
        heartbeat: {
          enabled: val!.heartbeatEnabled,
          intervalSec: val!.intervalSec,
        },
      };
    }
    const mergedHeartbeat = {
      ...(runtimeConfig.heartbeat && typeof runtimeConfig.heartbeat === "object"
        ? runtimeConfig.heartbeat as Record<string, unknown>
        : {}),
      ...overlay.heartbeat,
    };
    return {
      ...runtimeConfig,
      heartbeat: mergedHeartbeat,
    };
  }, [isCreate, overlay.heartbeat, runtimeConfig, val]);
  const effectiveHeartbeat = asObject(effectiveRuntimeConfig.heartbeat);
  const maxTurnContinuation = asObject(effectiveHeartbeat.maxTurnContinuation);
  const maxTurnContinuationEnabled = asBoolean(maxTurnContinuation.enabled, true);
  const maxTurnContinuationMaxAttempts = clampInteger(
    asFiniteNumber(maxTurnContinuation.maxAttempts, MAX_TURN_CONTINUATION_DEFAULT_MAX_ATTEMPTS),
    0,
    MAX_TURN_CONTINUATION_MAX_ATTEMPTS_CAP,
  );
  const maxTurnContinuationDelaySec = clampInteger(
    asFiniteNumber(maxTurnContinuation.delayMs, MAX_TURN_CONTINUATION_DEFAULT_DELAY_SEC * 1000) / 1000,
    0,
    MAX_TURN_CONTINUATION_MAX_DELAY_SEC,
  );

  function updateMaxTurnContinuation(patch: Record<string, unknown>) {
    mark("heartbeat", "maxTurnContinuation", {
      ...maxTurnContinuation,
      ...patch,
    });
  }

  const environmentVariablesEditor = (
    <EnvironmentVariablesEditor
      ref={environmentVariablesEditorRef}
      key={environmentEditorKey}
      onDirtyChange={setEnvironmentDraftDirty}
      hideDraftActions={!isCreate && props.hideInlineSave}
      value={
        isCreate
          ? ((val!.envBindings ?? EMPTY_ENV) as Record<string, EnvBinding>)
          : (eff("adapterConfig", "env", (config.env ?? EMPTY_ENV) as Record<string, EnvBinding>))
      }
      secrets={availableSecrets}
      userSecretDefinitions={userSecretDefinitions}
      onCreateSecret={async (name, value) => {
        const created = await createSecret.mutateAsync({ name, value });
        return created;
      }}
      onChange={(env) =>
        isCreate
          ? set!({ envBindings: env ?? {}, envVars: "" })
          : mark("adapterConfig", "env", env)
      }
    />
  );


  if (!isCreate && props.content === "secrets") {
    return (
      <div className={cn("relative", cards && "space-y-6")}>
        {isDirty && !props.hideInlineSave && (
          <div className="sticky top-0 z-10 flex items-center justify-end border-b border-primary/20 bg-background/90 px-4 py-2 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
              <Button size="sm" onClick={handleSave} disabled={props.isSaving}>
                {props.isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        )}

        {props.environmentVariablesPlacement === "secrets" && (
          <div data-config-section="environment-variables" className={cn(!cards && "border-b border-border")}>
            {cards
              ? <h3 className="mb-3 text-sm font-medium">Environment variables</h3>
              : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Environment variables</div>
            }
            <div className={cn(cards ? "rounded-lg border border-border p-4" : "px-4 pb-3")}>
              {environmentVariablesEditor}
            </div>
          </div>
        )}

        <div data-config-section="secrets" className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="mb-3 text-sm font-medium">Secret access</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Secret access</div>
          }
          <div className={cn(cards ? "space-y-3 rounded-lg border border-border p-4" : "space-y-3 px-4 pb-3")}>
            <p className="text-xs text-muted-foreground">{help.secretAccess}</p>
            <AgentSecretAccessEditor
              config={{ ...config, ...overlay.adapterConfig }}
              secrets={availableSecrets}
              onChange={applyAccessGrants}
              onCreateSecret={(name, value) => createSecret.mutateAsync({ name, value })}
              proposals={agentBindingProposals}
              onApproveProposal={proposalReview.requestApprove}
              onRejectProposal={proposalReview.requestReject}
            />
            {proposalReview.dialogs}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ConfigSections order={props.sectionOrder} className={cn("relative", cards && "space-y-6")}>
      {/* ---- Floating Save button (edit mode, when dirty) ---- */}
      {isDirty && !props.hideInlineSave && (
        <div className="sticky top-0 z-10 flex items-center justify-end px-4 py-2 bg-background/90 backdrop-blur-sm border-b border-primary/20">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!isCreate && props.isSaving}
            >
              {!isCreate && props.isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* ---- Identity (edit only) ---- */}
      {!isCreate && (
        <div data-config-section="identity" className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">{props.sectionTitles?.["identity"] ?? "Identity"}</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Identity</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field label="Name" hint={help.name}>
              <DraftInput
                value={eff("identity", "name", props.agent.name)}
                onCommit={(v) => mark("identity", "name", v)}
                immediate
                className={inputClass}
                placeholder="Agent name"
              />
            </Field>
            <Field label="Title" hint={help.title}>
              <DraftInput
                value={eff("identity", "title", props.agent.title ?? "")}
                onCommit={(v) => mark("identity", "title", v || null)}
                immediate
                className={inputClass}
                placeholder="e.g. VP of Engineering"
              />
            </Field>
            <Field label="Reports to" hint={help.reportsTo}>
              <ReportsToPicker
                agents={companyAgents}
                value={eff("identity", "reportsTo", props.agent.reportsTo ?? null)}
                onChange={(id) => mark("identity", "reportsTo", id)}
                excludeAgentIds={[props.agent.id]}
                chooseLabel="Choose manager…"
              />
            </Field>
            {isLocal && !props.hidePromptTemplate && (
              <>
                <Field label="Prompt Template" hint={help.promptTemplate}>
                  <MarkdownEditor
                    value={eff(
                      "adapterConfig",
                      "promptTemplate",
                      String(config.promptTemplate ?? ""),
                    )}
                    onChange={(v) => mark("adapterConfig", "promptTemplate", v ?? "")}
                    placeholder="You are agent {{ agent.name }}. Your role is {{ agent.role }}..."
                    contentClassName="min-h-(--sz-88px) text-sm font-mono"
                    imageUploadHandler={async (file) => {
                      const namespace = `agents/${props.agent.id}/prompt-template`;
                      const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                      return asset.contentPath;
                    }}
                  />
                </Field>
                <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                  Prompt template is replayed on every heartbeat. Keep it compact and dynamic to avoid recurring token cost and cache churn.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- Execution ---- */}
      {forcedKubernetes ? (
        // Instance execution policy forces the managed Kubernetes sandbox
        // (executionMode=kubernetes): never offer local / non-Kubernetes targets.
        // Render the environment read-only instead of the selectable picker.
        <div data-config-section="environment" className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Environment</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Environment</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field
              label="Default environment"
              hint="This instance runs all agents in the Kubernetes sandbox. Local execution is disabled."
            >
              {kubernetesEnvironment ? (
                <div className={cn(inputClass, "flex items-center text-muted-foreground")}>
                  {kubernetesEnvironment.name} · Kubernetes sandbox
                </div>
              ) : (
                <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                  This instance requires the Kubernetes sandbox, but no managed Kubernetes
                  environment is available for this organization yet. Configure one before creating
                  agents; execution will not fall back to local.
                </div>
              )}
            </Field>
          </div>
        </div>
      ) : showEnvironmentOverrideControl ? (
        <div data-config-section="environment" className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Environment</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Environment</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field label="Environment override">
              <div className="space-y-2">
                <select
                  className={inputClass}
                  value={currentDefaultEnvironmentId}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (isCreate) {
                      set!({ defaultEnvironmentId: nextValue });
                      return;
                    }
                    mark("identity", "defaultEnvironmentId", nextValue || null);
                  }}
                >
                  <option value="">Default: {inheritedEnvironmentLabel}</option>
                  {environmentOptions.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environmentDisplayLabel(environment)}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </div>
        </div>
      ) : null}

      {/* ---- Adapter ---- */}
      <div data-config-section="adapter" className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
        <div className={cn(cards ? "flex items-center justify-between mb-3" : "px-4 py-2 flex items-center justify-between gap-2")}>
          {cards
            ? <h3 className="text-sm font-medium">{props.sectionTitles?.["adapter"] ?? "Adapter"}</h3>
            : <span className="text-xs font-medium text-muted-foreground">Adapter</span>
          }
          {showInlineAdapterTestEnvironmentButton && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={triggerTestEnvironment}
              disabled={testEnvironmentDisabled}
            >
              {testActionPending ? `${testActionLabel}...` : testActionLabel}
            </Button>
          )}
        </div>
        <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
          {showAdapterTypeField && (
            <Field label="Adapter type" hint={help.adapterType}>
              <AdapterTypeDropdown
                value={adapterType}
                disabledTypes={adapterPickerDisabledTypes}
                onChange={(t) => {
                  if (isCreate) {
                    // Reset all adapter-specific fields to defaults when switching adapter type
                    const { adapterType: _at, ...defaults } = defaultCreateValues;
                    const nextValues: CreateConfigValues = { ...defaults, adapterType: t };
                    if (t === "codex_local") {
                      nextValues.dangerouslyBypassSandbox =
                        DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
                    } else if (t === "gemini_local") {
                      nextValues.model = DEFAULT_GEMINI_LOCAL_MODEL;
                    } else if (t === "kimi_local") {
                      nextValues.model = DEFAULT_KIMI_LOCAL_MODEL;
                    } else if (t === "cursor") {
                      nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
                    } else if (t === "opencode_local") {
                      nextValues.model = DEFAULT_OPENCODE_LOCAL_MODEL;
                    } else if (t === "paperclip_runner") {
                      nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
                    }
                    set!(nextValues);
                  } else {
                    // Clear all adapter config and explicitly blank out model + effort/mode keys
                    // so the old adapter's values don't bleed through via eff()
                    setOverlay((prev) => ({
                      ...prev,
                      adapterType: t,
                      adapterConfig: {
                        model:
                          t === "gemini_local"
                            ? DEFAULT_GEMINI_LOCAL_MODEL
                            : t === "kimi_local"
                              ? DEFAULT_KIMI_LOCAL_MODEL
                            : t === "opencode_local"
                              ? DEFAULT_OPENCODE_LOCAL_MODEL
                            : t === "cursor"
                              ? DEFAULT_CURSOR_LOCAL_MODEL
                            : t === "paperclip_runner"
                              ? resolvePaperclipRunnerTransitionModel(adapterType, config.model)
                              : "",
                        effort: "",
                        modelReasoningEffort: "",
                        variant: "",
                        mode: "",
                        ...(t === "codex_local"
                          ? {
                              dangerouslyBypassApprovalsAndSandbox:
                                DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
                            }
                          : t === "paperclip_runner"
                            ? {
                                ...paperclipRunnerTransitionConfig(adapterType, eff("adapterConfig", "model", config.model)),
                              }
                          : {}),
                      },
                    }));
                  }
                }}
              />
            </Field>
          )}

          {!isCreate && selectedCompanyId && <AiConnectionField companyId={selectedCompanyId} agentId={props.agent.id} agentName={props.agent.name} adapterType={adapterType === "paperclip_runner" ? eff("adapterConfig", "provider", config.provider) === "codex" ? "codex_local" : eff("adapterConfig", "provider", config.provider) === "opencode" ? "opencode_local" : eff("adapterConfig", "provider", config.provider) === "acpx" && eff("adapterConfig", "acpxAgent", config.acpxAgent) === "claude" ? "claude_local" : adapterType : adapterType}
            value={aiConnectionBindingSchema.safeParse((overlay.runtime.runtimeConfig as Record<string, unknown> | undefined)?.aiConnection ?? runtimeConfig.aiConnection).data}
            model={String(eff("adapterConfig", "model", config.model) ?? "")} environmentId={currentDefaultEnvironmentId || undefined} legacy
            onChange={binding => mark("runtime", "runtimeConfig", { ...runtimeConfig, aiConnection: binding })} />}

          {showInlineAdapterTestEnvironmentFeedback && !props.compactTestFeedback && (testActionError || testEnvironment.error) && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {testActionError
                ?? (testEnvironment.error instanceof Error
                  ? testEnvironment.error.message
                  : "Environment test failed")}
            </div>
          )}

          {showInlineAdapterTestEnvironmentFeedback && !props.compactTestFeedback && testEnvironment.data && (
            <AdapterEnvironmentResult result={testEnvironment.data} />
          )}

          {showInlineAdapterTestEnvironmentFeedback && showAdapterLogin && (
            <AdapterLoginPanel
              key={`${adapterType}:${effectiveLoginEnvironmentId}`}
              companyId={selectedCompanyId!}
              adapterType={adapterType}
              environmentId={effectiveLoginEnvironmentId!}
              onAccountBinding={isCreate ? undefined : handleCodexAccountBindingEdit}
            />
          )}

          {showInlineAdapterTestEnvironmentFeedback && showClaudeCliSignInStatus && (
            <ClaudeCliSignInStatus companyId={selectedCompanyId} />
          )}

          {/* Working directory */}
          {showLegacyWorkingDirectoryField && (
            <Field label="Working directory (deprecated)" hint={help.cwd}>
              <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <DraftInput
                  value={
                    isCreate
                      ? val!.cwd
                      : eff("adapterConfig", "cwd", String(config.cwd ?? ""))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ cwd: v })
                      : mark("adapterConfig", "cwd", v || undefined)
                  }
                  immediate
                  className="w-full bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40"
                  placeholder="/path/to/project"
                />
                <ChoosePathButton />
              </div>
            </Field>
          )}

          {renderAdapterFields("adapter")}
          {isLocal && (<>
              <ModelDropdown
                models={models}
                value={currentModelId}
                onChange={(v) => {
                  const supportedEfforts = setupEfforts(adapterType, v);
                  const clearUnsupportedEffort = ["codex_local", "claude_local", "grok_local"].includes(adapterType)
                    && Boolean(currentThinkingEffort)
                    && !supportedEfforts.includes(String(currentThinkingEffort));
                  if (isCreate) {
                    set!({
                      model: v,
                      ...(clearUnsupportedEffort ? { thinkingEffort: "" } : {}),
                    });
                    return;
                  }
                  mark("adapterConfig", "model", v || undefined);
                  if (clearUnsupportedEffort) {
                    mark("adapterConfig", thinkingEffortKey, undefined);
                    mark("adapterConfig", "reasoningEffort", undefined);
                  }
                }}
                open={modelOpen}
                onOpenChange={setModelOpen}
                defaultLabel={adapterType === "claude_local" ? `Default (${DEFAULT_CLAUDE_LOCAL_MODEL})` : undefined}
                allowDefault={adapterType !== "opencode_local" && adapterType !== "pi_local" && adapterType !== "paperclip_runner"}
                required={adapterType === "opencode_local" || adapterType === "pi_local"}
                groupByProvider={adapterType === "opencode_local" || adapterType === "pi_local"}
                creatable
                detectedModel={detectedModel}
                detectedModelCandidates={[]}
                onDetectModel={adapterType === "opencode_local" || adapterType === "paperclip_runner"
                  ? undefined
                  : async () => {
                      const result = await refetchDetectedModel();
                      return result.data?.model ?? null;
                    }}
                onRefreshModels={
                  supportsAdapterModelRefresh(adapterType)
                    ? handleRefreshModels
                    : undefined
                }
                refreshingModels={refreshingModels}
                detectModelLabel="Detect model"
                emptyDetectHint="No model detected. Select or enter one manually."
              />
              {(refreshModelsError || fetchedModelsError) && (
                <p className="text-xs text-destructive">
                  {refreshModelsError
                    ?? (fetchedModelsError instanceof Error
                      ? fetchedModelsError.message
                      : "Failed to load adapter models.")}
                </p>
              )}
              {adapterType === "opencode_local"
                && currentDefaultEnvironment
                && currentDefaultEnvironment.driver !== "local" && (
                <p className="text-xs text-muted-foreground">
                  Live OpenCode model discovery only runs for Local environments. Using the curated list and manual entry for {currentDefaultEnvironment.name}.
                </p>
              )}

              {showThinkingEffort && (
                <>
                  <ThinkingEffortDropdown
                    value={currentThinkingEffort}
                    options={thinkingEffortOptions}
                    onChange={(v) =>
                      isCreate
                        ? set!({ thinkingEffort: v })
                        : mark("adapterConfig", thinkingEffortKey, v || undefined)
                    }
                    open={thinkingEffortOpen}
                    onOpenChange={setThinkingEffortOpen}
                  />
                  {adapterType === "codex_local" &&
                    codexSearchEnabled &&
                    currentThinkingEffort === "minimal" && (
                      <p className="text-xs text-amber-400">
                        Codex may reject `minimal` thinking when search is enabled.
                      </p>
                    )}
                </>
              )}
          </>)}
        </div>

      </div>

      {/* ---- Configuration ---- */}
      {(
        <div data-config-section="configuration" className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Configuration</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Configuration</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
              {!isCreate && typeof config.bootstrapPromptTemplate === "string" && config.bootstrapPromptTemplate && (
                <>
                  <Field label="Bootstrap prompt (legacy)" hint={help.bootstrapPrompt}>
                    <MarkdownEditor
                      value={eff(
                        "adapterConfig",
                        "bootstrapPromptTemplate",
                        String(config.bootstrapPromptTemplate ?? ""),
                      )}
                      onChange={(v) =>
                        mark("adapterConfig", "bootstrapPromptTemplate", v || undefined)
                      }
                      placeholder="Optional initial setup prompt for the first run"
                      contentClassName="min-h-(--sz-44px) text-sm font-mono"
                      imageUploadHandler={async (file) => {
                        const namespace = `agents/${props.agent.id}/bootstrap-prompt`;
                        const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                        return asset.contentPath;
                      }}
                    />
                  </Field>
                  <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    Bootstrap prompt is legacy and will be removed in a future release. Consider moving this content into the agent&apos;s prompt template or instructions file instead.
                  </div>
                </>
              )}
              {renderAdapterFields("configuration")}
              {(isLocal || adapterType === "process" || configSchema?.fields.some((field) => schemaFieldSection(field.key) === "advanced")) && (
              <CollapsibleSection
                title="Advanced"
                open={configurationAdvancedOpen}
                onToggle={() => setConfigurationAdvancedOpen(!configurationAdvancedOpen)}
              >
                <div className="space-y-3">
                  {isLocal && (<>              {/*
                The command names a binary on the execution host, so the
                managed-sandbox-only policy hides it: the platform-managed image
                owns the binary. Hiding is presentation only. A stored
                `adapterConfig.command` stays as it is and the server does not
                reject one, because an import carries adapter configuration
                written on another instance; rejecting it would break that flow.
                The value is inert while the policy is on. The field also stays
                hidden until the policy is known, so a stored command never
                flashes on a managed instance.
              */}
              {!hideHostPaths && (
                <Field label="Command" hint={help.localCommand}>
                  <DraftInput
                    value={
                      isCreate
                        ? val!.command
                        : eff(
                            "adapterConfig",
                            adapterCommandField,
                            String(
                              config.command ?? "",
                            ),
                          )
                    }
                    onCommit={(v) =>
                      isCreate
                        ? set!({ command: v })
                        : mark("adapterConfig", adapterCommandField, v || null)
                    }
                    immediate
                    className={inputClass}
                    placeholder={
                      ({
                        claude_local: "claude",
                        codex_local: "codex",
                        gemini_local: "gemini",
                        kimi_local: "kimi",
                        pi_local: "pi",
                        cursor: "agent",
                        opencode_local: "opencode",
                      } as Record<string, string>)[adapterType] ?? adapterType.replace(/_local$/, "")
                    }
                  />
                </Field>
              )}

              <Field label="Extra args (comma-separated)" hint={help.extraArgs}>
                <DraftInput
                  value={
                    isCreate
                      ? val!.extraArgs
                      : eff("adapterConfig", "extraArgs", formatArgList(config.extraArgs))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ extraArgs: v })
                      : mark("adapterConfig", "extraArgs", v?.trim() ? parseCommaArgs(v) : null)
                  }
                  className={inputClass}
                  placeholder="e.g. --verbose, --foo=bar"
                />
              </Field>

                  </>)}
                  {renderAdapterFields("advanced")}
                </div>
              </CollapsibleSection>
              )}

          </div>
        </div>
      )}

      {props.environmentVariablesPlacement !== "secrets" && (isLocal || configSchema?.fields.some((field) => schemaFieldSection(field.key) === "environment")) && (
        <div data-config-section="environment-variables" className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Environment variables</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Environment variables</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            {isLocal ? environmentVariablesEditor : renderAdapterFields("environment")}
          </div>
        </div>
      )}

      {/* ---- Run Policy ---- */}
      {isCreate && showCreateRunPolicySection ? (
        <div data-config-section="run-policy" className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium flex items-center gap-2 mb-3"><Heart className="h-3 w-3" /> Run Policy</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground flex items-center gap-2"><Heart className="h-3 w-3" /> Run Policy</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <ToggleWithNumber
              label="Heartbeat on interval"
              hint={help.heartbeatInterval}
              checked={val!.heartbeatEnabled}
              onCheckedChange={(v) => set!({ heartbeatEnabled: v })}
              number={val!.intervalSec}
              onNumberChange={(v) => set!({ intervalSec: v })}
              numberLabel="sec"
              numberPrefix="Run heartbeat every"
              numberHint={help.intervalSec}
              showNumber={val!.heartbeatEnabled}
            />
            <CollapsibleSection title="Advanced Run Policy" open={runPolicyAdvancedOpen} onToggle={() => setRunPolicyAdvancedOpen(!runPolicyAdvancedOpen)}>
              <div className="space-y-3">{renderAdapterFields("runPolicy")}</div>
            </CollapsibleSection>
          </div>
        </div>
      ) : !isCreate ? (
        <div data-config-section="run-policy" className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium flex items-center gap-2 mb-3"><Heart className="h-3 w-3" /> Run Policy</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground flex items-center gap-2"><Heart className="h-3 w-3" /> Run Policy</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg overflow-hidden" : "")}>
            <div className={cn(cards ? "p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
              <ToggleWithNumber
                label="Heartbeat on interval"
                hint={help.heartbeatInterval}
                checked={eff("heartbeat", "enabled", heartbeat.enabled === true)}
                onCheckedChange={(v) => mark("heartbeat", "enabled", v)}
                number={eff("heartbeat", "intervalSec", Number(heartbeat.intervalSec ?? 300))}
                onNumberChange={(v) => mark("heartbeat", "intervalSec", v)}
                numberLabel="sec"
                numberPrefix="Run heartbeat every"
                numberHint={help.intervalSec}
                showNumber={eff("heartbeat", "enabled", heartbeat.enabled === true)}
              />
            </div>
            <CollapsibleSection
              title="Advanced Run Policy"
              bordered={cards}
              open={runPolicyAdvancedOpen}
              onToggle={() => setRunPolicyAdvancedOpen(!runPolicyAdvancedOpen)}
            >
            <div className="space-y-3">
              {renderAdapterFields("runPolicy")}
              {isLocal && (<>
              {/* Edit-only: timeout + grace period */}
              {!isCreate && (
                <>
                  {!configSchema?.fields.some((field) => field.key === "timeoutSec") && (
                  <Field label="Timeout (sec)" hint={help.timeoutSec}>
                    <DraftNumberInput
                      value={eff(
                        "adapterConfig",
                        "timeoutSec",
                        Number(config.timeoutSec ?? 0),
                      )}
                      onCommit={(v) => mark("adapterConfig", "timeoutSec", v)}
                      immediate
                      className={inputClass}
                    />
                  </Field>
                  )}
                  {!configSchema?.fields.some((field) => field.key === "graceSec") && (
                  <Field label="Interrupt grace period (sec)" hint={help.graceSec}>
                    <DraftNumberInput
                      value={eff(
                        "adapterConfig",
                        "graceSec",
                        Number(config.graceSec ?? 15),
                      )}
                      onCommit={(v) => mark("adapterConfig", "graceSec", v)}
                      immediate
                      className={inputClass}
                    />
                  </Field>
                  )}
                </>
              )}
              </>)}
              <ToggleField
                label="Wake on demand"
                hint={help.wakeOnDemand}
                checked={eff(
                  "heartbeat",
                  "wakeOnDemand",
                  heartbeat.wakeOnDemand !== false,
                )}
                onChange={(v) => mark("heartbeat", "wakeOnDemand", v)}
              />
              <Field label="Cooldown (sec)" hint={help.cooldownSec}>
                <DraftNumberInput
                  value={eff(
                    "heartbeat",
                    "cooldownSec",
                    Number(heartbeat.cooldownSec ?? 10),
                  )}
                  onCommit={(v) => mark("heartbeat", "cooldownSec", v)}
                  immediate
                  className={inputClass}
                />
              </Field>
              <Field label="Max concurrent runs" hint={help.maxConcurrentRuns}>
                <DraftNumberInput
                  value={eff(
                    "heartbeat",
                    "maxConcurrentRuns",
                    Number(heartbeat.maxConcurrentRuns ?? AGENT_DEFAULT_MAX_CONCURRENT_RUNS),
                  )}
                  onCommit={(v) => mark("heartbeat", "maxConcurrentRuns", v)}
                  immediate
                  className={inputClass}
                />
              </Field>
              <div className="rounded-md border border-border/70 px-3 py-2">
                <ToggleField
                  label="Continue after max-turn stop"
                  hint={help.maxTurnContinuationEnabled}
                  checked={maxTurnContinuationEnabled}
                  onChange={(v) => updateMaxTurnContinuation({ enabled: v })}
                />
                {maxTurnContinuationEnabled ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Continuation attempts" hint={help.maxTurnContinuationMaxAttempts}>
                      <DraftNumberInput
                        value={maxTurnContinuationMaxAttempts}
                        onCommit={(v) =>
                          updateMaxTurnContinuation({
                            maxAttempts: clampInteger(v, 0, MAX_TURN_CONTINUATION_MAX_ATTEMPTS_CAP),
                          })}
                        immediate
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Continuation delay (sec)" hint={help.maxTurnContinuationDelaySec}>
                      <DraftNumberInput
                        value={maxTurnContinuationDelaySec}
                        onCommit={(v) =>
                          updateMaxTurnContinuation({
                            delayMs: clampDelayMsFromSeconds(v),
                          })}
                        immediate
                        className={inputClass}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            </div>
          </CollapsibleSection>
          </div>
        </div>
      ) : null}

      {/* ---- Debugging ---- */}
      {!isCreate && canConfigureProviderTrace ? (
        <div className={cn(!cards && "border-b border-border")}>
          {cards ? (
            <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Bug className="h-3 w-3" /> Debugging
            </h3>
          ) : (
            <div className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground">
              <Bug className="h-3 w-3" /> Debugging
            </div>
          )}
          <div
            className={cn(
              "border-border bg-accent/30",
              cards
                ? "rounded-lg border p-4"
                : "mx-4 mb-4 rounded-md border px-3 py-3",
            )}
          >
            <ToggleField
              label="Capture raw provider traces"
              hint="Stores exact provider traffic for every future run until disabled. Traces may contain sensitive prompts and tool arguments, are administrator-only, and expire after 24 hours."
              checked={eff<unknown>("debug", "providerTrace", debug.providerTrace) === "raw"}
              onChange={(enabled) =>
                mark("debug", "providerTrace", enabled ? "raw" : undefined)
              }
            />
            {eff<unknown>("debug", "providerTrace", debug.providerTrace) === "raw" ? (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-xs text-foreground">
                <Bug className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Raw tracing is on for future runs. Paperclip keeps at most 64 MiB per run and automatically deletes it after 24 hours.
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {props.compactTestFeedback && showInlineAdapterTestEnvironmentFeedback && showAdapterTestEnvironmentButton && (
        <RuntimeTestCard
          state={testActionPending ? "running" : testActionError || testEnvironment.error ? "fail" : testResult?.status ?? "idle"}
          result={testResult ?? null}
          error={testActionError ?? (testEnvironment.error instanceof Error ? testEnvironment.error.message : null)}
          onTest={triggerTestEnvironment}
          disabled={testEnvironmentDisabled}
        />
      )}
    </ConfigSections>
  );
}

// The public session states that end a login. The panel stops the status poll
// and shows a terminal message when the session reaches one of these.
const ADAPTER_LOGIN_TERMINAL_STATUSES = new Set<AdapterAuthSessionStatus>([
  "authenticated",
  "failed",
  "timed_out",
  "cancelled",
]);

// The status route poll interval while a session is active (Decision A). The
// poll stops at a terminal state.
const ADAPTER_LOGIN_POLL_INTERVAL_MS = 2000;

// A copy-to-clipboard button. It mirrors the workspace service control bar: a
// short "copied" flash, then it returns to the copy icon.
function AdapterLoginCopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:text-foreground"
      onClick={async () => {
        try {
          await copyTextToClipboard(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </Button>
  );
}

// The terminal message for a finished login. It never shows a secret. It shows
// only the fixed, non-secret failure message the server returns.
function AdapterLoginTerminalState({
  status,
  message,
}: {
  status: AdapterAuthSessionStatus;
  message: string | null;
}) {
  if (status === "authenticated") {
    return (
      <div className="flex items-center gap-2 text-(length:--text-micro) text-foreground">
        <Check className="size-3 shrink-0" />
        <span>Authenticated. The environment has credentials now.</span>
      </div>
    );
  }
  const label =
    status === "timed_out"
      ? "Login timed out"
      : status === "cancelled"
        ? "Login cancelled"
        : "Login failed";
  return (
    <div className="flex items-start gap-2 text-(length:--text-micro) text-destructive">
      <TriangleAlert className="size-3 shrink-0" />
      <span>
        {label}
        {message ? `: ${message}` : "."}
      </span>
    </div>
  );
}

// The login panel for one adapter in one sandbox environment. It starts a login
// session, polls the status route, and shows the one-time code and the
// authentication URL with copy and open actions. It shows the terminal states.
// It never writes the code, the URL, or any credential byte to a log line.
//
// The panel holds its own session state. The parent gives it a stable `key` from
// the adapter type and the environment id, so a change to either remounts the
// panel with a fresh session state.
// The props that identify one login panel: one adapter in one sandbox
// environment for one company. A parent that lifts the test feedback renders
// the panel from this descriptor.
export type AdapterLoginDescriptor = {
  companyId: string;
  adapterType: string;
  environmentId: string;
};

// The panel props. `autoStart`, `onConnected`, `onPromptReady` and `chrome` are
// what the onboarding connect step needs, and each is off or absent by default
// so the two settings surfaces that render this panel keep the behaviour they
// have.
//
// They are props on the existing panel rather than a second implementation
// because the part onboarding needs unchanged is the whole of it: the session
// start, the resume read, the status poll and the cleanup paths. A copy drawn
// to the new design would have had to reproduce all of that correctly, and the
// first thing to rot would have been the resume and cleanup paths, which are
// the ones nobody exercises by hand.
export type AdapterLoginPanelProps = AdapterLoginDescriptor & {
  aiConnection?: import("@paperclipai/shared").AiConnectionLoginIntent;
  // Applies the non-secret Codex account-binding claim from an authenticated
  // owner read: the company secret that names the signed-in account's own
  // home. The panel calls this only when the company default home stayed on a
  // DIFFERENT account — the one case where the login cannot take effect
  // through the shared company home — and it AWAITS the handler, rendering
  // saving/bound/failed states with an explicit Retry on failure, so a
  // rejected save is never silently swallowed. The claim never carries a
  // token byte or an account identifier.
  onAccountBinding?: (claim: CodexAccountBindingClaim) => void | Promise<void>;
  // Start the login on mount instead of waiting for a press. The connect step's
  // footer button is the press — by the time the panel is rendered there, the
  // customer has already asked for this.
  autoStart?: boolean;
  // The login reached its success state. Onboarding advances on this, which is
  // why the `onboarding` chrome draws no success state of its own — the screen
  // it would appear on is already gone.
  onConnected?: (sessionId?: string) => void;
  chrome?: AdapterLoginChrome;
  /**
   * The address the customer has to open, once the server has produced one.
   *
   * The one fact about a running login that the step needs outside the card:
   * its own button is what sends the customer there, and a prompt arriving is
   * what moves the step from waiting to ready. How the login ended is reported
   * through `onConnected`, so this stays a single value rather than a whole
   * session handed upward.
   */
  onPromptReady?: (authorizationUrl: string | null) => void;
};

/**
 * The account a source signs in to, named where one is known.
 *
 * "Sign in to the environment" describes the plumbing — a login performed inside
 * a sandbox — and is the honest label when the provider is unknown. For a
 * source listed here the customer is signing in to that provider, and naming it
 * is what tells them which password manager entry to reach for. The generic
 * wording stays for anything not listed, where a guess would be worse than a
 * description.
 */
const ADAPTER_LOGIN_PROVIDER: Record<string, string> = {
  codex_local: "OpenAI",
};

function adapterLoginTitle(adapterType: string): string {
  const provider = ADAPTER_LOGIN_PROVIDER[adapterType];
  return provider ? `Sign in to ${provider}` : "Sign in to the environment";
}

// The login panel. Every adapter login capability uses the displayed-code
// flow: the server shows a one-time code and an authentication URL, and the
// customer enters the code on the provider's page.
export function AdapterLoginPanel({
  companyId,
  adapterType,
  environmentId,
  autoStart,
  onConnected,
  onAccountBinding,
  chrome = "panel",
  aiConnection,
  onPromptReady,
}: AdapterLoginPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // The server delivers the one-time prompt on the first owner read only. Latch
  // it so a later poll that returns a null prompt does not hide the code and the
  // URL.
  const [latchedPrompt, setLatchedPrompt] = useState<AdapterAuthSessionPrompt | null>(null);
  // The cross-account bind's own lifecycle (see the binding block below).
  // Declared with the panel's state because `startDisabled` reads it: a
  // saving bind blocks a new Sign in.
  const [accountBindState, setAccountBindState] = useState<"idle" | "saving" | "bound" | "failed">(
    "idle",
  );

  // True for the session currently held in `sessionId` when it came from the
  // owner-scoped resume read rather than a fresh `startLogin`. It marks the
  // one case that needs the extra release-on-error path below: a session this
  // browser instance did not just start, so a broken poll cannot fall back to
  // the ordinary "let the user press Sign in again" recovery — the owner has
  // no local memory of ever starting it.
  const resumedRef = useRef(false);

  const startLogin = useMutation({
    mutationFn: () => agentsApi.startAdapterAuthLogin(companyId, adapterType, { environmentId, aiConnection }),
    onSuccess: (session) => {
      resumedRef.current = false;
      setStartError(null);
      setLatchedPrompt(null);
      // A fresh login is a fresh bind decision: clear the previous session's
      // bind narration so its outcome cannot masquerade as this session's.
      setAccountBindState("idle");
      setSessionId(session.sessionId);
    },
    onError: (error) => {
      setStartError(error instanceof Error ? error.message : "Could not start the login.");
    },
  });

  // Reset local state, so the panel returns to its idle start state and the
  // Sign in button is available again.
  const clearActiveSession = useCallback(() => {
    resumedRef.current = false;
    setSessionId(null);
    setLatchedPrompt(null);
    setStartError(null);
  }, []);

  const cancelLogin = useMutation({
    mutationFn: () => agentsApi.cancelAdapterAuthLogin(companyId, adapterType, sessionId!),
    onSuccess: clearActiveSession,
    onError: (error) => {
      setStartError(error instanceof Error ? error.message : "Could not cancel the login.");
    },
  });

  // Read the caller's active session on mount, with no session id, so the
  // browser rediscovers its own session after a reload with no local state. A
  // 404 means no active session for the caller.
  const activeSessionQuery = useQuery({
    queryKey: ["adapter-login-active-session", companyId, adapterType],
    queryFn: async () => {
      try {
        const active = await agentsApi.getActiveAdapterAuthLoginSession(companyId, adapterType);
        if (!active) return null;
        if ((aiConnection && active.environmentId !== environmentId) || Boolean(active.aiConnection) !== Boolean(aiConnection) || (aiConnection && (active.aiConnection?.provider !== aiConnection.provider || active.aiConnection?.method !== aiConnection.method || active.aiConnection?.connectionId !== aiConnection.connectionId || active.aiConnection?.ownership !== aiConnection.ownership || active.aiConnection?.allAgents !== aiConnection.allAgents || JSON.stringify(active.aiConnection?.agentIds) !== JSON.stringify(aiConnection.agentIds)))) throw new Error("Another sign-in attempt is active. Finish or cancel it in its original account setup before starting this one.");
        return active;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
    // Never answered from cache. This read decides whether to adopt a running
    // session or start a new one, and a cached "none" from an earlier mount is
    // exactly wrong after Back: the panel would read `isFetched` immediately,
    // see the stale null, and start a second login while the refetch was still
    // in flight — which the per-owner cap then rejects.
    gcTime: 0,
    staleTime: 0,
  });

  // While the panel releases a resumed session it cannot recover (see below),
  // it keeps showing the login as active rather than dropping back to idle, so
  // it does not clear local state before the release finishes.
  const [releasingResumedSession, setReleasingResumedSession] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["adapter-login-status", companyId, adapterType, sessionId],
    queryFn: () => agentsApi.getAdapterAuthLoginStatus(companyId, adapterType, sessionId!),
    enabled: Boolean(sessionId) && !releasingResumedSession,
    // A status 404 is unrecoverable: the server removed the row, so a retry
    // cannot bring it back. Stop at once and fail loudly.
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) return false;
      return failureCount < 3;
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ADAPTER_LOGIN_TERMINAL_STATUSES.has(status)
        ? false
        : ADAPTER_LOGIN_POLL_INTERVAL_MS;
    },
  });

  // Latch the first non-null prompt for the current session. A later poll
  // returns a null prompt after the one-time delivery, so keep the latched value.
  useEffect(() => {
    const next = statusQuery.data?.prompt ?? null;
    if (next) setLatchedPrompt(next);
  }, [statusQuery.data]);

  const session = statusQuery.data ?? startLogin.data ?? null;
  const status = session?.status ?? null;
  const prompt = latchedPrompt;
  const isTerminal = status ? ADAPTER_LOGIN_TERMINAL_STATUSES.has(status) : false;
  const isActive = Boolean(sessionId) && !isTerminal;
  // A saving bind also blocks a new Sign in: the bind is an agent-update save,
  // and a second login started while it is in flight could finish its own
  // save first — the older save would then land last and silently revert the
  // agent to the previous account while the panel reports the newer bind.
  // Serializing at the only entry point is the whole fix; the panel has no
  // other way to start a login mid-save.
  const startDisabled = startLogin.isPending || isActive || accountBindState === "saving";

  // Adopt the caller's active session once, on mount. This is what makes a
  // page reload keep the session: with no local state at all, the panel would
  // otherwise show its idle start state even though the server still holds an
  // active login for this owner.
  const resumeAttemptedRef = useRef(false);
  useEffect(() => {
    if (resumeAttemptedRef.current || !activeSessionQuery.isFetched) return;
    resumeAttemptedRef.current = true;
    const active = activeSessionQuery.data;
    if (!active) return;
    resumedRef.current = true;
    setStartError(null);
    setLatchedPrompt(active.prompt ?? null);
    setSessionId(active.sessionId);
  }, [activeSessionQuery.isFetched, activeSessionQuery.data]);

  // A resumed session's status poll found the session already gone: the read
  // that discovered it and the poll that tried to use it raced, and the
  // session lost. The panel cannot resume it, and there is no unmount cleanup
  // left to fall back on, so it releases the reservation itself and waits for
  // that release before it returns to the idle start state.
  useEffect(() => {
    const error = statusQuery.error;
    if (!(error instanceof ApiError && error.status === 404)) return;
    if (!resumedRef.current || releasingResumedSession) return;
    setReleasingResumedSession(true);
    const id = sessionId;
    void (async () => {
      if (id) {
        await agentsApi.cancelAdapterAuthLogin(companyId, adapterType, id).catch(() => {
          // The session is already gone either way; nothing more to do.
        });
      }
      setReleasingResumedSession(false);
      clearActiveSession();
    })();
  }, [statusQuery.error, releasingResumedSession, sessionId, companyId, adapterType, clearActiveSession]);

  // Start once, on mount, when the caller has already taken the press, and
  // only once the resume read has answered: a resumed session takes over
  // instead of a fresh start. The ref is the guard rather than the mutation's
  // own pending flag: `startLogin` settles, and without a latch a re-render
  // after it settles would read "not pending, no session yet" during the gap
  // before the session id lands and start a second login the server would
  // count against the per-owner cap.
  const autoStartedRef = useRef(false);
  const startLoginRef = useRef(startLogin.mutate);
  startLoginRef.current = startLogin.mutate;
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    // A failed lookup is not proof that no session exists: only a successful
    // lookup is. Show the failure to the user instead of starting a second
    // login the server would reject against the per-owner cap.
    if (activeSessionQuery.isError) {
      autoStartedRef.current = true;
      setStartError(
        activeSessionQuery.error instanceof Error
          ? activeSessionQuery.error.message
          : "Could not check for an active login.",
      );
      return;
    }
    if (!activeSessionQuery.isSuccess) return;
    autoStartedRef.current = true;
    if (activeSessionQuery.data) return;
    startLoginRef.current();
  }, [
    autoStart,
    activeSessionQuery.isSuccess,
    activeSessionQuery.isError,
    activeSessionQuery.data,
    activeSessionQuery.error,
  ]);

  // Report success upward once. `authenticated` is this panel's terminal
  // success: there is no completion read after it, so the status is the whole
  // of the news.
  const connectedRef = useRef(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  useEffect(() => {
    if (status !== "authenticated" || connectedRef.current) return;
    connectedRef.current = true;
    onConnectedRef.current?.(sessionId ?? undefined);
  }, [status]);

  // Drive the account-binding hand-off as a visible state machine, not a
  // fire-and-forget latch. The bind saves the agent, and the status poll
  // stops at the terminal state — so a rejected save behind a silently
  // latched claim would leave nothing to re-fire it and no way to retry.
  // A cross-account claim moves saving → bound | failed, and failed renders
  // an explicit Retry that re-runs the same handler with the same claim.
  // Latched per SESSION, not per mount: the terminal state re-enables Sign in
  // inside the same mounted panel, and a second cross-account login must run
  // its own bind — a mount-scoped boolean would silently skip it and leave
  // the agent on the previous account.
  const accountBindSessionRef = useRef<string | null>(null);
  const onAccountBindingRef = useRef(onAccountBinding);
  onAccountBindingRef.current = onAccountBinding;
  const accountBinding = statusQuery.data?.codexAccountBinding ?? null;
  const runAccountBinding = useCallback(async (claim: CodexAccountBindingClaim) => {
    const handler = onAccountBindingRef.current;
    if (!handler) return;
    setAccountBindState("saving");
    try {
      await handler(claim);
      setAccountBindState("bound");
    } catch {
      setAccountBindState("failed");
    }
  }, []);
  useEffect(() => {
    if (status !== "authenticated" || !sessionId) return;
    if (accountBindSessionRef.current === sessionId) return;
    if (!accountBinding || !accountBinding.companyIdentityDiffers || !onAccountBindingRef.current) {
      return;
    }
    accountBindSessionRef.current = sessionId;
    void runAccountBinding(accountBinding);
  }, [status, sessionId, accountBinding, runAccountBinding]);

  // Report the prompt's URL upward. The caller's loading beat ends when this
  // arrives, so without it the onboarding step waits on a card that has already
  // opened: the code is on screen and the button stays disabled. Fires with null
  // on mount, before the one-time prompt lands, which is the same null the
  // caller starts from.
  const onPromptReadyRef = useRef(onPromptReady);
  onPromptReadyRef.current = onPromptReady;
  useEffect(() => {
    onPromptReadyRef.current?.(prompt?.url ?? null);
  }, [prompt]);

  if (chrome === "onboarding") {
    const failed = isTerminal && status && status !== "authenticated";
    return (
      <ProviderSubscriptionCard
        loading={!prompt && !startError && !failed}
        providerName={connectSourceName(adapterType)}
        authorizationUrl={prompt?.url}
      >
        {startError ? (
          <p role="alert" className="pl-2 text-xs text-destructive">
            {startError}
          </p>
        ) : failed ? (
          <p role="alert" className="pl-2 text-xs text-destructive">
            {status === "timed_out"
              ? "The login timed out. Start it again."
              : status === "cancelled"
                ? "The login was cancelled."
                : "The login did not finish. Start it again."}
          </p>
        ) : (
          <OnboardingLoginCodeRow code={prompt?.code ?? ""} autoCopy />
        )}
      </ProviderSubscriptionCard>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 flex flex-col gap-2">
      {/* `gap`, not `space-y`: the live region below collapses to
          `display: none` whenever it has nothing to announce, and
          `space-y` would still put its 8px on the row above — dead space
          inside the card that pushes the row off centre. A gap only
          applies between children that render. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{adapterLoginTitle(adapterType)}</span>
        <div className="flex items-center gap-1.5">
          {isActive && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
              disabled={cancelLogin.isPending}
              onClick={() => cancelLogin.mutate()}
            >
              Cancel
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={startDisabled}
            onClick={() => startLogin.mutate()}
          >
            Sign in
          </Button>
        </div>
      </div>

      {startError && (
        <div role="alert" className="text-(length:--text-micro) text-destructive">
          {startError}
        </div>
      )}

      {/* One live region announces the loading, prompt, and terminal states, so a
          screen reader reports each transition without a re-navigation. */}
      <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
        {isActive && !prompt && (
          <div className="flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
            <Loader2 className="size-3 animate-spin shrink-0" />
            <span>Preparing...</span>
          </div>
        )}

        {isActive && prompt && (
          <div className="space-y-2">
            <div className="text-(length:--text-micro) text-muted-foreground">
              Copy the code, then open the authentication page.
            </div>
          {/* Code first, then the URL, and the sentence and the numbering both
              say so.

              This used to run the other way, on the reasoning that handing over
              a code before the page it belongs to was getting ahead of the
              customer. What that missed is where the two rows are used: opening
              the page is what leaves this screen, and the form waiting on the
              other side wants the code that was on this one. Reaching back for
              it is the step worth removing, so the code is read and copied
              while it is still in front of you.

              The onboarding card is ordered the same way and for the same
              reason. */}
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                1. Code
              </div>
              <span className="font-mono text-xs text-foreground break-all">{prompt.code}</span>
            </div>
            <AdapterLoginCopyButton value={prompt.code} label="Copy code" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                2. Authentication URL
              </div>
              <span className="font-mono text-xs text-foreground break-all">{prompt.url}</span>
            </div>
            <div className="flex items-center">
              <AdapterLoginCopyButton value={prompt.url} label="Copy URL" />
              <Button
                asChild
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Open the authentication page"
                title="Open the authentication page"
                className="text-muted-foreground hover:text-foreground"
              >
                <a href={prompt.url} target="_blank" rel="noreferrer noopener">
                  <ExternalLink className="size-3" />
                </a>
              </Button>
            </div>
          </div>
        </div>
        )}

        {isTerminal && status && (
          <AdapterLoginTerminalState status={status} message={session?.failure?.message ?? null} />
        )}

        {/* The cross-account bind's own state, below the login's success line.
            The bind is a second, separate save — showing it as part of the
            login would report success for a write that can still fail. */}
        {status === "authenticated" && accountBindState === "saving" && (
          <div className="flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
            <Loader2 className="size-3 animate-spin shrink-0" />
            <span>Binding this agent to the signed-in account...</span>
          </div>
        )}
        {status === "authenticated" && accountBindState === "bound" && (
          <div className="flex items-center gap-2 text-(length:--text-micro) text-foreground">
            <Check className="size-3 shrink-0" />
            <span>Agent bound to the signed-in account.</span>
          </div>
        )}
        {status === "authenticated" && accountBindState === "failed" && (
          <div className="flex items-center gap-2 text-(length:--text-micro)">
            <TriangleAlert className="size-3 shrink-0 text-destructive" />
            <span className="text-destructive">
              Could not bind this agent to the signed-in account.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                if (accountBinding) void runAccountBinding(accountBinding);
              }}
            >
              Retry
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function AdapterEnvironmentResult({ result }: { result: AdapterEnvironmentTestResult }) {
  const statusLabel =
    result.status === "pass" ? "Passed" : result.status === "warn" ? "Warnings" : "Failed";
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
        ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
        : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="text-(length:--text-micro) opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {result.checks.map((check, idx) => (
          <div key={`${check.code}-${idx}`} className="text-(length:--text-micro) leading-relaxed break-words">
            <span className="font-medium uppercase tracking-wide opacity-80">
              {check.level}
            </span>
            <span className="mx-1 opacity-60">·</span>
            <span>{check.message}</span>
            {check.detail && <span className="block opacity-75 break-all">({check.detail})</span>}
            {check.hint && <span className="block opacity-90 break-words">Hint: {check.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Internal sub-components ---- */

export function AdapterTypeDropdown({
  value,
  onChange,
  disabledTypes,
}: {
  value: string;
  onChange: (type: string) => void;
  disabledTypes: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const selectedDisplay = getAdapterDisplay(value);
  const adapterList = useMemo(
    () =>
      listAdapterOptions((type) => adapterLabels[type] ?? getAdapterLabel(type)).filter(
        (item) => !disabledTypes.has(item.value),
      ),
    [disabledTypes],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
            <span className="truncate">{adapterLabels[value] ?? getAdapterLabel(value)}</span>
            {selectedDisplay.experimental && <ExperimentalBadge />}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-1" align="start">
        {adapterList.map((item) => (
          <button
            key={item.value}
            disabled={item.comingSoon}
            className={cn(
              "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded",
              item.comingSoon
                ? "opacity-40 cursor-not-allowed"
                : "hover:bg-accent/50",
              item.value === value && !item.comingSoon && "bg-accent",
            )}
            onClick={() => {
              if (!item.comingSoon) {
                onChange(item.value);
                setOpen(false);
              }
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              {item.value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
              <span>{item.label}</span>
              {item.experimental && <ExperimentalBadge />}
            </span>
            {item.comingSoon && (
              <span className="text-(length:--text-nano) text-muted-foreground">Coming soon</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ExperimentalBadge() {
  return (
    <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-(length:--text-nano) font-medium leading-none text-amber-700 dark:text-amber-200">
      Experimental
    </span>
  );
}

export function ModelDropdown({
  models,
  value,
  onChange,
  open,
  onOpenChange,
  allowDefault,
  required,
  groupByProvider,
  creatable,
  detectedModel,
  detectedModelCandidates,
  onDetectModel,
  onRefreshModels,
  refreshingModels,
  detectModelLabel,
  emptyDetectHint,
  defaultLabel,
}: {
  models: AdapterModel[];
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowDefault: boolean;
  required: boolean;
  groupByProvider: boolean;
  creatable?: boolean;
  detectedModel?: string | null;
  detectedModelCandidates?: string[];
  onDetectModel?: () => Promise<string | null>;
  onRefreshModels?: () => Promise<void>;
  refreshingModels?: boolean;
  detectModelLabel?: string;
  emptyDetectHint?: string;
  defaultLabel?: string;
}) {
  const [modelSearch, setModelSearch] = useState("");
  const [detectingModel, setDetectingModel] = useState(false);
  const selected = models.find((m) => m.id === value);
  const manualModel = modelSearch.trim();
  const canCreateManualModel = Boolean(
    creatable &&
      manualModel &&
      !models.some((m) => m.id.toLowerCase() === manualModel.toLowerCase()),
  );
  // Model IDs already shown as detected/candidate badges — exclude from regular list
  const promotedModelIds = useMemo(() => {
    const set = new Set<string>();
    if (detectedModel) set.add(detectedModel);
    for (const c of detectedModelCandidates ?? []) {
      if (c) set.add(c);
    }
    return set;
  }, [detectedModel, detectedModelCandidates]);

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      if (promotedModelIds.has(m.id)) return false;
      if (!modelSearch.trim()) return true;
      const q = modelSearch.toLowerCase();
      const provider = extractProviderId(m.id) ?? "";
      return (
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        provider.toLowerCase().includes(q)
      );
    });
  }, [models, modelSearch, promotedModelIds]);
  const groupedModels = useMemo(() => {
    if (!groupByProvider) {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id)),
        },
      ];
    }
    const map = new Map<string, AdapterModel[]>();
    for (const model of filteredModels) {
      const provider = extractProviderId(model.id) ?? "other";
      const group = map.get(provider) ?? [];
      group.push(model);
      map.set(provider, group);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
      }));
  }, [filteredModels, groupByProvider]);

  async function handleDetectModel() {
    if (!onDetectModel) return;
    setDetectingModel(true);
    try {
      const nextModel = await onDetectModel();
      if (nextModel) {
        onChange(nextModel);
        onOpenChange(false);
        setModelSearch("");
      }
    } finally {
      setDetectingModel(false);
    }
  }

  return (
    <Field label="Model" hint={help.model}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          if (!nextOpen) setModelSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!value && "text-muted-foreground")}>
              {selected
                ? selected.label
                : value
                  || (allowDefault ? (defaultLabel ?? "Default") : required ? "Select model (required)" : "Select model")}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-1" align="start">
          <div className="relative mb-1">
            <input
              className="w-full px-2 py-1.5 pr-6 text-xs bg-transparent outline-none border-b border-border placeholder:text-muted-foreground/50"
              placeholder={creatable ? "Search models... (type to create)" : "Search models..."}
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              autoFocus
            />
            {modelSearch && (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setModelSearch("")}
              >
                <svg aria-hidden="true" focusable="false" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          {onDetectModel && !modelSearch.trim() && (
            <button
              type="button"
              className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground"
              onClick={() => {
                void handleDetectModel();
              }}
              disabled={detectingModel}
            >
              <svg aria-hidden="true" focusable="false" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              {detectingModel ? "Detecting..." : detectedModel ? (detectModelLabel?.replace(/^Detect\b/, "Re-detect") ?? "Re-detect from config") : (detectModelLabel ?? "Detect from config")}
            </button>
          )}
          {onRefreshModels && !modelSearch.trim() && (
            <button
              type="button"
              className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground"
              onClick={() => {
                void onRefreshModels();
              }}
              disabled={refreshingModels}
            >
              <svg aria-hidden="true" focusable="false" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 0 1 15.28-6.36L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-15.28 6.36L3 16" />
                <path d="M8 16H3v5" />
              </svg>
              {refreshingModels ? "Refreshing..." : "Refresh models"}
            </button>
          )}
          {value && (!models.some((m) => m.id === value) || promotedModelIds.has(value)) && (
            <button
              type="button"
              className={cn(
                "flex items-center w-full px-2 py-1.5 text-sm rounded bg-accent/50",
              )}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              <span className="block w-full text-left truncate font-mono text-xs" title={value}>
                {models.find((m) => m.id === value)?.label ?? value}
              </span>
              <Badge variant="outline" className="ml-auto text-(length:--text-nano) px-1.5 bg-green-500/15 text-green-400 border-green-500/20">
                current
              </Badge>
            </button>
          )}
          {detectedModel && detectedModel !== value && (
            <button
              type="button"
              className={cn(
                "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
              )}
              onClick={() => {
                onChange(detectedModel);
                onOpenChange(false);
              }}
            >
              <span className="block w-full text-left truncate font-mono text-xs" title={detectedModel}>
                {models.find((m) => m.id === detectedModel)?.label ?? detectedModel}
              </span>
              <Badge variant="outline" className="ml-auto text-(length:--text-nano) px-1.5 bg-blue-500/15 text-blue-400 border-blue-500/20">
                detected
              </Badge>
            </button>
          )}
          {detectedModelCandidates
            ?.filter((candidate) => candidate && candidate !== detectedModel && candidate !== value)
            .map((candidate) => {
              const entry = models.find((m) => m.id === candidate);
              return (
                <button
                  key={`detected-${candidate}`}
                  type="button"
                  className={cn(
                    "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  )}
                  onClick={() => {
                    onChange(candidate);
                    onOpenChange(false);
                  }}
                >
                  <span className="block w-full text-left truncate font-mono text-xs" title={candidate}>
                    {entry?.label ?? candidate}
                  </span>
                  <Badge variant="outline" className="ml-auto text-(length:--text-nano) px-1.5 bg-sky-500/15 text-sky-400 border-sky-500/20">
                    config
                  </Badge>
                </button>
              );
            })}
          <div className="max-h-(--sz-240px) overflow-y-auto">
            {allowDefault && (
              <button
                type="button"
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  !value && "bg-accent",
                )}
                onClick={() => {
                  onChange("");
                  onOpenChange(false);
                }}
              >
                Default
              </button>
            )}
            {canCreateManualModel && (
              <button
                type="button"
                className="flex items-center justify-between gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50"
                onClick={() => {
                  onChange(manualModel);
                  onOpenChange(false);
                  setModelSearch("");
                }}
              >
                <span>Use manual model</span>
                <span className="text-xs font-mono text-muted-foreground">{manualModel}</span>
              </button>
            )}
            {groupedModels.map((group) => (
              <div key={group.provider} className="mb-1 last:mb-0">
                {groupByProvider && (
                  <div className="px-2 py-1 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                    {group.provider} ({group.entries.length})
                  </div>
                )}
                {group.entries.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={cn(
                      "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                      m.id === value && "bg-accent",
                    )}
                    onClick={() => {
                      onChange(m.id);
                      onOpenChange(false);
                    }}
                  >
                    <span className="block w-full text-left truncate" title={m.id}>
                      {groupByProvider ? extractModelName(m.id) : m.label}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {filteredModels.length === 0 && !canCreateManualModel && promotedModelIds.size === 0 && (
              <div className="px-2 py-2 space-y-2">
                <p className="text-xs text-muted-foreground">
                  {onDetectModel
                    ? (emptyDetectHint ?? "No model detected yet. Enter a provider/model manually.")
                    : "No models found."}
                </p>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function ThinkingEffortDropdown({
  value,
  options,
  onChange,
  open,
  onOpenChange,
}: {
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selected = options.find((option) => option.id === value) ?? options[0];

  return (
    <Field label="Thinking effort" hint={help.thinkingEffort}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!value && "text-muted-foreground")}>{selected?.label ?? "Auto"}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-1" align="start">
          {options.map((option) => (
            <button
              key={option.id || "auto"}
              className={cn(
                "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                option.id === value && "bg-accent",
              )}
              onClick={() => {
                onChange(option.id);
                onOpenChange(false);
              }}
            >
              <span>{option.label}</span>
              {option.id ? <span className="text-xs text-muted-foreground font-mono">{option.id}</span> : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </Field>
  );
}
