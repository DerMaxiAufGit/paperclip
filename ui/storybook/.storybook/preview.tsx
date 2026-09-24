import { useEffect, useState, type ReactNode } from "react";
import type { Preview } from "@storybook/react-vite";
import { MINIMAL_VIEWPORTS } from "storybook/viewport";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CLAUDE_SUBSCRIPTION_IMPORT_UNSUPPORTED_MESSAGE,
  CONNECTABLE_APP_DEFINITIONS,
  type WorkTimelineResult,
} from "@paperclipai/shared";
import { MemoryRouter } from "@/lib/router";
import { ONBOARDING_STORAGE_KEY } from "@/components/OnboardingWizard";
import { STORYBOOK_COMPANY_ID } from "../fixtures/onboardingDraft";
import {
  STORYBOOK_SANDBOX_ENVIRONMENT_ID,
  onboardingFixtureState,
  storybookAuthSignal,
  storybookEnvironmentCapabilities,
  storybookEnvironmentTest,
  storybookEnvironments,
} from "../fixtures/onboardingEnvironment";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { CompanyProvider } from "@/context/CompanyContext";
import { DialogProvider } from "@/context/DialogContext";
import { EditorAutocompleteProvider } from "@/context/EditorAutocompleteContext";
import { PanelProvider } from "@/context/PanelContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/context/ToastContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  storybookAgents,
  storybookApprovals,
  storybookAuthSession,
  storybookCompanies,
  storybookDashboardSummary,
  storybookHiredAgent,
  storybookIssues,
  storybookLiveRuns,
  storybookProjects,
  storybookSecretAccessEvents,
  storybookSecretBindings,
  storybookSecretProviderConfigs,
  storybookSecretProviderDiscoveryPreview,
  storybookSecretProviderHealth,
  storybookSecretProviders,
  storybookSecrets,
  storybookSidebarBadges,
} from "../fixtures/paperclipData";
import timelineSample from "../fixtures/workTimeline.human.sample.json";
import "@mdxeditor/editor/style.css";
import "./tailwind-entry.css";
import "./styles.css";

const STORYBOOK_USER_AVATAR =
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&q=80";

function withStorybookTimelineDetails(
  data: WorkTimelineResult,
): WorkTimelineResult {
  return {
    ...data,
    actors: data.actors.map((actor) =>
      actor.type === "user"
        ? { ...actor, avatar: STORYBOOK_USER_AVATAR }
        : actor,
    ),
    spans: data.spans.map((span, index) => {
      const inputTokens = 42_000 + index * 137;
      const cachedInputTokens = index % 3 === 0 ? 8_000 : 0;
      const outputTokens = 5_400 + index * 29;
      return {
        ...span,
        usage: span.usage ?? {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          totalTokens: inputTokens + cachedInputTokens + outputTokens,
        },
      };
    }),
  };
}

const storybookTimelineSample = withStorybookTimelineDetails(
  timelineSample as WorkTimelineResult,
);

// Install fetch monkeypatch eagerly so any module-load-time fetches (e.g. schema
// caches in adapter config renderers) hit our fixtures before they reach the
// network. Some renderers issue a fetch from useEffect on first paint, which
// can otherwise race the StorybookProviders mount.
installStorybookApiFixtures();

function installStorybookApiFixtures() {
  if (typeof window === "undefined") return;
  const currentWindow = window as typeof window & {
    __paperclipStorybookFetchInstalled?: boolean;
  };
  if (currentWindow.__paperclipStorybookFetchInstalled) return;

  const originalFetch = window.fetch.bind(window);
  currentWindow.__paperclipStorybookFetchInstalled = true;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(rawUrl, window.location.origin);

    if (url.pathname === "/api/auth/get-session") {
      return Response.json(storybookAuthSession);
    }

    if (url.pathname === "/api/companies") {
      // The wizard's naming step creates a company here and reads its id back;
      // answering the POST with the list instead gave it an array, and the
      // walk crashed on the step after. Hand back the fixture company as the
      // one just created, so the arc can be walked from its first screen.
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        const body = init?.body ? (JSON.parse(String(init.body)) as { name?: string }) : {};
        return Response.json({ ...storybookCompanies[0], name: body.name ?? storybookCompanies[0]?.name });
      }
      return Response.json(storybookCompanies);
    }

    if (url.pathname === "/api/companies/company-storybook/user-directory") {
      return Response.json({
        users: [
          {
            principalId: "user-board",
            status: "active",
            user: {
              id: "user-board",
              email: "board@paperclip.local",
              name: "Board Operator",
              image: null,
            },
          },
          {
            principalId: "user-product",
            status: "active",
            user: {
              id: "user-product",
              email: "product@paperclip.local",
              name: "Product Lead",
              image: null,
            },
          },
        ],
      });
    }

    if (url.pathname === "/api/instance/settings/experimental") {
      return Response.json({
        enableIsolatedWorkspaces: true,
        autoRestartDevServerWhenIdle: false,
        // The cloud-tenant shape, and what the onboarding connect step resolves
        // its login environment through: without it the step looks for a local
        // default and never finds the managed sandbox.
        enableManagedSandboxOnly: onboardingFixtureState.environments !== "local",
      });
    }

    if (url.pathname === "/api/health") {
      return Response.json({ deploymentMode: "authenticated", localAiLoginSupported: onboardingFixtureState.environments === "local" });
    }

    if (url.pathname === "/api/instance/settings") {
      return Response.json({});
    }

    // The connect step's provider sign-in is gated on a *sandbox* environment
    // resolving, its provider supporting a login PTY, and the auth signal coming
    // back absent. These three answers decide whether that panel renders at all,
    // so a story picks them through `onboardingFixtureState` rather than getting
    // one hard-coded shape — an earlier version returned an empty environment
    // list here and made the panel invisible everywhere.
    if (/^\/api\/companies\/[^/]+\/environments$/.test(url.pathname)) {
      return Response.json(storybookEnvironments());
    }

    if (
      /^\/api\/companies\/[^/]+\/environments\/capabilities$/.test(url.pathname)
    ) {
      return Response.json(storybookEnvironmentCapabilities());
    }

    if (
      /^\/api\/companies\/[^/]+\/adapters\/[^/]+\/auth-signal/.test(
        url.pathname,
      )
    ) {
      return Response.json(storybookAuthSignal());
    }

    if (
      /^\/api\/companies\/[^/]+\/adapters\/[^/]+\/models$/.test(url.pathname)
    ) {
      return Response.json([]);
    }

    // The per-adapter login routes, used by the Codex and Grok device logins.
    // Claude has no in-app login: claude_local runs the claude CLI signed in on
    // the server, so its tile reads the auth-signal route above instead.
    //
    // Pressing Sign in on the Codex tile without these fell through to the dev
    // server and came back 404 — which reads as a broken product rather than as
    // a missing fixture, and the two are not distinguishable from the panel.
    //
    // The panel mode is `displayed_code`: the server shows a URL *and* a code to
    // type into it, and nothing is typed back here, so the canvas holding the
    // card has to size to both.
    const adapterLoginMatch = url.pathname.match(
      /^\/api\/companies\/[^/]+\/adapters\/([^/]+)\/login-sessions(?:\/([^/]+))?(\/cancel)?$/,
    );
    if (adapterLoginMatch) {
      if (adapterLoginMatch[2] === "active") return new Response(null, { status: 404 });
      const session = {
        sessionId: "adapter-login-storybook",
        environmentId: STORYBOOK_SANDBOX_ENVIRONMENT_ID,
        // `waiting_for_user` is the state this panel is worth looking at in: the
        // session is live and the customer is being asked for something.
        status: "waiting_for_user",
        expiresAt: null,
        failure: null,
      };
      if (adapterLoginMatch[3]) return Response.json({ ...session, status: "cancelled" });
      // The prompt rides the owner read of the session rather than a route of
      // its own, so it is returned only on the read with a session id.
      if (adapterLoginMatch[2]) {
        return Response.json({
          ...session,
          prompt: {
            url: "https://auth.openai.com/device",
            code: "STORY-BOOK",
          },
        });
      }
      return Response.json(session);
    }

    // Local subscription sign-in for Codex and Grok. The server refuses
    // Anthropic here (a Claude subscription is used only through the claude CLI
    // signed in on the server), and so do these fixtures.
    const localLoginMatch = url.pathname.match(
      /^\/api\/companies\/[^/]+\/ai-connections\/local(\/attempts|\/check)?$/,
    );
    if (localLoginMatch) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body.provider === "anthropic") {
        return Response.json({ error: CLAUDE_SUBSCRIPTION_IMPORT_UNSUPPORTED_MESSAGE }, { status: 422 });
      }
      if (localLoginMatch[1] === "/attempts") {
        return Response.json({ sessionId: "local-storybook", expiresAt: new Date(Date.now() + 1_800_000).toISOString(), command: body.provider === "xai"
          ? "GROK_HOME='/paperclip/login' grok login --device-auth"
          : "CODEX_HOME='/paperclip/login' codex login --device-auth" });
      }
      if (localLoginMatch[1] === "/check") {
        return Response.json({ status: onboardingFixtureState.localLoginStatus });
      }
      if (onboardingFixtureState.localLoginStatus !== "ready") return Response.json({ error: "Finish signing in, then try Connect again." }, { status: 422 });
      if (onboardingFixtureState.connectPending) await new Promise(() => {});
      onboardingFixtureState.savedManagedSubscription = body.provider;
      return Response.json({ connectionId: "managed-storybook", grantId: "grant-storybook" });
    }
    if (/^\/api\/companies\/[^/]+\/ai-connections$/.test(url.pathname)) {
      const provider = onboardingFixtureState.savedManagedSubscription;
      return init?.method === "POST"
        ? Response.json({ connectionId: "managed-storybook", grantId: "grant-storybook" })
        : Response.json({ currentUserId: "user-storybook", connections: provider ? [{
            id: "managed-storybook", grantId: "grant-storybook", companyId: "company-storybook",
            provider, method: "subscription", name: "My OpenAI subscription",
            ownership: "personal", ownerUserId: "user-storybook", status: "connected", isDefault: true,
          }] : [] });
    }
    if (/^\/api\/companies\/[^/]+\/me\/user-secrets$/.test(url.pathname)) {
      return Response.json(onboardingFixtureState.savedApiKeys ? ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].map((key) => ({
        definition: { id: key, companyId: "company-storybook", key: `${key}.setup.storybook`, name: key === "ANTHROPIC_API_KEY" ? "My Claude key" : "My OpenAI key", status: "active" },
        secret: { id: `secret-${key}`, companyId: "company-storybook", scope: "user", status: "active" },
      })) : []);
    }

    // The hire, and the three calls either side of it.
    //
    // These exist so the review step can be reached the way a customer reaches
    // it — by pressing Connect — rather than by seeding a draft that claims the
    // hire already happened. The difference is not pedantry: the wizard only
    // offers Back on a step it walked *forward* into, so a story that starts on
    // the review step renders it without the control it is supposed to have.
    //
    // The environment test, which is the hire's gate. It answers from the story's
    // auth state rather than always passing — see `storybookEnvironmentTest`.
    const testEnvMatch = url.pathname.match(
      /^\/api\/companies\/[^/]+\/adapters\/([^/]+)\/test-environment$/,
    );
    if (testEnvMatch) {
      if (onboardingFixtureState.testPending) await new Promise(() => {});
      await new Promise(resolve => setTimeout(resolve, onboardingFixtureState.testDelayMs));
      if (onboardingFixtureState.testFailuresRemaining > 0) {
        onboardingFixtureState.testFailuresRemaining--;
        return Response.json({ error: "The provider did not respond. Try connecting again." }, { status: 502 });
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const env = body.adapterConfig?.env ?? {};
      const usesSavedCodex = onboardingFixtureState.savedCodexLogin && env.CODEX_HOME?.secretId === "saved-codex-home";
      const usesSavedKey = onboardingFixtureState.savedApiKeys && ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].some((key) => env[key]?.type === "user_secret_ref" && env[key]?.key === `${key}.setup.storybook`);
      return Response.json((body.aiConnection?.provider === onboardingFixtureState.savedManagedSubscription) || usesSavedCodex || usesSavedKey ? { adapterType: testEnvMatch[1], status: "pass", checks: [], testedAt: new Date(0).toISOString() } : storybookEnvironmentTest(testEnvMatch[1]));
    }
    if (/^\/api\/companies\/[^/]+\/agent-hires$/.test(url.pathname)) {
      // `approval: null` on purpose. A hire that returns one sends the wizard
      // through the approvals API before it advances, and this story is about
      // the step it lands on rather than the path it took.
      return Response.json({ agent: storybookHiredAgent, approval: null });
    }
    const instructionsBundleMatch = url.pathname.match(
      /^\/api\/agents\/([^/]+)\/instructions-bundle(\/file)?$/,
    );
    if (instructionsBundleMatch) {
      // The wizard seeds the lead's instructions here and swallows a failure —
      // so an unstubbed route costs nothing but a console warning on every run,
      // which is the kind of noise that trains people to ignore the console.
      if (instructionsBundleMatch[2]) {
        return Response.json({ path: "AGENTS.md", content: "" });
      }
      return Response.json({
        agentId: instructionsBundleMatch[1],
        companyId: STORYBOOK_COMPANY_ID,
        mode: "managed",
        rootPath: null,
        managedRootPath: `/managed/agents/${instructionsBundleMatch[1]}`,
        entryFile: "AGENTS.md",
        resolvedEntryPath: `/managed/agents/${instructionsBundleMatch[1]}/AGENTS.md`,
        editable: true,
        warnings: [],
      });
    }

    if (
      url.pathname ===
      "/api/connection-intents/interaction-connection-intent-default/setup-options"
    ) {
      return Response.json({
        version: 1,
        interaction: null,
        service: {
          service: "notion",
          name: "Notion",
          description: "Search and update a Notion workspace.",
          logoUrl: null,
          methods: [
            { key: "mcp-oauth", label: "Sign in with Notion", auth: "oauth" },
          ],
          state: "needs_user_action",
          connectionId: null,
        },
        requestedAgentId: "11111111-1111-4111-8111-111111111111",
        existingConnections: [
          {
            id: "connection-storybook-notion",
            companyId: "company-storybook",
            applicationId: "application-storybook-notion",
            name: "Board Operator’s Notion",
            uid: "notion/storybook",
            transport: "mcp_remote",
            authKind: "oauth",
            credentialPolicy: "per_user",
            status: "active",
            enabled: true,
            config: { sourceTemplateKey: "notion" },
            transportConfig: { sourceTemplateKey: "notion" },
            credentialRefs: [],
            credentialSecretRefs: [],
          },
        ],
      });
    }

    if (url.pathname === "/api/companies/company-storybook/tools/gallery") {
      return Response.json({
        apps: CONNECTABLE_APP_DEFINITIONS.filter(
          (app) => app.slug === "notion",
        ),
        capabilities: {
          canSetCompanyInstall: true,
          companyInstallReason: null,
        },
      });
    }
    if (
      url.pathname === "/api/companies/company-storybook/tools/applications"
    ) {
      return Response.json({ applications: [] });
    }
    if (url.pathname === "/api/companies/company-storybook/tools/connections") {
      return Response.json({ connections: [] });
    }

    if (url.pathname === "/api/adapters") {
      return Response.json([
        {
          type: "claude_local",
          label: "Claude Code",
          source: "builtin",
          modelsCount: 2,
          loaded: true,
          disabled: false,
          capabilities: {
            supportsInstructionsBundle: true,
            supportsSkills: true,
            supportsLocalAgentJwt: true,
            requiresMaterializedRuntimeSkills: false,
            // No `login`: claude_local has no in-app sign-in. It runs the
            // claude CLI signed in on the server. Mirrors `KNOWN_DEFAULTS` in
            // `use-adapter-capabilities.ts`.
            supportsModelProfiles: true,
          },
        },
        {
          type: "codex_local",
          label: "Codex",
          source: "builtin",
          modelsCount: 3,
          loaded: true,
          disabled: false,
          capabilities: {
            supportsInstructionsBundle: true,
            supportsSkills: true,
            supportsLocalAgentJwt: true,
            requiresMaterializedRuntimeSkills: false,
            supportsModelProfiles: true,
            // `useAdapterCapabilities` prefers this listing over its own static
            // defaults, so omitting `login` here would silently hide the
            // onboarding connect step's Codex sign-in.
            login: {
              panelMode: "displayed_code",
              timeoutPolicy: "caller_bounded",
            },
          },
        },
      ]);
    }

    const adapterModelsMatch = url.pathname.match(
      /^\/api\/companies\/[^/]+\/adapters\/([^/]+)\/(models|model-profiles)$/,
    );
    if (adapterModelsMatch) {
      const [, , resource] = adapterModelsMatch;
      if (resource === "models") {
        return Response.json([
          { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
          { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
        ]);
      }
      return Response.json([
        {
          key: "cheap",
          label: "Cheap",
          adapterConfig: { model: "claude-sonnet-4-6" },
          source: "adapter_default",
        },
      ]);
    }

    if (url.pathname === "/api/plugins/ui-contributions") {
      return Response.json([]);
    }

    const adapterSchemaMatch = url.pathname.match(
      /^\/api\/adapters\/([^/]+)\/config-schema$/,
    );
    if (adapterSchemaMatch) {
      const [, adapterType] = adapterSchemaMatch;
      const schemas = (
        window as typeof window & {
          __paperclipStorybookAdapterSchemas?: Record<string, unknown>;
        }
      ).__paperclipStorybookAdapterSchemas;
      const schema = schemas?.[adapterType];
      if (schema) return Response.json(schema);
    }

    const secretsListMatch = url.pathname.match(
      /^\/api\/companies\/([^/]+)\/secrets$/,
    );
    if (secretsListMatch) {
      const [, companyId] = secretsListMatch;
      return Response.json(
        companyId === "company-storybook" && onboardingFixtureState.environments !== "local" ? [...storybookSecrets, ...(onboardingFixtureState.savedCodexLogin ? [{ ...storybookSecrets[0], id: "saved-codex-home", key: "codex_home_saved", name: "CODEX_HOME_team-account" }] : [])] : [],
      );
    }

    const secretProvidersMatch = url.pathname.match(
      /^\/api\/companies\/([^/]+)\/secret-providers$/,
    );
    if (secretProvidersMatch) {
      return Response.json(storybookSecretProviders);
    }

    const secretProviderHealthMatch = url.pathname.match(
      /^\/api\/companies\/([^/]+)\/secret-providers\/health$/,
    );
    if (secretProviderHealthMatch) {
      return Response.json(storybookSecretProviderHealth);
    }

    const secretProviderConfigsMatch = url.pathname.match(
      /^\/api\/companies\/([^/]+)\/secret-provider-configs$/,
    );
    if (secretProviderConfigsMatch) {
      return Response.json(storybookSecretProviderConfigs);
    }

    const secretProviderConfigDiscoveryPreviewMatch = url.pathname.match(
      /^\/api\/companies\/([^/]+)\/secret-provider-configs\/discovery\/preview$/,
    );
    if (
      secretProviderConfigDiscoveryPreviewMatch &&
      init?.method?.toUpperCase() === "POST"
    ) {
      return Response.json(storybookSecretProviderDiscoveryPreview);
    }

    const secretUsageMatch = url.pathname.match(
      /^\/api\/secrets\/([^/]+)\/usage$/,
    );
    if (secretUsageMatch) {
      const [, secretId] = secretUsageMatch;
      return Response.json({
        secretId,
        bindings: storybookSecretBindings.filter(
          (binding) => binding.secretId === secretId,
        ),
      });
    }

    const secretEventsMatch = url.pathname.match(
      /^\/api\/secrets\/([^/]+)\/access-events$/,
    );
    if (secretEventsMatch) {
      const [, secretId] = secretEventsMatch;
      return Response.json(
        storybookSecretAccessEvents.filter(
          (event) => event.secretId === secretId,
        ),
      );
    }

    const companyResourceMatch = url.pathname.match(
      /^\/api\/companies\/([^/]+)\/([^/]+)$/,
    );
    if (companyResourceMatch) {
      const [, companyId, resource] = companyResourceMatch;
      if (resource === "agents") {
        return Response.json(
          companyId === "company-storybook" ? storybookAgents : [],
        );
      }
      if (resource === "projects") {
        return Response.json(
          companyId === "company-storybook" ? storybookProjects : [],
        );
      }
      if (resource === "approvals") {
        return Response.json(
          companyId === "company-storybook" ? storybookApprovals : [],
        );
      }
      if (resource === "dashboard") {
        return Response.json({
          ...storybookDashboardSummary,
          companyId,
        });
      }
      if (resource === "timeline") {
        return Response.json(
          companyId === "company-storybook"
            ? storybookTimelineSample
            : {
                actors: [],
                spans: [],
                events: [],
                edges: [],
                pagination: {
                  limit: 100,
                  offset: 0,
                  totalIssues: 0,
                  hasMore: false,
                },
                window: {
                  from:
                    url.searchParams.get("from") ?? new Date(0).toISOString(),
                  to: url.searchParams.get("to") ?? new Date(0).toISOString(),
                  capped: false,
                },
              },
        );
      }
      if (resource === "heartbeat-runs") {
        return Response.json([]);
      }
      if (resource === "live-runs") {
        return Response.json(
          companyId === "company-storybook" ? storybookLiveRuns : [],
        );
      }
      if (resource === "inbox-dismissals") {
        return Response.json([]);
      }
      if (resource === "sidebar-badges") {
        return Response.json(
          companyId === "company-storybook"
            ? storybookSidebarBadges
            : { inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 },
        );
      }
      if (resource === "join-requests") {
        return Response.json([]);
      }
      if (resource === "issues") {
        const query = url.searchParams.get("q")?.trim().toLowerCase();
        const issues = companyId === "company-storybook" ? storybookIssues : [];
        return Response.json(
          query
            ? issues.filter((issue) =>
                `${issue.identifier ?? ""} ${issue.title} ${issue.description ?? ""}`
                  .toLowerCase()
                  .includes(query),
              )
            : issues,
        );
      }
    }

    if (
      url.pathname.startsWith("/api/invites/") &&
      url.pathname.endsWith("/logo")
    ) {
      return new Response(null, { status: 204 });
    }

    return originalFetch(input, init);
  };
}

// Install fetch fixtures at module load so React Query never sees a real network failure.
if (typeof window !== "undefined") {
  installStorybookApiFixtures();
}

function applyStorybookTheme(theme: "light" | "dark") {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function StorybookProviders({
  children,
  theme,
}: {
  children: ReactNode;
  theme: "light" | "dark";
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
          },
        },
      }),
  );

  if (typeof window !== "undefined") {
    installStorybookApiFixtures();
  }

  useEffect(() => {
    applyStorybookTheme(theme);
  }, [theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/PAP/storybook"]}>
          <CompanyProvider>
            <EditorAutocompleteProvider>
              <ToastProvider>
                <TooltipProvider>
                  <BreadcrumbProvider>
                    <SidebarProvider>
                      <PanelProvider>
                        <DialogProvider>{children}</DialogProvider>
                      </PanelProvider>
                    </SidebarProvider>
                  </BreadcrumbProvider>
                </TooltipProvider>
              </ToastProvider>
            </EditorAutocompleteProvider>
          </CompanyProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === "light" ? "light" : "dark";
      return (
        <StorybookProviders key={`${context.id}:${theme}`} theme={theme}>
          <Story />
        </StorybookProviders>
      );
    },
  ],
  globalTypes: {
    theme: {
      description: "Paperclip color mode",
      defaultValue: "dark",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    actions: { argTypesRegex: "^on[A-Z].*" },
    a11y: {
      test: "error",
    },
    backgrounds: {
      disable: true,
    },
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    docs: {
      toc: true,
    },
    layout: "fullscreen",
    viewport: {
      options: {
        ...MINIMAL_VIEWPORTS,
        mobile: {
          name: "Mobile",
          styles: { width: "390px", height: "844px" },
        },
        tablet: {
          name: "Tablet",
          styles: { width: "834px", height: "1112px" },
        },
        desktop: {
          name: "Desktop",
          styles: { width: "1440px", height: "960px" },
        },
      },
    },
  },

  /**
   * Every story starts without an onboarding draft.
   *
   * `localStorage` is per-origin and the preview frame keeps one for the whole
   * session, so a story that seeds a draft would otherwise hand it to whatever a
   * reviewer opens next: the wizard restores that saved step ahead of the step
   * the new story asked for, and the reviewer lands on a screen they never
   * clicked on.
   *
   * Cleared here rather than on the seeding story's unmount, deliberately.
   * Switching stories navigates the preview iframe, so the page is torn down
   * rather than React-unmounted and an unmount cleanup never runs — which is
   * exactly how the first attempt at this leaked anyway.
   */
  beforeEach: () => {
    try {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    } catch {
      // Storage access throws in some privacy modes; nothing to clean up there.
    }
  },
};

export default preview;
