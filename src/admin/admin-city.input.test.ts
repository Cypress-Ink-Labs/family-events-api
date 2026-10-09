import { describe, expect, it } from "vitest"
import { parseAdminCreateCity } from "./admin-city.input.js"

const city = { name: "Lafayette", slug: "lafayette", timezone: "America/Chicago" }

describe("city country input", () => {
  it("defaults to US and normalizes two-letter country codes", () => {
    expect(parseAdminCreateCity(city).country).toBe("US")
    expect(parseAdminCreateCity({ ...city, country: " us " }).country).toBe("US")
  })

  it.each(["United States", "USA", "us,ca", "1U", ""])("rejects invalid country %s", (country) => {
    expect(() => parseAdminCreateCity({ ...city, country })).toThrow("invalid city request")
  })
})
