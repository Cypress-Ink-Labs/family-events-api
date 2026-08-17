// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/rss.ts (U28).
// Deviation: npm:fast-xml-parser@4.5.0 specifier replaced with bare fast-xml-parser import.

import { XMLParser } from "fast-xml-parser"
import { cleanDescription, decodeHtml, extractPrice, parseIsoDate, stripHtml } from "../parsing.js"
import { validateExternalUrl } from "../url-validation.js"
import type { ParsedEvent } from "../types.js"
import type { SourceParser } from "./_lib/types.js"

type XmlObject = Record<string, unknown>

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
})

function localName(tagName: string): string {
  const lower = tagName.toLowerCase()
  return lower.includes(":") ? (lower.split(":").at(-1) ?? lower) : lower
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function textFromValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim()
    return text.length > 0 ? text : null
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textFromValue(item)
      if (text) {
        return text
      }
    }
    return null
  }

  if (value && typeof value === "object") {
    const objectValue = value as XmlObject
    return textFromValue(objectValue["#text"] ?? objectValue["$text"])
  }

  return null
}

function pickValue(node: XmlObject, keys: string[]): unknown {
  const normalized = keys.map((key) => key.toLowerCase())
  for (const key of normalized) {
    if (key in node) {
      return node[key]
    }

    for (const [entryKey, entryValue] of Object.entries(node)) {
      if (localName(entryKey) === localName(key)) {
        return entryValue
      }
    }
  }
  return null
}

function normalizeUrl(value: string | null | undefined, baseUrl: string): string | null {
  if (!value) {
    return null
  }
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return null
  }
}

function addValidatedImage(
  urls: Set<string>,
  value: string | null | undefined,
  baseUrl: string
): void {
  const resolved = normalizeUrl(value, baseUrl)
  if (!resolved) {
    return
  }
  if (validateExternalUrl(resolved).ok) {
    urls.add(resolved)
  }
}

function extractImages(item: XmlObject, baseUrl: string, descriptionHtml: string): string[] {
  const urls = new Set<string>()

  for (const [key, value] of Object.entries(item)) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith("media:") &&
      (localName(lower) === "content" || localName(lower) === "thumbnail")
    ) {
      for (const media of asArray(value)) {
        if (media && typeof media === "object") {
          addValidatedImage(urls, textFromValue((media as XmlObject).url), baseUrl)
        }
      }
      continue
    }

    if (localName(lower) === "enclosure") {
      for (const enclosure of asArray(value)) {
        if (!enclosure || typeof enclosure !== "object") {
          continue
        }
        const enclosureNode = enclosure as XmlObject
        const type = textFromValue(enclosureNode.type)?.toLowerCase() ?? ""
        if (type.startsWith("image/")) {
          addValidatedImage(urls, textFromValue(enclosureNode.url), baseUrl)
        }
      }
    }
  }

  for (const match of descriptionHtml.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    addValidatedImage(urls, match[1], baseUrl)
  }

  return [...urls].slice(0, 5)
}

function collectEntries(parsedXml: XmlObject): XmlObject[] {
  const entries: XmlObject[] = []

  const rssItems = (parsedXml.rss as XmlObject | undefined)?.channel as XmlObject | undefined
  entries.push(
    ...asArray(rssItems?.item).filter(
      (item): item is XmlObject => !!item && typeof item === "object"
    )
  )

  const atomFeed = parsedXml.feed as XmlObject | undefined
  entries.push(
    ...asArray(atomFeed?.entry).filter(
      (item): item is XmlObject => !!item && typeof item === "object"
    )
  )

  if (entries.length > 0) {
    return entries
  }

  function visit(node: unknown): void {
    if (!node || typeof node !== "object") {
      return
    }
    const objectNode = node as XmlObject
    for (const [key, value] of Object.entries(objectNode)) {
      const local = localName(key)
      if (local === "item" || local === "entry") {
        for (const candidate of asArray(value)) {
          if (candidate && typeof candidate === "object") {
            entries.push(candidate as XmlObject)
          }
        }
      }
      visit(value)
    }
  }

  visit(parsedXml)
  return entries
}

function extractSourceLink(item: XmlObject, sourceUrl: string): string | null {
  const linkValue = pickValue(item, ["link"])
  for (const link of asArray(linkValue)) {
    if (typeof link === "string") {
      return normalizeUrl(decodeHtml(link.trim()), sourceUrl)
    }

    if (link && typeof link === "object") {
      const node = link as XmlObject
      const href = textFromValue(node.href)
      if (href) {
        return normalizeUrl(decodeHtml(href), sourceUrl)
      }
      const text = textFromValue(node)
      if (text) {
        return normalizeUrl(decodeHtml(text), sourceUrl)
      }
    }
  }

  return sourceUrl
}

export function parseRssFeed(xml: string, sourceUrl: string): ParsedEvent[] {
  let parsed: XmlObject
  try {
    parsed = xmlParser.parse(xml) as XmlObject
  } catch {
    return []
  }

  const items = collectEntries(parsed)
  const results: ParsedEvent[] = []

  for (const item of items) {
    const title = stripHtml(textFromValue(pickValue(item, ["title"])) ?? "")
    if (!title) {
      continue
    }

    const rawDescription =
      textFromValue(pickValue(item, ["description", "summary", "content:encoded", "content"])) ?? ""
    const description = cleanDescription(rawDescription)

    const dateValue = textFromValue(pickValue(item, ["pubDate", "updated", "published", "dc:date"]))
    const startDatetime = parseIsoDate(dateValue)
    if (!startDatetime) {
      continue
    }

    const images = extractImages(item, sourceUrl, rawDescription)
    const priceInfo = extractPrice(rawDescription)

    results.push({
      title,
      description,
      startDatetime,
      endDatetime: null,
      venueName: null,
      address: null,
      sourceUrl: extractSourceLink(item, sourceUrl),
      imageUrl: images[0] ?? null,
      images,
      price: priceInfo.price,
      isFree: priceInfo.isFree,
    })
  }

  return results
}

export const rssParser: SourceParser<"rss"> = {
  type: "rss",
  async fetchArtifact(source, ctx) {
    const xml = await ctx.fetchText(source.url, {
      accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*",
    })
    return { url: source.url, contentType: "application/rss+xml", body: xml }
  },
  extractEvents(source, artifact) {
    return Promise.resolve(parseRssFeed(artifact.body, artifact.url || source.url))
  },
}
