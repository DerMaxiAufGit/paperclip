import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { aiConnectionRoutes, validateAiApiKey } from "../routes/ai-connections.js";

// A pasted Claude subscription token is refused as an AI connection API key
// before Paperclip sends it anywhere: not to Anthropic's /v1/models check, and
// not to another provider's endpoint.
const TOKENS = ["sk-ant-oat01-pasted", " SK-ANT-ORT01-refresh", "sk-ant-sid01-session"];
const PROVIDERS = ["anthropic", "openai", "openrouter", "xai"] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI connection API keys never take a Claude subscription token", () => {
  it("validateAiApiKey refuses a token with 422 before any network call", async () => {
    const providerRequest = vi.fn();
    for (const provider of PROVIDERS) {
      for (const key of TOKENS) {
        await expect(validateAiApiKey(provider, key, providerRequest)).rejects.toMatchObject({
          status: 422,
          message: CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE,
        });
      }
    }
    expect(providerRequest).not.toHaveBeenCalled();
  });

  it("POST /companies/:companyId/ai-connections answers 422 before any provider call or database access", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not reach a provider"));
    const companyId = randomUUID();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "session",
        userId: "owner",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      } as express.Request["actor"];
      next();
    });
    // Any database access would throw; the refusal must come first.
    app.use("/api", aiConnectionRoutes({} as never));
    app.use(errorHandler);

    for (const provider of PROVIDERS) {
      for (const apiKey of TOKENS) {
        const response = await request(app)
          .post(`/api/companies/${companyId}/ai-connections`)
          .send({ provider, method: "api_key", name: "Pasted", ownership: "personal", apiKey, agentIds: [], allAgents: false });
        expect(response.status).toBe(422);
        expect(response.body.error).toBe(CLAUDE_SUBSCRIPTION_TOKEN_UNSUPPORTED_MESSAGE);
        expect(JSON.stringify(response.body)).not.toMatch(/sk-ant-(oat|ort|sid)\d/i);
      }
    }
    expect(network).not.toHaveBeenCalled();
  });
});
