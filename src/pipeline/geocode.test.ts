import { describe, expect, it } from "vitest"
import { buildGeocodeQuery } from "./geocode.js"

// Ported from family-events-backend supabase/functions/_shared/geocode.test.ts (U29)

describe("buildGeocodeQuery", () => {
  it("address with same city+state as parts does not duplicate", () => {
    expect(
      buildGeocodeQuery({
        address: "444 Cajundome Blvd, Lafayette, LA, 70506",
        venueName: "Cajundome",
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("444 Cajundome Blvd, Lafayette, LA, 70506")
  })

  it("address with different city but inline state is returned unchanged", () => {
    // city_id points to Lafayette but venue is in Broussard — hasInlineState fires
    expect(
      buildGeocodeQuery({
        address: "701 St. Nazaire, Broussard, LA, 70518",
        venueName: null,
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("701 St. Nazaire, Broussard, LA, 70518")
  })

  it("venueName-only with no inline state appends city+state", () => {
    expect(
      buildGeocodeQuery({
        address: null,
        venueName: "Moncus Park",
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("Moncus Park, Lafayette, LA")
  })

  it("null address and null venueName returns null", () => {
    expect(
      buildGeocodeQuery({
        address: null,
        venueName: null,
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBeNull()
  })

  it("address with inline state but null cityName/cityState returned unchanged", () => {
    expect(
      buildGeocodeQuery({
        address: "123 Main St, Houston, TX, 77001",
        venueName: null,
        cityName: null,
        cityState: null,
      })
    ).toBe("123 Main St, Houston, TX, 77001")
  })

  it("address with no state and cityName provided appends city", () => {
    expect(
      buildGeocodeQuery({
        address: "301 W Congress St",
        venueName: null,
        cityName: "Lafayette",
        cityState: null,
      })
    ).toBe("301 W Congress St, Lafayette")
  })

  it("address ending in ', LA' (no zip) returned unchanged", () => {
    expect(
      buildGeocodeQuery({
        address: "123 Main St, Lafayette, LA",
        venueName: null,
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("123 Main St, Lafayette, LA")
  })

  it("city in address but no state appends state only", () => {
    expect(
      buildGeocodeQuery({
        address: "123 Main, Lafayette",
        venueName: null,
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("123 Main, Lafayette, LA")
  })
})
