// Pure classification helpers for tag-event: keyword-based tag rules, age
// range / price / venue extraction from free text.
// Ported from family-events-backend supabase/functions/_shared/classification.ts (U29).
// Deviations: none beyond the env seam (this module has no env reads at all).

export interface TagRule {
  slug: string
  keywords: string[]
}

export interface ComputedTag {
  slug: string
  confidence: number
  reason: string | null
  matchedKeywords: string[]
}

export const TAG_RULES: TagRule[] = [
  {
    slug: "music",
    keywords: [
      "music",
      "sing",
      "song",
      "instrument",
      "drum",
      "guitar",
      "violin",
      "band",
      "musical",
      "karaoke",
      "choir",
      "concert",
    ],
  },
  {
    slug: "outdoor",
    keywords: [
      "outdoor",
      "park",
      "garden",
      "hike",
      "nature",
      "trail",
      "playground",
      "outside",
      "picnic",
      "beach",
      "forest",
      "camp",
    ],
  },
  {
    slug: "storytime",
    keywords: [
      "storytime",
      "story time",
      "book",
      "reading",
      "read aloud",
      "library",
      "tales",
      "narrative",
      "bedtime",
    ],
  },
  {
    slug: "art",
    keywords: [
      "art",
      "craft",
      "paint",
      "draw",
      "sculpture",
      "pottery",
      "clay",
      "creative",
      "collage",
      "watercolor",
      "sketch",
    ],
  },
  {
    slug: "science",
    keywords: [
      "science",
      "stem",
      "experiment",
      "lab",
      "chemistry",
      "biology",
      "physics",
      "robot",
      "coding",
      "tech",
      "engineering",
    ],
  },
  {
    slug: "sports",
    keywords: [
      "sport",
      "soccer",
      "basketball",
      "swim",
      "gymnastics",
      "yoga",
      "dance",
      "fitness",
      "run",
      "martial arts",
      "tennis",
    ],
  },
  {
    slug: "theater",
    keywords: [
      "theater",
      "theatre",
      "drama",
      "puppet",
      "performance",
      "show",
      "stage",
      "act",
      "improv",
      "comedy",
    ],
  },
  {
    slug: "cooking",
    keywords: ["cook", "bake", "food", "kitchen", "recipe", "chef", "culinary", "meal", "snack"],
  },
  {
    slug: "sensory",
    keywords: [
      "sensory",
      "tactile",
      "texture",
      "exploration",
      "touch",
      "feel",
      "messy",
      "kinetic",
      "sand",
      "water play",
    ],
  },
  {
    slug: "playgroup",
    keywords: [
      "playgroup",
      "play group",
      "toddler",
      "baby",
      "infant",
      "mommy and me",
      "parent and me",
      "social",
    ],
  },
  { slug: "free", keywords: ["free", "no cost", "no charge", "complimentary", "at no cost"] },
  {
    slug: "drop-in",
    keywords: ["drop-in", "drop in", "walk-in", "no registration", "no booking required"],
  },
]

export function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

export function computeTags(title: string, description: string): ComputedTag[] {
  const text = `${title} ${description}`.toLowerCase()
  const results: ComputedTag[] = []

  for (const rule of TAG_RULES) {
    const matchedKeywords = rule.keywords.filter((kw) => text.includes(kw))
    if (matchedKeywords.length > 0) {
      const confidence = Math.min(0.5 + (matchedKeywords.length / rule.keywords.length) * 0.5, 0.98)
      results.push({
        slug: rule.slug,
        confidence: Math.round(confidence * 100) / 100,
        reason: `Matched keyword rule hits: ${matchedKeywords.join(", ")}.`,
        matchedKeywords,
      })
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence)
}

export function extractAgeRangeFromText(
  title: string,
  description: string
): { ageMin: number | null; ageMax: number | null } {
  const text = `${title} ${description}`.toLowerCase()

  const rangeMatch = text.match(/(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*(?:years?|yrs?|yo|y\/o)/)
  if (rangeMatch) {
    return {
      ageMin: Number(rangeMatch[1]),
      ageMax: Number(rangeMatch[2]),
    }
  }

  const plusMatch = text.match(/(?:ages?\s*)?(\d{1,2})\s*\+/)
  if (plusMatch) {
    return {
      ageMin: Number(plusMatch[1]),
      ageMax: null,
    }
  }

  const underMatch = text.match(/under\s*(\d{1,2})/)
  if (underMatch) {
    return {
      ageMin: null,
      ageMax: Number(underMatch[1]),
    }
  }

  if (text.includes("toddler")) {
    return { ageMin: 1, ageMax: 4 }
  }
  if (text.includes("baby") || text.includes("infant")) {
    return { ageMin: 0, ageMax: 2 }
  }

  return { ageMin: null, ageMax: null }
}

export function extractPriceFromText(
  title: string,
  description: string
): { price: number | null; isFree: boolean } {
  const text = `${title} ${description}`.toLowerCase()

  const freePatterns = [/\bfree\b/, /\bno cost\b/, /\bno charge\b/, /\bcomplimentary\b/]
  for (const pattern of freePatterns) {
    if (pattern.test(text)) {
      return { price: null, isFree: true }
    }
  }

  const priceMatch = `${title} ${description}`.match(/\$\s*(\d+(?:\.\d{1,2})?)/)
  if (priceMatch) {
    return { price: Number(priceMatch[1]), isFree: false }
  }

  return { price: null, isFree: false }
}

export function extractVenueFromText(
  title: string,
  description: string
): { venueName: string | null } {
  const text = `${title} ${description}`

  // Match title-cased words only (each word starts uppercase) to avoid capturing
  // trailing lowercase words like "for storytime" or "tomorrow".
  const atMatch = text.match(
    /\bat\s+(?:the\s+)?([A-Z][A-Za-z0-9'&-]+(?:\s+[A-Z][A-Za-z0-9'&-]+)*)(?:[,.\s]|$)/
  )
  if (atMatch) {
    return { venueName: atMatch[1]!.trim() }
  }

  const locationMatch = text.match(/(?:Location|Venue|Where):\s*([^\n,]{3,60})/i)
  if (locationMatch) {
    return { venueName: locationMatch[1]!.trim() }
  }

  return { venueName: null }
}
