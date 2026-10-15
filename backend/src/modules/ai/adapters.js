import env from "../../config/env.js";
import { AppError, ServiceUnavailableError } from "../../lib/errors.js";
import { getProviderConfig } from "./registry.js";

/**
 * Provider adapters.
 *
 * Each adapter is responsible for exactly one transport style. The orchestration
 * layer below does not know about OpenAI/Anthropic specifics; it only asks an
 * adapter for a chat completion and a plain-text answer.
 */
const adapters = {
  openai: {
    name: "openai",
    label: "OpenAI compatible",
    async chatCompletions(messages, { model, timeoutMs, jsonMode = true }) {
      const baseUrl = (model?.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

      const send = async (useJson) => {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${model?.apiKey ?? ""}`,
          },
          body: JSON.stringify({
            model: model?.chatModel ?? "gpt-4o-mini",
            messages,
            temperature: 0,
            max_tokens: model?.maxOutputTokens ?? 900,
            // Intent parsing wants a JSON object; grounded answers and summaries
            // want plain prose. JSON.stringify drops the key when undefined.
            ...(useJson ? { response_format: { type: "json_object" } } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs ?? 25000),
        });
        const text = await response.text().catch(() => "");
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }
        return { response, text, payload };
      };

      let { response, text, payload } = await send(jsonMode);

      // Some OpenAI-compatible models reject `response_format`. If the only
      // problem is JSON mode, retry once as plain text rather than failing the
      // whole target.
      if (
        !response.ok &&
        jsonMode &&
        response.status === 400 &&
        /response_format|json/i.test(text)
      ) {
        ({ response, text, payload } = await send(false));
      }

      if (!response.ok) {
        throw new AppError("AI provider returned an error", {
          status: response.status,
          code: "AI_PROVIDER_ERROR",
          details: text.slice(0, 300),
        });
      }

      // Aggregators such as OpenRouter answer 200 with an `error` object in the
      // body when the upstream model fails. Treat that as a provider error so
      // the orchestrator fails over to the next target.
      if (payload && payload.error) {
        throw new AppError("AI provider returned an error", {
          status: 502,
          code: "AI_PROVIDER_ERROR",
          details: String(payload.error?.message ?? payload.error).slice(0, 300),
        });
      }

      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new AppError("AI provider returned an unusable response", {
          status: 502,
          code: "AI_BAD_RESPONSE",
        });
      }
      return content;
    },
  },
  anthropic: {
    name: "anthropic",
    label: "Anthropic",
    async chatCompletions(messages, { model, timeoutMs }) {
      const baseUrl = (model?.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
      const response = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${model?.apiKey ?? ""}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "messages-2023-12-15",
        },
        body: JSON.stringify({
          model: model?.chatModel ?? "claude-3-5-haiku-20241022",
          max_tokens: model?.maxOutputTokens ?? 900,
          system: messages.find((m) => m.role === "system")?.content ?? "",
          messages: messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: AbortSignal.timeout(timeoutMs ?? 25000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AppError("AI provider returned an error", {
          status: response.status,
          code: "AI_PROVIDER_ERROR",
          details: body.slice(0, 300),
        });
      }

      const payload = await response.json();
      const content = payload?.content?.[0]?.text;
      if (typeof content !== "string") {
        throw new AppError("AI provider returned an unusable response", {
          status: 502,
          code: "AI_BAD_RESPONSE",
        });
      }
      return content;
    },
  },
};

export function getAdapter(provider = env.AI_PROVIDER) {
  const config = getProviderConfig(provider);
  if (!config) throw new ServiceUnavailableError(`AI provider ${provider ?? "none"} is not configured`);
  const adapter = adapters[config.key];
  if (!adapter) throw new ServiceUnavailableError(`AI provider ${provider} has no adapter`);
  return adapter;
}

/** Resolve the transport adapter for a registry target (see registry.getTargets). */
export function getAdapterFor(target) {
  const key = target?.adapter ?? target?.provider;
  const adapter = adapters[key];
  if (!adapter) throw new ServiceUnavailableError(`AI target ${target?.id ?? "unknown"} has no adapter`);
  return adapter;
}

/** Model selection helpers (deterministic, no model ids invented). */
export const MODEL_TIERS = {
  QUICK: "QUICK",
  THINK: "THINK",
  EXTENDED: "EXTENDED",
};

/** Default tier per AI task. */
export const DEFAULT_TIER = {
  chat: MODEL_TIERS.QUICK,
  reasoning: MODEL_TIERS.THINK,
  generation: MODEL_TIERS.THINK,
  summarization: MODEL_TIERS.QUICK,
  planning: MODEL_TIERS.THINK,
};

/** Map tier -> config key, leaving model ids to env so no hardcoded model ids. */
export function modelForTier(tier = DEFAULT_TIER.chat, provider = env.AI_PROVIDER) {
  const config = getProviderConfig(provider);
  if (!config) return null;
  const key = tier === MODEL_TIERS.EXTENDED ? "extendedModel" : tier === MODEL_TIERS.THINK ? "thinkingModel" : "quickModel";
  return config.config[key] ?? config.config.chatModel ?? null;
}
