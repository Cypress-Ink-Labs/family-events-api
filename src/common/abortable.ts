// Stop waiting even when the underlying operation cannot cancel. Promise.race
// also observes late rejections after cancellation, and every exit removes the listener.
export async function abortable<T>(
  work: () => Promise<T>,
  signal?: AbortSignal | null
): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return work()

  let onAbort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted()
        return work()
      }),
      cancelled,
    ])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
