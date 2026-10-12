type Image = string | Blob | undefined

/** Bounds both resolved image bytes and in-flight entries; failed loads are retryable. */
export class ToolImageCache {
  private readonly entries = new Map<string, { promise: Promise<Image>; bytes: number }>()
  private bytes = 0

  constructor(
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly maxEntries = 32,
  ) {}

  get byteSize() {
    return this.bytes
  }
  get size() {
    return this.entries.size
  }

  resolve(key: string, load: () => Promise<Image>) {
    const pending = this.entries.get(key)
    if (pending) return pending.promise
    const entry = {
      bytes: 0,
      promise: Promise.resolve()
        .then(load)
        .then(
          (value) => {
            if (this.entries.get(key) !== entry) return value
            entry.bytes = value instanceof Blob ? value.size : typeof value === "string" ? value.length * 2 : 0
            this.bytes += entry.bytes
            if (value === undefined || entry.bytes > this.maxBytes) this.remove(key)
            this.trim()
            return value
          },
          () => {
            if (this.entries.get(key) === entry) this.remove(key)
            return undefined
          },
        ),
    }
    this.entries.set(key, entry)
    this.trim()
    return entry.promise
  }

  private remove(key: string) {
    this.bytes -= this.entries.get(key)?.bytes ?? 0
    this.entries.delete(key)
  }

  private trim() {
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) return
      this.remove(oldest.value)
    }
  }
}
