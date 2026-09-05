export interface VapidCredentials {
  privateKey: string
  publicKey: string
  subject: string
}

const TRUSTED_WEB_PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
])

export function isTrustedWebPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    const hostname = url.hostname.toLowerCase()
    return (
      url.protocol === "https:" &&
      (TRUSTED_WEB_PUSH_HOSTS.has(hostname) || hostname.endsWith(".notify.windows.com"))
    )
  } catch {
    return false
  }
}

export function base64urlEncode(data: Uint8Array): string {
  let binary = ""
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64urlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function derToRawSignature(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) return signature

  const raw = new Uint8Array(64)
  let offset = 3
  const rLength = signature[offset++]!
  const rStart = rLength > 32 ? offset + rLength - 32 : offset
  const rDestination = rLength < 32 ? 32 - rLength : 0
  raw.set(signature.slice(rStart, offset + rLength), rDestination)
  offset += rLength + 1
  const sLength = signature[offset++]!
  const sStart = sLength > 32 ? offset + sLength - 32 : offset
  const sDestination = sLength < 32 ? 64 - sLength : 32
  raw.set(signature.slice(sStart, offset + sLength), sDestination)
  return raw
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export async function buildVapidAuth(
  endpoint: string,
  credentials: VapidCredentials,
  now: () => number = Date.now
): Promise<string> {
  const header = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))
  )
  const payload = base64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now() / 1_000) + 12 * 60 * 60,
        sub: credentials.subject,
      })
    )
  )
  const publicKey = base64urlDecode(credentials.publicKey)
  const signingInput = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: credentials.privateKey,
      x: base64urlEncode(publicKey.slice(1, 33)),
      y: base64urlEncode(publicKey.slice(33, 65)),
    },
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
  const token = `${signingInput}.${base64urlEncode(derToRawSignature(signature))}`
  return `vapid t=${token}, k=${credentials.publicKey}`
}

export async function encryptPayload(
  payload: string,
  p256dhKey: string,
  authSecret: string
): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const payloadBytes = encoder.encode(payload)
  // RFC 8188 record size counts ciphertext, including the one-byte final
  // delimiter and the 16-byte AES-GCM authentication tag.
  if (payloadBytes.byteLength + 1 + 16 > 4_096) {
    throw new RangeError("Web Push payload exceeds the 4096-byte record size")
  }
  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  )
  const subscriberPublicKey = base64urlDecode(p256dhKey)
  const subscriberKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(subscriberPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  )
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: subscriberKey },
    localKeyPair.privateKey,
    256
  )
  const localPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey)
  )
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const authSecretBytes = base64urlDecode(authSecret)
  const info = new Uint8Array([
    ...encoder.encode("WebPush: info\0"),
    ...subscriberPublicKey,
    ...localPublicKey,
  ])
  const ikm = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"])
  const combined = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: toArrayBuffer(authSecretBytes),
        info,
      },
      ikm,
      256
    )
  )
  const prk = await crypto.subtle.importKey("raw", combined, "HKDF", false, ["deriveBits"])
  const contentKey = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode("Content-Encoding: aes128gcm\0"),
    },
    prk,
    128
  )
  const nonce = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode("Content-Encoding: nonce\0"),
    },
    prk,
    96
  )
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"])
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      new Uint8Array([...payloadBytes, 2])
    )
  )
  const recordSize = new Uint8Array(4)
  new DataView(recordSize.buffer).setUint32(0, 4_096)
  return new Uint8Array([
    ...salt,
    ...recordSize,
    localPublicKey.length,
    ...localPublicKey,
    ...encrypted,
  ])
}

export function webPushBody(bytes: Uint8Array): ArrayBuffer {
  return toArrayBuffer(bytes)
}
