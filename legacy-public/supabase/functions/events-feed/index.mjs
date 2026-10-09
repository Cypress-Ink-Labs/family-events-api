import { createLegacyPublicHandler } from "../_shared/proxy.mjs"

Deno.serve(createLegacyPublicHandler("events-feed", { origin: Deno.env.get("PUBLIC_APP_URL") }))
