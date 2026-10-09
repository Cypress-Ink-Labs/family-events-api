import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { createLegacyPublicHandler } from "../supabase/functions/_shared/proxy.mjs"

const ID = "11111111-1111-4111-8111-111111111111"
const CACHE = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=600"
const request = (name, suffix = "", options) =>
  new Request(`https://old.supabase.co/functions/v1/${name}${suffix}`, options)

async function upstream(t, serve) {
  const server = createServer(serve)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

test("collection forwards permitted duplicate queries without caller credentials or origin headers", async (t) => {
  const origin = await upstream(t, (req, res) => {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  const handler = createLegacyPublicHandler("events-api", { origin })
  const response = await handler(
    request(
      "events-api",
      "?city_id=abc&tags=a&tags=b&cursor=YWJj%2B%3D&url=https%3A%2F%2Fevil.test&apikey=private",
      {
        headers: {
          Authorization: "Bearer private",
          Cookie: "session=private",
          Apikey: "private",
          Host: "evil.test",
          Forwarded: "host=evil.test",
          "X-Forwarded-Host": "evil.test",
          "X-Client-Info": "private",
          "If-None-Match": "private",
        },
      }
    )
  )
  const body = await response.json()
  assert.equal(body.url, "/api/events?city_id=abc&tags=a&tags=b&cursor=YWJj%2B%3D")
  for (const key of [
    "authorization",
    "cookie",
    "apikey",
    "forwarded",
    "x-forwarded-host",
    "x-client-info",
    "if-none-match",
  ]) {
    assert.equal(body.headers[key], undefined)
  }
  assert.equal(body.headers.host, new URL(origin).host)
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*")
})

for (const [name, suffix, destination] of [
  ["events-api", "/", "/api/events"],
  ["events-api", `/${ID}`, `/api/events/${ID}`],
  ["events-feed", "?format=IcS&city=abc", "/feeds/events?format=IcS&city=abc"],
  ["sitemap", "", "/sitemap.xml"],
  ["sitemap", "/sitemap.xml", "/sitemap.xml"],
  ["sitemap", "?type=robots", "/robots.txt?type=robots"],
  ["sitemap", "/robots.txt", "/robots.txt"],
  ["sitemap", "/sitemap.xml?type=robots", "/robots.txt?type=robots"],
]) {
  test(`${name}${suffix} reaches only its canonical public route`, async (t) => {
    const origin = await upstream(t, (req, res) => {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ path: req.url }))
    })
    let response = await createLegacyPublicHandler(name, { origin })(request(name, suffix))
    if (destination === "/sitemap.xml") {
      assert.equal(response.status, 307)
      assert.equal(response.headers.get("Location"), `${origin}${destination}`)
      response = await fetch(response.headers.get("Location"))
    }
    assert.deepEqual(await response.json(), { path: destination })
  })
}

for (const suffix of [
  "",
  "/",
  "/sitemap.xml",
  "/sitemap.xml/",
  "?type=xml&url=https://evil.test&apikey=private",
  "/sitemap%2Exml?type=sitemap&type=other",
]) {
  test(`sitemap XML ${suffix} redirects without fetching through the gateway`, async () => {
    const handler = createLegacyPublicHandler("sitemap", {
      origin: "https://family-events.org",
      fetchImpl: () => assert.fail("must not fetch XML"),
    })
    const response = await handler(
      request("sitemap", suffix, {
        headers: {
          Authorization: "Bearer private",
          Cookie: "session=private",
          Apikey: "private",
          Host: "evil.test",
          "X-Forwarded-Host": "evil.test",
        },
      })
    )
    assert.equal(response.status, 307)
    const target = new URL(response.headers.get("Location"))
    assert.equal(target.origin, "https://family-events.org")
    assert.equal(target.pathname, "/sitemap.xml")
    assert.deepEqual(
      [...target.searchParams],
      [...new URL(request("sitemap", suffix).url).searchParams].filter(([name]) => name === "type")
    )
    assert.equal(response.headers.get("Cache-Control"), "no-store")
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*")
    assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null)
    assert.equal(response.headers.get("Set-Cookie"), null)
    assert.equal(response.headers.get("Content-Type"), null)
    assert.equal(await response.text(), "")
    const preflight = await handler(request("sitemap", suffix, { method: "OPTIONS" }))
    assert.equal(preflight.status, 200)
    assert.equal(preflight.headers.get("Location"), null)
    assert.equal(await preflight.text(), "")
  })
}

test("gateway-stripped function path is supported", async (t) => {
  const origin = await upstream(t, (_req, res) => {
    res.setHeader("Content-Type", "application/json")
    res.end('{"data":[]}')
  })
  const response = await createLegacyPublicHandler("events-api", { origin })(
    new Request(`${origin}/events-api`)
  )
  assert.equal(await response.text(), '{"data":[]}')
})

for (const [name, suffix] of [
  ["events-api", "/cities"],
  ["events-api", `/${ID}/similar`],
  ["events-api", "/%2F%2Fevil.test"],
  ["events-api", "/%ZZ"],
  ["events-feed", "/other"],
  ["sitemap", "/admin"],
  ["sitemap", "/sitemap.xml/extra"],
  ["sitemap", "/%2Fsitemap.xml"],
  ["sitemap", "/%ZZ"],
  ["share-og", `/${ID}/extra`],
  ["share-og", "/%252Fadmin"],
]) {
  test(`rejects unsupported ${name} suffix ${suffix} without fetching`, async () => {
    const handler = createLegacyPublicHandler(name, {
      origin: "https://family-events.org",
      fetchImpl: () => assert.fail("must not fetch"),
    })
    const response = await handler(request(name, suffix))
    assert.equal(response.status, 404)
    assert.equal(response.headers.get("Cache-Control"), "no-store")
  })
}

for (const name of ["events-api", "events-feed", "share-og", "sitemap"]) {
  test(`${name} answers anonymous preflight and rejects writes locally`, async () => {
    const handler = createLegacyPublicHandler(name, {
      origin: "https://family-events.org",
      fetchImpl: () => assert.fail("must not fetch"),
    })
    const preflight = await handler(request(name, "", { method: "OPTIONS" }))
    assert.equal(preflight.status, 200)
    assert.equal(await preflight.text(), "")
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*")
    assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS")
    assert.equal(
      preflight.headers.get("Access-Control-Allow-Headers"),
      "Content-Type, Authorization, X-Client-Info, Apikey"
    )
    assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), null)
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const response = await handler(request(name, "", { method }))
      assert.equal(response.status, 405)
      assert.equal(response.headers.get("Allow"), "GET, OPTIONS")
    }
  })
}

for (const origin of [
  undefined,
  "",
  "bad",
  "http://family-events.org",
  "https://user:pass@family-events.org",
  "https://family-events.org/path",
  "https://family-events.org?target=x",
  "https://family-events.org#x",
]) {
  test(`missing or unsafe origin ${String(origin)} fails closed`, async () => {
    const handler = createLegacyPublicHandler("events-api", {
      origin,
      fetchImpl: () => assert.fail("must not fetch"),
    })
    const response = await handler(request("events-api"))
    assert.equal(response.status, 503)
    assert.equal(response.headers.get("Cache-Control"), "no-store")
    assert.deepEqual(await response.json(), { error: "service unavailable" })
  })
}

for (const suffix of [
  `/${ID}`,
  `?eventId=${ID}`,
  `?event_id=${ID}`,
  `/${ID}?eventId=&event_id=other`,
  "?eventId=bad&url=https://evil.test",
]) {
  test(`share preview redirects its accepted path/query ${suffix} to configured HTML alias`, async () => {
    const handler = createLegacyPublicHandler("share-og", {
      origin: "https://family-events.org",
      fetchImpl: () => assert.fail("must not fetch HTML"),
    })
    const response = await handler(
      request("share-og", suffix, {
        headers: { Host: "evil.test", "X-Forwarded-Host": "evil.test" },
      })
    )
    assert.equal(response.status, 307)
    const destination = new URL(response.headers.get("Location"))
    assert.equal(destination.origin, "https://family-events.org")
    assert.equal(
      destination.pathname,
      `/functions/v1/share-og${suffix.startsWith("/") ? `/${ID}` : ""}`
    )
    assert.equal(destination.searchParams.get("url"), null)
    assert.equal(response.headers.get("Cache-Control"), "no-store")
  })
}

for (const [name, suffix, type, body] of [
  [
    "events-api",
    "",
    "application/json; charset=utf-8",
    '{"data":[{"price_min":1.25}],"next_cursor":"abc="}',
  ],
  [
    "events-feed",
    "",
    "application/rss+xml; charset=utf-8",
    '<?xml version="1.0"?><rss>one &amp; two</rss>',
  ],
  [
    "events-feed",
    "?format=ics",
    "text/calendar; charset=utf-8",
    "BEGIN:VCALENDAR\r\nUID:one@family-events.org\r\nEND:VCALENDAR\r\n",
  ],
  ["sitemap", "", "application/xml; charset=utf-8", '<?xml version="1.0"?><urlset/>'],
  [
    "sitemap",
    "/robots.txt",
    "text/plain; charset=utf-8",
    "User-agent: *\nSitemap: https://family-events.org/sitemap.xml",
  ],
]) {
  test(`${name} ${name === "sitemap" && suffix === "" ? "redirect reaches canonical" : "preserves public"} bytes, MIME and cache without copying private response headers`, async (t) => {
    const origin = await upstream(t, (_req, res) => {
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": CACHE,
        "Set-Cookie": "private=x",
        "Content-Disposition": 'attachment; filename="family-events.ics"',
        ETag: '"public"',
        "X-Internal-Secret": "private",
        "Access-Control-Allow-Credentials": "true",
        "Content-Security-Policy": "private",
        Vary: "Cookie",
      })
      res.end(body)
    })
    const legacy = await createLegacyPublicHandler(name, { origin })(request(name, suffix))
    const xml = name === "sitemap" && suffix === ""
    let response = legacy
    if (xml) {
      assert.equal(legacy.status, 307)
      assert.equal(legacy.headers.get("Location"), `${origin}/sitemap.xml`)
      assert.equal(legacy.headers.get("Cache-Control"), "no-store")
      assert.equal(legacy.headers.get("ETag"), null)
      assert.equal(legacy.headers.get("Content-Disposition"), null)
      response = await fetch(legacy.headers.get("Location"))
    }
    assert.equal(response.status, 200)
    assert.equal(await response.text(), body)
    assert.equal(response.headers.get("Content-Type"), type)
    assert.equal(response.headers.get("Cache-Control"), CACHE)
    assert.equal(response.headers.get("ETag"), '"public"')
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="family-events.ics"'
    )
    for (const header of [
      "Set-Cookie",
      "X-Internal-Secret",
      "Access-Control-Allow-Credentials",
      "Vary",
      "Content-Security-Policy",
    ]) {
      assert.equal((xml ? legacy : response).headers.get(header), null)
    }
  })
}

for (const status of [400, 404]) {
  test(`preserves public ${status} error response without making it cacheable`, async (t) => {
    const origin = await upstream(t, (_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": CACHE })
      res.end('{"error":"invalid query or missing event"}')
    })
    const response = await createLegacyPublicHandler("events-api", { origin })(
      request("events-api")
    )
    assert.equal(response.status, status)
    assert.equal(response.headers.get("Cache-Control"), "no-store")
    assert.deepEqual(await response.json(), { error: "invalid query or missing event" })
  })
}

for (const status of [301, 302, 307, 308, 401, 403, 500, 503]) {
  test(`upstream ${status} cannot redirect the proxy or leak failure content`, async (t) => {
    const origin = await upstream(t, (_req, res) => {
      res.writeHead(status, {
        Location: "https://evil.test/private",
        "Content-Type": "application/json",
      })
      res.end('{"error":"private diagnostic"}')
    })
    const response = await createLegacyPublicHandler("events-api", { origin })(
      request("events-api")
    )
    assert.equal(response.status, 503)
    assert.equal(response.headers.get("Location"), null)
    assert.equal(response.headers.get("Cache-Control"), "no-store")
    assert.deepEqual(await response.json(), { error: "service unavailable" })
  })
}

test("network exception stays sanitized", async () => {
  const response = await createLegacyPublicHandler("events-api", {
    origin: "https://family-events.org",
    fetchImpl: () => {
      throw new Error("private connection")
    },
  })(request("events-api"))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "service unavailable" })
})

test("HTML upstream is rejected rather than published as a public API body", async (t) => {
  const origin = await upstream(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end("<html>private error</html>")
  })
  const response = await createLegacyPublicHandler("events-api", { origin })(request("events-api"))
  assert.equal(response.status, 503)
})

for (const sendHeaders of [false, true]) {
  test(`deadline covers stalled ${sendHeaders ? "response body" : "connection response"}`, async (t) => {
    const origin = await upstream(t, (_req, res) => {
      if (sendHeaders) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.write('{"data":')
      }
    })
    const response = await createLegacyPublicHandler("events-api", { origin, timeoutMs: 30 })(
      request("events-api")
    )
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: "service unavailable" })
  })
}

test("oversized response is discarded without returning a partial success", async (t) => {
  const origin = await upstream(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end("x".repeat(8 * 1024 * 1024 + 1))
  })
  const response = await createLegacyPublicHandler("events-api", { origin })(request("events-api"))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "service unavailable" })
})

test("encoded query targets remain data in a fixed-origin preview redirect", async () => {
  const response = await createLegacyPublicHandler("share-og", {
    origin: "https://family-events.org",
  })(request("share-og", `/${ID}?eventId=%2F%2Fevil.test%2F%3Fnext%3Dprivate&event_id=${ID}`))
  assert.equal(
    response.headers.get("Location"),
    `https://family-events.org/functions/v1/share-og/${ID}?eventId=%2F%2Fevil.test%2F%3Fnext%3Dprivate&event_id=${ID}`
  )
})

test("empty primary preview query retains precedence over the alternate query and path", async () => {
  const response = await createLegacyPublicHandler("share-og", {
    origin: "https://family-events.org",
  })(request("share-og", `/${ID}?eventId=&event_id=${ID}`))
  assert.equal(
    response.headers.get("Location"),
    `https://family-events.org/functions/v1/share-og/${ID}?eventId=&event_id=${ID}`
  )
})

test("plain-text public feed validation error retains status and body", async (t) => {
  const origin = await upstream(t, (_req, res) => {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Invalid format. Use ?format=ics or ?format=rss")
  })
  const response = await createLegacyPublicHandler("events-feed", { origin })(
    request("events-feed", "?format=invalid")
  )
  assert.equal(response.status, 400)
  assert.equal(await response.text(), "Invalid format. Use ?format=ics or ?format=rss")
  assert.equal(response.headers.get("Cache-Control"), "no-store")
})

test("each deployed entrypoint reads required public origin and registers the correct handler", async (t) => {
  const previous = globalThis.Deno
  let registered
  let configured
  globalThis.Deno = {
    env: {
      get: (name) => {
        assert.equal(name, "PUBLIC_APP_URL")
        return configured
      },
    },
    serve: (handler) => {
      registered = handler
    },
  }
  t.after(() => {
    if (previous === undefined) delete globalThis.Deno
    else globalThis.Deno = previous
  })
  for (const name of ["events-api", "events-feed", "share-og", "sitemap"]) {
    configured = undefined
    await import(`../supabase/functions/${name}/index.mjs?missing`)
    const missing = await registered(request(name))
    assert.equal(missing.status, 503)
    configured = "https://family-events.org"
    await import(`../supabase/functions/${name}/index.mjs?configured`)
    const valid = await registered(request(name, "", { method: "OPTIONS" }))
    assert.equal(valid.status, 200)
    const wrong = await registered(request(name === "events-api" ? "sitemap" : "events-api"))
    assert.equal(wrong.status, 404)
  }
})
