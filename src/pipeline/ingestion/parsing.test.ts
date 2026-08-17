import { describe, expect, it } from "vitest"

import {
  calendarComponentsValid,
  cleanDescription,
  decodeHtml,
  dedupKey,
  extractPrice,
  isoCalendarComponentsValid,
  parseIcalDate,
  parseIsoDate,
  stripHtml,
  stripShortcodes,
  unescapeIcalText,
  utcMinute,
} from "./parsing.js"

// Ported verbatim from family-events-backend _shared/parsing.test.ts (U28).

describe("parseIsoDate", () => {
  it("normalizes a valid ISO string to ISO UTC", () => {
    const result = parseIsoDate("2026-04-15T14:30:00Z")
    expect(result).toBe("2026-04-15T14:30:00.000Z")
  })

  it("returns null for null or undefined input", () => {
    expect(parseIsoDate(null)).toBeNull()
    expect(parseIsoDate(undefined)).toBeNull()
    expect(parseIsoDate("")).toBeNull()
  })

  it("returns null for an unparseable string", () => {
    expect(parseIsoDate("not a date")).toBeNull()
  })

  it("accepts common readable date formats", () => {
    // new Date() parses "Apr 15, 2026" in JS
    expect(parseIsoDate("Apr 15, 2026")).not.toBeNull()
  })

  it("rejects impossible calendar components instead of rolling them forward", () => {
    expect(parseIsoDate("2026-02-30T10:00:00Z")).toBeNull()
    expect(parseIsoDate("2026-13-01T10:00:00Z")).toBeNull()
    expect(parseIsoDate("2026-04-15T24:61:00Z")).toBeNull()
    // Leap-day handling stays correct in both directions.
    expect(parseIsoDate("2024-02-29T10:00:00Z")).toBe("2024-02-29T10:00:00.000Z")
    expect(parseIsoDate("2026-02-29T10:00:00Z")).toBeNull()
  })
})

describe("calendar component validation", () => {
  it("validates month/day/time ranges against the real calendar", () => {
    expect(calendarComponentsValid(2026, 2, 28)).toBe(true)
    expect(calendarComponentsValid(2026, 2, 30)).toBe(false)
    expect(calendarComponentsValid(2026, 0, 1)).toBe(false)
    expect(calendarComponentsValid(2026, 6, 1, 23, 59, 59)).toBe(true)
    expect(calendarComponentsValid(2026, 6, 1, 24, 0, 0)).toBe(false)
  })

  it("only judges ISO-shaped strings; other formats pass through", () => {
    expect(isoCalendarComponentsValid("2026-02-30T10:00:00Z")).toBe(false)
    expect(isoCalendarComponentsValid("2026-04-15")).toBe(true)
    expect(isoCalendarComponentsValid("Apr 15, 2026")).toBe(true)
  })
})

describe("parseIcalDate", () => {
  it("parses compact date-only (YYYYMMDD) as midnight UTC", () => {
    expect(parseIcalDate("20260415")).toBe("2026-04-15T00:00:00.000Z")
  })

  it("parses compact datetime with Z (YYYYMMDDTHHMMSSZ)", () => {
    expect(parseIcalDate("20260415T143000Z")).toBe("2026-04-15T14:30:00.000Z")
  })

  it("parses compact datetime without Z as UTC", () => {
    // "20260415T143000" — no trailing Z. Treated as UTC for consistency across environments.
    expect(parseIcalDate("20260415T143000")).toBe("2026-04-15T14:30:00.000Z")
  })

  it("falls back to parseIsoDate for other formats", () => {
    expect(parseIcalDate("2026-04-15T14:30:00Z")).toBe("2026-04-15T14:30:00.000Z")
  })

  it("returns null for null or invalid input", () => {
    expect(parseIcalDate(null)).toBeNull()
    expect(parseIcalDate("garbage")).toBeNull()
  })

  it("rejects compact stamps with impossible components", () => {
    expect(parseIcalDate("20260230")).toBeNull()
    expect(parseIcalDate("20261301")).toBeNull()
    expect(parseIcalDate("20260415T256000Z")).toBeNull()
  })
})

describe("decodeHtml", () => {
  it("decodes common named entities", () => {
    expect(decodeHtml("A &amp; B")).toBe("A & B")
    expect(decodeHtml("&lt;tag&gt;")).toBe("<tag>")
    expect(decodeHtml("&quot;hi&quot;")).toBe('"hi"')
    expect(decodeHtml("it&#39;s")).toBe("it's")
    expect(decodeHtml("Farmers &#038; Artisans &ndash; free&nbsp;event")).toBe(
      "Farmers & Artisans - free event"
    )
  })

  it("decodes hex numeric character references", () => {
    expect(decodeHtml("&#x1f331;")).toBe("🌱")
    expect(decodeHtml("&#x1f41c;")).toBe("🐜")
    expect(decodeHtml("Garden Talks &#x1f331; Dig in")).toBe("Garden Talks 🌱 Dig in")
  })

  it("decodes decimal numeric character references", () => {
    expect(decodeHtml("&#128049;")).toBe("🐱")
    expect(decodeHtml("Hello&#33;")).toBe("Hello!")
  })

  it("leaves non-entity text untouched", () => {
    expect(decodeHtml("plain text")).toBe("plain text")
  })
})

describe("unescapeIcalText", () => {
  it("unescapes iCal comma sequences", () => {
    expect(unescapeIcalText("Louisville Zoo\\, 1100 Trevilian Way\\, KY")).toBe(
      "Louisville Zoo, 1100 Trevilian Way, KY"
    )
  })

  it("unescapes iCal semicolon sequences", () => {
    expect(unescapeIcalText("Event 1\\; Event 2")).toBe("Event 1; Event 2")
  })

  it("converts \\n to a space", () => {
    expect(unescapeIcalText("Line 1\\nLine 2")).toBe("Line 1 Line 2")
    expect(unescapeIcalText("Line 1\\NLine 2")).toBe("Line 1 Line 2")
  })

  it("unescapes double-backslash to single backslash", () => {
    expect(unescapeIcalText("path\\\\to\\\\file")).toBe("path\\to\\file")
  })

  it("keeps an escaped backslash before n as backslash + n (single-pass)", () => {
    // \\n in the wire format is an escaped backslash followed by a literal n —
    // the old sequential replace consumed it as a newline escape instead.
    expect(unescapeIcalText("a\\\\nb")).toBe("a\\nb")
  })

  it("leaves plain text alone", () => {
    expect(unescapeIcalText("just plain text")).toBe("just plain text")
  })
})

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world")
  })

  it("decodes entities after stripping tags", () => {
    expect(stripHtml("<p>A &amp; B</p>")).toBe("A & B")
  })

  it("trims leading and trailing whitespace", () => {
    expect(stripHtml("   <span>text</span>   ")).toBe("text")
  })

  it("handles self-closing tags", () => {
    expect(stripHtml("before<br/>after")).toBe("before after")
  })

  it("adds spaces before labels that source HTML runs together", () => {
    expect(stripHtml("May 26Time: 5:30–6:30 PMWhat to Bring: gloves")).toBe(
      "May 26 Time: 5:30-6:30 PM What to Bring: gloves"
    )
  })
})

describe("extractPrice", () => {
  it("detects 'free' keyword", () => {
    expect(extractPrice("Free concert")).toEqual({ price: null, isFree: true })
  })

  it("detects 'free admission'", () => {
    expect(extractPrice("Event — Free Admission for kids")).toEqual({
      price: null,
      isFree: true,
    })
  })

  it("detects complimentary", () => {
    expect(extractPrice("Complimentary snacks provided")).toEqual({
      price: null,
      isFree: true,
    })
  })

  it("extracts integer dollar amounts", () => {
    expect(extractPrice("Tickets: $25")).toEqual({ price: 25, isFree: false })
  })

  it("extracts decimal dollar amounts", () => {
    expect(extractPrice("Cost $12.50")).toEqual({ price: 12.5, isFree: false })
  })

  it("returns null price when no info present", () => {
    expect(extractPrice("See website for details")).toEqual({
      price: null,
      isFree: false,
    })
  })

  it("free patterns beat dollar-sign patterns", () => {
    expect(extractPrice("Free event, $5 suggested donation")).toEqual({
      price: null,
      isFree: true,
    })
  })

  it("does not classify negated free wording as free admission", () => {
    expect(extractPrice("Admission is not free; tickets are $12")).toEqual({
      price: 12,
      isFree: false,
    })
    expect(extractPrice("This event isn't free")).toEqual({ price: null, isFree: false })
  })
})

describe("dedupKey", () => {
  it("produces identical keys for same event across sources", () => {
    const a = dedupKey("Family Yoga", "2026-04-15T10:00:00Z", "city-1")
    const b = dedupKey("Family Yoga", "2026-04-15T10:00:00Z", "city-1")
    expect(a).toBe(b)
  })

  it("normalizes title case and whitespace", () => {
    const a = dedupKey("Family Yoga", "2026-04-15T10:00:00Z", "city-1")
    const b = dedupKey("  family YOGA  ", "2026-04-15T10:00:00Z", "city-1")
    expect(a).toBe(b)
  })

  it("truncates to minute precision", () => {
    // Seconds-level drift between sources should still collide
    const a = dedupKey("Event", "2026-04-15T10:00:00Z", "city-1")
    const b = dedupKey("Event", "2026-04-15T10:00:45Z", "city-1")
    expect(a).toBe(b)
  })

  it("produces different keys for different cities", () => {
    const a = dedupKey("Event", "2026-04-15T10:00:00Z", "city-1")
    const b = dedupKey("Event", "2026-04-15T10:00:00Z", "city-2")
    expect(a).not.toBe(b)
  })

  it("handles null city gracefully", () => {
    expect(dedupKey("Event", "2026-04-15T10:00:00Z", null)).toContain("null::")
  })

  it("produces different keys for different times (minute-level)", () => {
    const a = dedupKey("Event", "2026-04-15T10:00:00Z", "c")
    const b = dedupKey("Event", "2026-04-15T11:00:00Z", "c")
    expect(a).not.toBe(b)
  })

  it("collapses equivalent instants written with different offsets", () => {
    const a = dedupKey("Event", "2026-04-15T10:00:00Z", "c")
    const b = dedupKey("Event", "2026-04-15T05:00:00-05:00", "c")
    expect(a).toBe(b)
  })

  it("falls back to raw slicing for invalid timestamps without throwing", () => {
    expect(utcMinute("not-a-date-at-all")).toBe("not-a-date-at-al")
    expect(dedupKey("Event", "not-a-date-at-all", "c")).toContain("not-a-date-at-al")
  })
})

describe("stripShortcodes", () => {
  it("removes Divi opening shortcodes with attributes", () => {
    const input = `[et_pb_section fb_built="1" _builder_version="4.16"]Hello`
    expect(stripShortcodes(input)).toBe("Hello")
  })

  it("removes Divi closing shortcodes", () => {
    expect(stripShortcodes("Hello[/et_pb_section]")).toBe("Hello")
  })

  it("removes nested Divi blocks", () => {
    const input = `[et_pb_row column_structure="2_5,3_5"][et_pb_column type="2_5"]Content[/et_pb_column][/et_pb_row]`
    expect(stripShortcodes(input)).toBe("Content")
  })

  it("removes generic WordPress shortcodes", () => {
    expect(stripShortcodes(`[caption id="x"]My caption[/caption]`)).toBe("My caption")
    expect(stripShortcodes("[gallery]")).toBe("")
  })

  it("leaves bracket prose containing spaces alone", () => {
    expect(stripShortcodes("[See more details below]")).toBe("[See more details below]")
  })

  it("strips trailing unclosed Divi shortcode (slice-before-clean legacy)", () => {
    const input = `[et_pb_section fb_built="1"]Hello[et_pb_image src="https://example.org/x.png" title_text="Rock the Block"`
    expect(stripShortcodes(input)).toBe("Hello")
  })

  it("strips trailing unclosed generic shortcode but keeps unclosed prose", () => {
    expect(stripShortcodes(`Hello[caption id="x"`)).toBe("Hello")
    expect(stripShortcodes("Hello [See details")).toBe("Hello [See details")
  })
})

describe("cleanDescription", () => {
  it("returns empty string for nullish input", () => {
    expect(cleanDescription(null)).toBe("")
    expect(cleanDescription(undefined)).toBe("")
    expect(cleanDescription("")).toBe("")
  })

  it("strips Divi shortcodes and HTML together", () => {
    const input = `[et_pb_section fb_built="1"]<p>Welcome to Rock the Block!</p>[/et_pb_section]`
    expect(cleanDescription(input)).toBe("Welcome to Rock the Block!")
  })

  it("decodes entities and normalizes whitespace", () => {
    const input = `<p>Tom&nbsp;&amp;&nbsp;Jerry&rsquo;s   show</p>`
    expect(cleanDescription(input)).toBe("Tom & Jerry's show")
  })

  it("handles the Rock the Block fixture", () => {
    const input = `[et_pb_section fb_built="1" _builder_version="4.16" global_colors_info="{}"][et_pb_row column_structure="2_5,3_5" _builder_version="4.27.6" background_size="initial" background_position="top_left" background_repeat="repeat" global_colors_info="{}"][et_pb_column type="2_5" _builder_version="4.16"][et_pb_image src="https://example.org/img.png" title_text="Rock the Block"][/et_pb_image][/et_pb_column][/et_pb_row][/et_pb_section]Welcome to Rock the Block!`
    const out = cleanDescription(input)
    expect(out).not.toContain("et_pb")
    expect(out).not.toContain("[")
    expect(out).toContain("Welcome to Rock the Block!")
  })

  it("cleans the 500-char-truncated Rock the Block DB row", () => {
    const truncated = `[et_pb_section fb_built="1" _builder_version="4.16" global_colors_info="{}"][et_pb_row column_structure="2_5,3_5" _builder_version="4.27.6" background_size="initial" background_position="top_left" background_repeat="repeat" global_colors_info="{}"][et_pb_column type="2_5" _builder_version="4.16" custom_padding="|||" global_colors_info="{}" custom_padding__hover="|||"][et_pb_image src="https://acadianacenterforthearts.org/wp-content/uploads/2026/04/Rock-the-Block.png" title_text="Rock the Block" `
    const out = cleanDescription(truncated)
    expect(out).not.toContain("et_pb")
    expect(out).not.toContain("[")
  })
})
