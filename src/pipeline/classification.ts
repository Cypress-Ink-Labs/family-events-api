// Pure classification helpers for tag-event: keyword-based tag rules, age
// range / price / venue extraction from free text.
// Ported from family-events-backend supabase/functions/_shared/classification.ts (U29).
// Deviations (CodeRabbit U29 review; no legacy test asserts the old behavior):
// - Tag keywords match whole tokens instead of raw substrings, so embedded words
//   like "party"/"parking" no longer trigger "art"/"park"; plural/-ing keyword
//   variants were added so real stem matches still fire.
// - Free-price detection ignores hyphenated "-free" compounds (e.g.
//   "gluten-free") via negative lookbehind; standalone "free" still matches.
// - Venue "at X" extraction skips recognized time/date words ("Doors open at
//   Noon.") and tries later "at" clauses before the Location/Venue/Where fallback.

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
      // Token matching needs explicit variants for common inflections.
      "singing",
      "songs",
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
      "parks",
      "hiking",
      "trails",
      "camping",
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
      "books",
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
      "arts",
      "crafts",
      "painting",
      "drawing",
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
      "experiments",
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
      "sports",
      "swimming",
      "dancing",
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
      "acting",
      "shows",
    ],
  },
  {
    slug: "cooking",
    keywords: [
      "cook",
      "bake",
      "food",
      "kitchen",
      "recipe",
      "chef",
      "culinary",
      "meal",
      "snack",
      "cooking",
      "baking",
    ],
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
      "toddlers",
      "babies",
    ],
  },
  { slug: "free", keywords: ["free", "no cost", "no charge", "complimentary", "at no cost"] },
  {
    slug: "drop-in",
    keywords: ["drop-in", "drop in", "walk-in", "no registration", "no booking required"],
  },
]

// Keyword matching is token-aware: a keyword only fires when it appears as
// whole token(s), so embedded substrings ("art" in "party", "park" in
// "parking") do not match. Keywords may span multiple tokens ("story time"),
// and hyphenated forms tokenize consistently on both sides ("drop-in" ~
// ["drop", "in"]).
const TOKEN_SPLIT = /[^a-z0-9]+/

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((token) => token.length > 0)

const includesTokenPhrase = (haystack: string[], needle: string[]): boolean => {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((token, j) => haystack[i + j] === token)) return true
  }
  return false
}

// Title-cased time/date words that follow "at" but are not venues
// ("Doors open at Noon.").
const TEMPORAL_WORDS: ReadonlySet<string> = new Set([
  "noon",
  "midnight",
  "dawn",
  "dusk",
  "today",
  "tonight",
  "tomorrow",
  "yesterday",
  "morning",
  "afternoon",
  "evening",
])

export function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

export function computeTags(title: string, description: string): ComputedTag[] {
  const tokens = tokenize(`${title} ${description}`)
  const results: ComputedTag[] = []

  for (const rule of TAG_RULES) {
    const matchedKeywords = rule.keywords.filter((kw) => includesTokenPhrase(tokens, tokenize(kw)))
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

  // Negative lookbehind rejects hyphenated compounds ("gluten-free") — \b alone
  // matches after "-", which wrongly reported paid events as free.
  const freePatterns = [/(?<![\w-])free\b/, /\bno cost\b/, /\bno charge\b/, /\bcomplimentary\b/]
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
  // trailing lowercase words like "for storytime" or "tomorrow". Recognized
  // time/date expressions ("Doors open at Noon.") are skipped; a later "at"
  // clause can still supply the venue before the Location/Venue/Where fallback.
  const atPattern =
    /\bat\s+(?:the\s+)?([A-Z][A-Za-z0-9'&-]+(?:\s+[A-Z][A-Za-z0-9'&-]+)*)(?:[,.\s]|$)/g
  for (const match of text.matchAll(atPattern)) {
    const candidate = match[1]!.trim()
    if (!TEMPORAL_WORDS.has(candidate.toLowerCase())) {
      return { venueName: candidate }
    }
  }

  const locationMatch = text.match(/(?:Location|Venue|Where):\s*([^\n,]{3,60})/i)
  if (locationMatch) {
    return { venueName: locationMatch[1]!.trim() }
  }

  return { venueName: null }
}
