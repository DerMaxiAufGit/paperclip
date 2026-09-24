import { useState } from "react";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { LocalProviderLoginInstructions, ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import type {
  AiConnectionBinding,
  AiConnectionRequirement,
  AiConnectionSummary,
} from "./model";

const requirement: AiConnectionRequirement = {
  companyId: "design-example",
  provider: "openai",
  method: "subscription",
};
const account: AiConnectionSummary = {
  ...requirement,
  method: "subscription",
  id: "example",
  grantId: "example-grant",
  name: "My ChatGPT subscription",
  ownership: "personal",
  ownerUserId: "example-user",
  ownerName: "You",
  status: "connected",
  isDefault: true,
};

export function AiConnectionDesignExamples() {
  const [binding, setBinding] = useState<AiConnectionBinding>({
    provider: "openai",
    method: "subscription",
    mode: "responsible_user",
  });
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Shared AI connection identity, account selection, and existing
        authentication chrome. The full interactive state matrix lives in
        Storybook under AI Connections / Review. Example controls below do not
        connect accounts.
      </p>
      <p className="text-sm text-muted-foreground">Provider lists and account management use Browse and AppDetail from the Connectors interface. The picker below uses ConnectionChoiceList, also used by ConnectionSetupFlow.</p>
      <AiConnectionPicker
        requirement={requirement}
        connections={[account]}
        value={binding}
        currentUserId="example-user"
        agentId="example-agent"
        agentName="Nova"
        onChange={setBinding}
        readOnly
        onConnect={() => {}}
      />
      <ProviderApiKeyCard
        providerName="OpenAI"
        value=""
        disabled
        onChange={() => {}}
        onSubmit={() => {}}
        placeholder="Enter API key here"
      />
      <LocalProviderLoginInstructions
        adapterType="codex_local"
        login={{ preparing: false, status: "sign_in_required", error: null,
          command: "CODEX_HOME='/example/connection-login' codex login --device-auth", retry: () => {} }}
      />
    </div>
  );
}
