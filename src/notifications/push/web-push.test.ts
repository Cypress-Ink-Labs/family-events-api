import { describe, expect, it } from "vitest"

import {
  base64urlDecode,
  buildVapidAuth,
  encryptPayload,
  isTrustedWebPushEndpoint,
} from "./web-push.js"

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function base64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url")
}

describe("isTrustedWebPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/send/1",
    "https://updates.push.services.mozilla.com/wpush/v2/1",
    "https://web.push.apple.com/Q123",
    "https://db5.notify.windows.com/w/?token=1",
  ])("accepts trusted HTTPS push provider endpoint %s", (endpoint) => {
    expect(isTrustedWebPushEndpoint(endpoint)).toBe(true)
  })

  it.each([
    "http://fcm.googleapis.com/send/1",
    "https://evil-fcm.googleapis.com/send/1",
    "https://notify.windows.com/w/1",
    "https://db5.notify.windows.com.evil.example/w/1",
    "https://127.0.0.1/private",
    "not-a-url",
  ])("rejects untrusted web push endpoint %s", (endpoint) => {
    expect(isTrustedWebPushEndpoint(endpoint)).toBe(false)
  })
})

describe("Web Push cryptography", () => {
  it("rejects payloads whose ciphertext would exceed the 4096-byte record size", async () => {
    await expect(encryptPayload("x".repeat(4_080), "unused", "unused")).rejects.toThrow(
      /4096-byte record size/
    )
  })

  it("creates a verifiable VAPID JWT with the expected audience and lifetime", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])
    const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey)
    const publicRaw = await crypto.subtle.exportKey("raw", keys.publicKey)
    const publicKey = base64url(publicRaw)
    const now = Date.parse("2026-09-04T12:00:00.000Z")

    const authorization = await buildVapidAuth(
      "https://fcm.googleapis.com/fcm/send/subscription",
      {
        privateKey: privateJwk.d!,
        publicKey,
        subject: "mailto:push@example.com",
      },
      () => now
    )

    const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)
    expect(match).not.toBeNull()
    const [header, payload, signature] = match![1]!.split(".")
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as {
      aud: string
      exp: number
      sub: string
    }
    expect(claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Math.floor(now / 1_000) + 12 * 60 * 60,
      sub: "mailto:push@example.com",
    })
    expect(match![2]).toBe(publicKey)
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        keys.publicKey,
        toArrayBuffer(base64urlDecode(signature!)),
        new TextEncoder().encode(`${header}.${payload}`)
      )
    ).resolves.toBe(true)
  })

  it("produces an independently decryptable aes128gcm record", async () => {
    const subscriber = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    )
    const subscriberPublic = await crypto.subtle.exportKey("raw", subscriber.publicKey)
    const authSecret = crypto.getRandomValues(new Uint8Array(16))
    const payload = JSON.stringify({ title: "Changed", body: "New time" })

    const record = await encryptPayload(
      payload,
      base64url(subscriberPublic),
      Buffer.from(authSecret).toString("base64url")
    )

    const salt = record.slice(0, 16)
    expect(new DataView(record.buffer, record.byteOffset + 16, 4).getUint32(0)).toBe(4096)
    const keyLength = record[20]!
    const serverPublic = record.slice(21, 21 + keyLength)
    const ciphertext = record.slice(21 + keyLength)
    const serverKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(serverPublic),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    )
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverKey },
      subscriber.privateKey,
      256
    )
    const info = new Uint8Array([
      ...new TextEncoder().encode("WebPush: info\0"),
      ...new Uint8Array(subscriberPublic),
      ...serverPublic,
    ])
    const ikm = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"])
    const combined = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: authSecret, info },
      ikm,
      256
    )
    const prk = await crypto.subtle.importKey("raw", combined, "HKDF", false, ["deriveBits"])
    const encoder = new TextEncoder()
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
    const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"])
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ciphertext)
    )
    expect(plaintext.at(-1)).toBe(2)
    expect(new TextDecoder().decode(plaintext.slice(0, -1))).toBe(payload)
  })
})
