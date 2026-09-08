import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import {
  parseAdminCreateSourceBody,
  parseAdminSourceId,
  parseAdminSourceProcessingModeBody,
  parseAdminSourceScrapeBody,
  parseAdminSourcesQuery,
  parseAdminUpdateSourceBody,
} from "./admin-source.input.js"

const ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"

describe("admin source input", () => {
  it("parses a create body with defaults and camelCase internals", () => {
    expect(
      parseAdminCreateSourceBody({
        name: "  Library Calendar  ",
        url: "  https://example.com/events  ",
        source_type: "website",
        extraction_mode: "deterministic_then_llm",
        processing_mode: "llm_review",
      })
    ).toEqual({
      name: "Library Calendar",
      url: "https://example.com/events",
      sourceType: "website",
      extractionMode: "deterministic_then_llm",
      processingMode: "llm_review",
      cityId: null,
      isActive: true,
      scrapeIntervalHours: 24,
      notes: null,
      dateWindowDays: null,
    })
  })

  it("preserves omitted and explicit-null update fields", () => {
    expect(
      parseAdminUpdateSourceBody({
        city_id: null,
        notes: null,
        date_window_days: 30,
        is_active: false,
      })
    ).toEqual({
      cityId: null,
      notes: null,
      dateWindowDays: 30,
      isActive: false,
    })
  })

  it("normalizes IDs and parses processing modes", () => {
    expect(parseAdminSourceId(ID)).toBe(ID.toLowerCase())
    expect(parseAdminSourceProcessingModeBody({ mode: "auto_approve" })).toBe("auto_approve")
  })

  it.each([
    [{}, "name"],
    [
      {
        name: "Source",
        url: "https://example.com",
        source_type: "unknown",
        extraction_mode: "deterministic",
        processing_mode: "manual_review",
      },
      "source_type",
    ],
    [
      {
        name: "Source",
        url: "http://127.0.0.1/events",
        source_type: "website",
        extraction_mode: "deterministic",
        processing_mode: "manual_review",
      },
      "url",
    ],
    [
      {
        name: "Source",
        url: "ftp://example.com/events",
        source_type: "website",
        extraction_mode: "deterministic",
        processing_mode: "manual_review",
      },
      "url",
    ],
    [
      {
        name: "Source",
        url: "https://example.com",
        source_type: "website",
        extraction_mode: "deterministic",
        processing_mode: "manual_review",
        actor_id: ID,
      },
      "actor_id",
    ],
  ])("rejects invalid create input at %s", (body, path) => {
    expectInvalid(() => parseAdminCreateSourceBody(body), path)
  })

  it.each([
    [{}, ""],
    [{ processing_mode: "auto_approve" }, "processing_mode"],
    [{ auto_approve: true }, "auto_approve"],
    [{ last_status: "error" }, "last_status"],
    [{ scrape_interval_hours: 0 }, "scrape_interval_hours"],
    [{ scrape_interval_hours: 8761 }, "scrape_interval_hours"],
    [{ date_window_days: 0 }, "date_window_days"],
    [{ date_window_days: 366 }, "date_window_days"],
    [{ city_id: "bad" }, "city_id"],
    [{ name: "x".repeat(301) }, "name"],
    [{ url: "https://example.com/" + "x".repeat(2049) }, "url"],
    [{ notes: "x".repeat(5001) }, "notes"],
  ])("rejects invalid update input at %s", (body, path) => {
    expectInvalid(() => parseAdminUpdateSourceBody(body), path)
  })

  it.each([
    [{ mode: "invalid" }, "mode"],
    [{ mode: "manual_review", actor_id: ID }, "actor_id"],
  ])("rejects invalid processing mode body", (body, path) => {
    expectInvalid(() => parseAdminSourceProcessingModeBody(body), path)
  })

  it("rejects unknown list queries and scrape body fields", () => {
    expect(() => parseAdminSourcesQuery({ actor_id: ID })).toThrow(BadRequestException)
    expect(() => parseAdminSourceScrapeBody({ actor_id: ID })).toThrow(BadRequestException)
    expect(parseAdminSourcesQuery({})).toBeUndefined()
    expect(parseAdminSourceScrapeBody(undefined)).toBeUndefined()
    expect(parseAdminSourceScrapeBody({})).toBeUndefined()
  })
})

function expectInvalid(work: () => unknown, path: string): void {
  try {
    work()
    throw new Error("expected parser failure")
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException)
    expect((error as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      message: expect.any(String),
      error: "Bad Request",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: path ? expect.stringMatching(`^${path}`) : "",
        }),
      ]),
    })
  }
}
