import { createLegacyPublicHandler } from "../_shared/proxy.mjs"

Deno.serve(createLegacyPublicHandler("share-og", { origin: Deno.env.get("PUBLIC_APP_URL") }))
