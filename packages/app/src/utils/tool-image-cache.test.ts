import { expect, test } from "bun:test"
import { ToolImageCache } from "./tool-image-cache"

test("evicts by resolved byte size and does not retain oversized images", async () => {
  const cache = new ToolImageCache(10)
  await cache.resolve("first", async () => new Blob(["123456"]))
  await cache.resolve("second", async () => new Blob(["123456"]))
  expect(cache.byteSize).toBe(6)
  expect(cache.size).toBe(1)
  const oversized = await cache.resolve("oversized", async () => new Blob(["12345678901234567890"]))
  expect(oversized).toBeInstanceOf(Blob)
  expect(cache.byteSize).toBe(6)
  expect(cache.size).toBe(1)
})

test("accounts for data URL strings and retries unavailable images", async () => {
  const cache = new ToolImageCache(10)
  await cache.resolve("url", async () => "1234")
  expect(cache.byteSize).toBe(8)
  await cache.resolve("missing", async () => undefined)
  expect(await cache.resolve("missing", async () => "ready")).toBe("ready")
  expect(cache.byteSize).toBe(10)
  expect(cache.size).toBe(1)
})

test("deduplicates in-flight loads and bounds pending entries", async () => {
  const cache = new ToolImageCache(10, 2)
  const pending = Promise.withResolvers<Blob>()
  const first = cache.resolve("first", () => pending.promise)
  expect(cache.resolve("first", () => pending.promise)).toBe(first)
  const second = cache.resolve("second", () => pending.promise)
  const third = cache.resolve("third", () => pending.promise)
  expect(cache.size).toBe(2)
  pending.resolve(new Blob(["123456"]))
  await Promise.all([first, second, third])
  expect(cache.byteSize).toBe(6)
  expect(cache.size).toBe(1)
})

test("failed requests do not poison later requests", async () => {
  const cache = new ToolImageCache()
  expect(
    await cache.resolve("image", async () => {
      throw new Error("Unavailable")
    }),
  ).toBeUndefined()
  expect(await cache.resolve("image", async () => "recovered")).toBe("recovered")
})
