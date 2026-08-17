// Parser registry, ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/index.ts (U28).

import type { SourceParser } from "./_lib/types.js"
import type { SourceType } from "../types.js"
import { websiteParser } from "./website.js"
import { rssParser } from "./rss.js"
import { icalParser } from "./ical.js"
import { manualParser } from "./manual.js"
import { macaroniKidParser } from "./macaroni-kid.js"
import { brecParser } from "./brec.js"
import { downtownLafayetteParser } from "./downtownlafayette.js"
import { lcgLafayetteParser } from "./lcg-lafayette.js"
import { localHopParser } from "./localhop.js"

export const parsers = {
  [websiteParser.type]: websiteParser,
  [rssParser.type]: rssParser,
  [icalParser.type]: icalParser,
  [manualParser.type]: manualParser,
  [macaroniKidParser.type]: macaroniKidParser,
  [brecParser.type]: brecParser,
  [downtownLafayetteParser.type]: downtownLafayetteParser,
  [lcgLafayetteParser.type]: lcgLafayetteParser,
  [localHopParser.type]: localHopParser,
} as const satisfies Record<SourceType, SourceParser>

export type { SourceParser } from "./_lib/types.js"
export type { ParserContext } from "../parser-context.js"
