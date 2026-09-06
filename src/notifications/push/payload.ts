// Leaves room for Web Push encryption framing and provider-specific envelopes.
export const MAX_PUSH_PAYLOAD_BYTES = 3_000

export function boundedPushPayload<T>(
  title: string,
  body: string,
  build: (title: string, body: string) => T
): T {
  const fits = (value: T) =>
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PUSH_PAYLOAD_BYTES
  const empty = build("", "")
  if (!fits(empty)) throw new RangeError("push payload fixed fields exceed byte limit")
  const full = build(title, body)
  if (fits(full)) return full
  // Iterate code points so truncation cannot leave half a surrogate pair.
  const titlePoints = Array.from(title)
  const bodyPoints = Array.from(body)
  let low = 0
  let high = Math.max(titlePoints.length, bodyPoints.length)
  let result = empty
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const candidate = build(
      titlePoints.slice(0, length).join(""),
      bodyPoints.slice(0, length).join("")
    )
    if (fits(candidate)) {
      result = candidate
      low = length + 1
    } else high = length - 1
  }
  return result
}
