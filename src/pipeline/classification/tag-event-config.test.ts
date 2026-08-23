import { describe, expect, it } from "vitest"

import { resolveTagEventAiConfig, resolveTagEventOpenAiModel } from "./tag-event-config.js"

// Ported from family-events-backend supabase/functions/tag-event/config_test.ts
// (U29), converted from Deno.test to vitest. Assertions unchanged.

describe("resolveTagEventOpenAiModel", () => {
  it("falls back to default", () => {
    expect(resolveTagEventOpenAiModel("bad-model")).toBe("gpt-4o-mini")
    expect(resolveTagEventOpenAiModel("gpt-4.1-nano")).toBe("gpt-4.1-nano")
  })
})

describe("resolveTagEventAiConfig", () => {
  it("keeps disabled db model but unconfigures", () => {
    const config = resolveTagEventAiConfig({
      enabled: false,
      modelId: "gpt-4.1-nano",
      provider: "openai",
    })
    expect(config.configured).toBe(false)
    expect(config.model).toBe("gpt-4.1-nano")
  })
})
