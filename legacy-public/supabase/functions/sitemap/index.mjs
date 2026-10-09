import { createLegacyPublicHandler } from "../_shared/proxy.mjs"

Deno.serve(createLegacyPublicHandler("sitemap", { origin: Deno.env.get("PUBLIC_APP_URL") }))
