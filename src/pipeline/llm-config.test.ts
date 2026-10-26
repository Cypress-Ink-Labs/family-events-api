import { describe, expect, it } from "vitest"

import {
  resolveEmbeddingCredentials,
  resolveSharedLlmConfig,
  type EnvReader,
} from "./llm-config.js"

function env(values: Record<string, string>): EnvReader {
  return { get: (name) => values[name] }
}

const descriptor = {
  allowedOpenAiModels: new Set(["gpt-4o-mini"]),
  defaultOpenAiModel: "gpt-4o-mini",
}

describe("resolveSharedLlmConfig", () => {
  it("defaults to the gateway and GPT-6 Luna when the gateway key is set", () => {
    expect(
      resolveSharedLlmConfig(
        descriptor,
        env({ AI_GATEWAY_API_KEY: "vck_test", OPENAI_MODEL: "gpt-4o-mini" })
      )
    ).toEqual({
      apiKey: "vck_test",
      baseUrl: "",
      configured: true,
      enabled: true,
      model: "openai/gpt-6-luna",
      provider: "gateway",
    })
  })

  it("keeps the gateway default for a GPT-6 Luna assignment instead of the legacy OpenAI allowlist", () => {
    const config = resolveSharedLlmConfig(
      {
        ...descriptor,
        dbOverride: { enabled: true, modelId: "openai/gpt-6-luna-fast", provider: "gateway" },
      },
      env({ AI_GATEWAY_API_KEY: "vck_test", OPENAI_API_KEY: "sk-legacy" })
    )
    expect(config).toEqual({
      apiKey: "vck_test",
      baseUrl: "",
      configured: true,
      enabled: true,
      model: "openai/gpt-6-luna-fast",
      provider: "gateway",
    })
  })

  it("keeps an approved gateway model from the feature assignment", () => {
    const config = resolveSharedLlmConfig(
      {
        ...descriptor,
        dbOverride: { enabled: true, modelId: "spacexai/grok-4.3", provider: "gateway" },
      },
      env({ AI_GATEWAY_API_KEY: "vck_test" })
    )
    expect(config).toMatchObject({ provider: "gateway", model: "spacexai/grok-4.3" })
  })

  it("is unconfigured for a gateway assignment without the key", () => {
    const config = resolveSharedLlmConfig(
      {
        ...descriptor,
        dbOverride: { enabled: true, modelId: "spacexai/grok-4.3", provider: "gateway" },
      },
      env({ OPENAI_API_KEY: "sk-legacy" })
    )
    expect(config).toMatchObject({ provider: "gateway", configured: false })
  })

  it("keeps the legacy OpenAI path when no gateway key is set or a legacy model is assigned", () => {
    expect(resolveSharedLlmConfig(descriptor, env({ OPENAI_API_KEY: "sk-legacy" }))).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-legacy",
      configured: true,
    })
    expect(
      resolveSharedLlmConfig(
        {
          ...descriptor,
          dbOverride: { enabled: true, modelId: "gpt-4o-mini", provider: "openai" },
        },
        env({ AI_GATEWAY_API_KEY: "vck_test", OPENAI_API_KEY: "sk-legacy" })
      )
    ).toMatchObject({ provider: "openai", apiKey: "sk-legacy" })
  })
})

describe("resolveEmbeddingCredentials", () => {
  it("prefers the gateway key, then the legacy OpenAI key", () => {
    expect(
      resolveEmbeddingCredentials(env({ AI_GATEWAY_API_KEY: "vck", OPENAI_API_KEY: "sk" }))
    ).toEqual({ provider: "gateway", apiKey: "vck" })
    expect(resolveEmbeddingCredentials(env({ OPENAI_API_KEY: "sk" }))).toEqual({
      provider: "openai",
      apiKey: "sk",
    })
    expect(resolveEmbeddingCredentials(env({}))).toBeNull()
  })
})
