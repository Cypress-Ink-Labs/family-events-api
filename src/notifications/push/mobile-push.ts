import { base64urlEncode, derToRawSignature } from "./web-push.js"

export interface MobilePushPayload {
  title: string
  body: string
  url?: string
}

export interface ApnsCredentials {
  teamId: string
  keyId: string
  privateKey: string
  bundleId: string
  environment: "sandbox" | "production"
}

export interface FcmCredentials {
  projectId: string
  clientEmail: string
  privateKey: string
}

export function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

export function buildApnsRequest(input: {
  token: string
  jwt: string
  bundleId: string
  environment: "sandbox" | "production"
  payload: MobilePushPayload
}): { url: string; headers: Record<string, string>; body: string } {
  const origin =
    input.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com"
  return {
    url: `${origin}/3/device/${encodeURIComponent(input.token)}`,
    headers: {
      authorization: `bearer ${input.jwt}`,
      "apns-topic": input.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        alert: { title: input.payload.title, body: input.payload.body },
        sound: "default",
      },
      ...(input.payload.url ? { url: input.payload.url } : {}),
    }),
  }
}

export function buildFcmMessage(input: {
  token: string
  title: string
  body: string
  url?: string
}): {
  message: {
    token: string
    notification: { title: string; body: string }
    data: Record<string, string>
    android: { priority: "HIGH"; notification: { channel_id: string } }
  }
} {
  return {
    message: {
      token: input.token,
      notification: { title: input.title, body: input.body },
      data: input.url ? { url: input.url } : {},
      android: {
        priority: "HIGH",
        notification: { channel_id: "family_events" },
      },
    },
  }
}

export function buildFcmEndpoint(projectId: string): string {
  return `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`
}

export async function signApnsJwt(
  credentials: ApnsCredentials,
  now: () => number = Date.now
): Promise<string> {
  const header = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: credentials.keyId }))
  )
  const payload = base64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({ iss: credentials.teamId, iat: Math.floor(now() / 1_000) })
    )
  )
  const signingInput = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(credentials.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput)
    )
  )
  return `${signingInput}.${base64urlEncode(derToRawSignature(signature))}`
}

export function parseFcmServiceAccount(raw: string): FcmCredentials | undefined {
  if (!raw.trim()) return undefined
  const parsed = JSON.parse(raw) as {
    project_id?: unknown
    client_email?: unknown
    private_key?: unknown
  }
  if (
    typeof parsed.project_id !== "string" ||
    typeof parsed.client_email !== "string" ||
    typeof parsed.private_key !== "string"
  ) {
    return undefined
  }
  return {
    projectId: parsed.project_id,
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
  }
}

export async function getFcmAccessToken(
  credentials: FcmCredentials,
  options: { fetch?: typeof fetch; now?: () => number } = {}
): Promise<string> {
  const now = Math.floor((options.now ?? Date.now)() / 1_000)
  const header = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  )
  const payload = base64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: credentials.clientEmail,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3_600,
      })
    )
  )
  const signingInput = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(credentials.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput))
  )
  const assertion = `${signingInput}.${base64urlEncode(signature)}`
  const response = await (options.fetch ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`FCM OAuth token request failed: ${response.status}`)
  const body = (await response.json()) as { access_token?: unknown }
  if (typeof body.access_token !== "string") {
    throw new Error("FCM OAuth token response missing access_token")
  }
  return body.access_token
}
