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
    _signal: AbortSignal
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
      timeoutMs: this.config.timeoutMs,
    })

    return {
      rawText: result.content,
      rawResponse: result.raw,
      provider: this.config.provider,
      model: this.config.model,
    }
  }
}

export function buildLlmReviewProvider(
  config: LlmReviewConfig,
  fetchImpl: FetchLike = fetch
): LlmReviewProvider {
  return new OpenAiCompatibleReviewProvider(config, fetchImpl)
}
