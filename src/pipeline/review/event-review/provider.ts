import { GATEWAY_PROVIDER, generateGatewayText, type GatewayModels } from "../../llm-gateway.js"
import { postOpenAiChatCompletion } from "../../llm-openai.js"
import type {
  LlmReviewConfig,
  LlmReviewProvider,
  LlmReviewProviderInput,
  LlmReviewProviderOutput,
} from "./types.js"

type FetchLike = typeof fetch

export class OpenAiCompatibleReviewProvider implements LlmReviewProvider {
  constructor(
    private readonly config: LlmReviewConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async review(
    input: LlmReviewProviderInput,
    signal: AbortSignal
  ): Promise<LlmReviewProviderOutput> {
    const result = await postOpenAiChatCompletion({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      body: {
        model: input.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      },
      fetchImpl: this.fetchImpl,
      failureMessagePrefix: "LLM review",
      providerName: this.config.provider,
      signal,
      timeoutMs: this.config.timeoutMs,
      telemetry: { feature: "event-review", provider: this.config.provider, model: input.model },
    })

    return {
      rawText: result.content,
      rawResponse: result.raw,
      provider: this.config.provider,
      model: this.config.model,
    }
  }
}

export class GatewayReviewProvider implements LlmReviewProvider {
  constructor(
    private readonly config: LlmReviewConfig,
    private readonly models?: GatewayModels
  ) {}

  async review(
    input: LlmReviewProviderInput,
    signal: AbortSignal
  ): Promise<LlmReviewProviderOutput> {
    const result = await generateGatewayText({
      apiKey: this.config.apiKey,
      model: input.model,
      system: input.systemPrompt,
      prompt: input.userPrompt,
      temperature: 0,
      feature: "event-review",
      failureMessagePrefix: "LLM review",
      signal,
      timeoutMs: this.config.timeoutMs,
      models: this.models,
    })

    return {
      rawText: result.content,
      rawResponse: result.raw,
      provider: GATEWAY_PROVIDER,
      model: this.config.model,
    }
  }
}

export function buildLlmReviewProvider(
  config: LlmReviewConfig,
  fetchImpl: FetchLike = fetch
): LlmReviewProvider {
  return config.provider === GATEWAY_PROVIDER
    ? new GatewayReviewProvider(config)
    : new OpenAiCompatibleReviewProvider(config, fetchImpl)
}
