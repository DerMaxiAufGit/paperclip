import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { OnboardingCardField, OnboardingLoginCard, OnboardingLoginCodeRow } from "@/components/AdapterLoginChrome";
import { ClaudeCliSignInStatus } from "@/components/ClaudeCliSignInStatus";
import { ModelSourceTiles } from "@/components/onboarding/ModelSourceTiles";
import { CredentialModeLink } from "@/components/onboarding/CredentialModeLink";
import { FooterNav } from "@/components/onboarding/FooterNav";
import { CARD_ENTER, CARD_EXIT, CONNECTED_HOLD_MS, MAKE_ROOM, MAKE_ROOM_MS, SOURCE_COLLAPSE_MS, SOURCE_LINK_EXIT, beatDelay } from "@/components/onboarding/onboarding-motion";
import { PREVIEW_COMPANY_ID } from "./new-agent-fixtures";

export type ConnectionMethod = "subscription" | "api";
export type ConnectionProvider = "Claude" | "OpenAI";
type Phase = "idle" | "collapsing" | "opening" | "ready" | "waiting" | "connecting";

/** The shipped onboarding presentation and choreography, with a local provider
 * simulator. Example keys/codes never leave React state or reach storage.
 *
 * A Claude subscription is the claude CLI signed in on the server itself, so
 * its card is the shipped `ClaudeCliSignInStatus` (answered by the Storybook
 * auth-signal fixture) and Connect only tests it. `apiKeyOnly` is for Claude
 * through a runner, which works with an Anthropic API key only. */
export function ProviderConnectionPreview({ provider, apiKeyOnly = false, initialMethod = "subscription", initialWaiting = false, onConnected }: {
  provider: ConnectionProvider;
  apiKeyOnly?: boolean;
  initialMethod?: ConnectionMethod;
  /** Open on the sign-in in progress. Claude has no sign-in to wait for, so it opens on the CLI status. */
  initialWaiting?: boolean;
  onConnected: (method: ConnectionMethod) => void;
}) {
  const [method, setMethod] = useState<ConnectionMethod>(apiKeyOnly ? "api" : initialMethod);
  const claudeCli = provider === "Claude" && method === "subscription";
  const [phase, setPhase] = useState<Phase>(initialWaiting ? (claudeCli ? "ready" : "waiting") : method === "api" ? "ready" : "idle");
  const [value, setValue] = useState("");
  useEffect(() => {
    const next = phase === "collapsing" ? "opening" : phase === "opening" ? "ready" : null;
    if (!next && phase !== "connecting") return;
    const duration = phase === "collapsing" ? SOURCE_COLLAPSE_MS : phase === "opening" ? MAKE_ROOM_MS : CONNECTED_HOLD_MS;
    const timer = window.setTimeout(() => next ? setPhase(next) : onConnected(method), beatDelay(duration));
    return () => window.clearTimeout(timer);
  }, [phase, method, onConnected]);
  const finish = () => {
    if (method === "api" && !value.trim()) return;
    setValue(""); setPhase("connecting");
  };
  const cancel = () => { setValue(""); setPhase("idle"); };
  const cardSpace = phase !== "idle" && phase !== "collapsing";
  const live = cardSpace && phase !== "opening";
  const connecting = phase === "connecting";
  const connectsDirectly = method === "api" || claudeCli;
  return <div>
    <ModelSourceTiles label="Connect your model provider" sources={[{
      id: provider, label: provider,
      icon: <img src={provider === "Claude" ? "/brands/claude-color.svg" : "/brands/codex-color.svg"} alt="" className="size-6" />,
    }]} mode={method} selectedId={phase === "idle" ? null : provider} collapsed={phase !== "idle"}
      onSelect={() => { if (phase === "idle") setPhase("collapsing"); }} />
    {!apiKeyOnly && <motion.div className="overflow-hidden" inert={phase !== "idle"} initial={false}
      animate={{ opacity: phase === "idle" ? 1 : 0, height: cardSpace ? 0 : "auto" }}
      transition={{ opacity: SOURCE_LINK_EXIT, height: MAKE_ROOM }}>
      <div className="-ml-3 mt-1"><CredentialModeLink mode={method} onChange={setMethod} /></div>
    </motion.div>}
    <motion.div className="overflow-hidden" inert={!live} initial={false}
      animate={{ height: cardSpace ? "auto" : 0, opacity: live ? 1 : 0 }}
      transition={{ height: MAKE_ROOM, opacity: live ? { ...CARD_ENTER, delay: MAKE_ROOM.duration } : CARD_EXIT }}>
      {cardSpace && <div className="pt-5">
        {claudeCli ? <ClaudeCliSignInStatus companyId={PREVIEW_COMPANY_ID} /> : <OnboardingLoginCard loading={!live} instruction={method === "api"
          ? `Provide your ${provider} API key to connect`
          : <><button type="button" className="underline underline-offset-2" onClick={() => setPhase("waiting")}>Sign in to {provider}</button> and enter this code</>}>
          {method === "api"
            ? <OnboardingCardField label="API key" placeholder="Enter API key here"
                masked autoFocus value={value} onChange={setValue} onSubmit={finish} disabled={connecting} />
            : <OnboardingLoginCodeRow code="STORY-BOOK" />}
        </OnboardingLoginCard>}
      </div>}
    </motion.div>
    <FooterNav onBack={phase !== "idle" ? cancel : undefined}
      primaryLabel={connecting ? "Connecting" : phase === "idle" ? "Next" : connectsDirectly ? "Connect" : phase === "waiting" ? "Waiting for code" : `Sign in to ${provider}`}
      primaryDisabled={phase === "idle" || phase === "collapsing" || phase === "opening" || (method === "api" && !value.trim()) || phase === "waiting"}
      loading={connecting} primaryIcon={connecting || phase === "waiting" ? "spinner" : connectsDirectly ? "arrow" : "none"}
      onPrimary={() => connectsDirectly ? finish() : setPhase("waiting")} />
    {!connectsDirectly && phase === "waiting" &&
      <div className="mt-6 text-center"><Button variant="ghost" size="sm" onClick={finish}>Simulate completed sign-in</Button></div>}
  </div>;
}
