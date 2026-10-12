export * as AttachmentStore from "./attachment-store"

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Attachment } from "@opencode-ai/schema/attachment"
import { Context, DateTime, Duration, Effect, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import { imageReferences } from "./util/tool-images"
import { Config } from "./config"
import { Database } from "./database/database"
import { SessionTable } from "./session/sql"
import { EventSequenceTable } from "./event/sql"
import { makeGlobalNode } from "./effect/app-node"
import { LayerNode } from "./effect/layer-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Flock } from "./util/flock"

const formats = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
}
const session = /^[a-zA-Z0-9_-]+$/
const dataImage = /^data:(image\/(?:png|jpeg|jpg|webp|gif|avif|bmp));base64,([a-zA-Z0-9+/]*={0,2})$/
export const UNAVAILABLE = "[Image unavailable]"
const memoryRoots = new WeakMap<Database.Interface, string>()
const cleanupOwners = new Set<string>()

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("AttachmentStore.StorageError", {
  cause: Schema.Defect(),
}) {}

export interface ModelLimits {
  readonly autoResize: boolean
  readonly maxWidth: number
  readonly maxHeight: number
  readonly maxBase64Bytes: number
}

export interface Interface {
  readonly directory: string
  readonly capture: (
    sessionID: string,
    directory: string,
    value: unknown,
  ) => Effect.Effect<{ uri: string; mime: string; name: string }[], StorageError>
  readonly externalize: (
    sessionID: string,
    value: unknown,
    sourceSessionID?: string,
  ) => Effect.Effect<unknown, StorageError>
  readonly externalizeRecovering: (
    sessionID: string,
    value: unknown,
    sourceSessionID?: string,
  ) => Effect.Effect<unknown>
  readonly materialize: (sessionID: string, value: unknown, model?: boolean | ModelLimits) => Effect.Effect<unknown>
  readonly read: (
    sessionID: string,
    id: string,
    variant?: typeof Attachment.Variant.Type,
  ) => Effect.Effect<{ content: Uint8Array; mime: string }, StorageError>
  readonly remove: (sessionID: string) => Effect.Effect<void, StorageError>
  readonly cleanup: (liveSessions?: ReadonlySet<string>) => Effect.Effect<void, StorageError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AttachmentStore") {}

const transform = <E>(
  value: unknown,
  replace: (value: string) => Effect.Effect<string, E>,
): Effect.Effect<unknown, E> => walk(value, replace).pipe(Effect.map((result) => result.value))

const walk = <E>(
  value: unknown,
  replace: (value: string) => Effect.Effect<string, E>,
  media = false,
): Effect.Effect<{ value: unknown; missing: boolean }, E> =>
  Effect.suspend<{ value: unknown; missing: boolean }, E, never>(() => {
    if (typeof value === "string")
      return replace(value).pipe(
        Effect.map((result) => ({ value: result, missing: result === UNAVAILABLE && result !== value })),
      )
    if (Array.isArray(value))
      return Effect.forEach(value, (item) => walk(item, replace, true)).pipe(
        Effect.map((items) => ({
          value: items.map((item) => item.value).filter((item) => item !== undefined),
          missing: items.some((item) => item.missing),
        })),
      )
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
      return Effect.succeed({ value, missing: false })
    return Effect.forEach(Object.entries(value), ([key, item]) =>
      walk(item, replace).pipe(Effect.map((result) => ({ key, ...result }))),
    ).pipe(
      Effect.map((entries) => {
        const result = Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))
        const missing = entries.some((entry) => entry.missing)
        if (
          (result.uri === UNAVAILABLE || result.url === UNAVAILABLE) &&
          (result.type === "file" || (media && typeof result.mime === "string" && result.mime.startsWith("image/")))
        )
          return { value: undefined, missing: true }
        if (result.type === "media" && result.data === UNAVAILABLE) return { value: undefined, missing: true }
        if (missing && typeof result.output === "string" && !result.output.includes(UNAVAILABLE))
          result.output += `\n${UNAVAILABLE}`
        if (missing && typeof result.text === "string" && !result.text.includes(UNAVAILABLE))
          result.text += `\n${UNAVAILABLE}`
        if (missing && Array.isArray(result.content) && !hasUnavailableText(result.content))
          result.content.push({ type: "text", text: UNAVAILABLE })
        if (missing && result.type === "content" && Array.isArray(result.value) && !hasUnavailableText(result.value))
          result.value.push({ type: "text", text: UNAVAILABLE })
        return { value: withImageMime(result), missing }
      }),
    )
  })

function hasUnavailableText(parts: unknown[]) {
  return parts.some(
    (part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string" &&
      part.text.includes(UNAVAILABLE),
  )
}

// A resized PNG may become JPEG; only media records, not arbitrary URI-bearing metadata, change MIME.
function withImageMime(value: Record<string, unknown>) {
  if (typeof value.mime !== "string" || !value.mime.startsWith("image/")) return value
  const uri = typeof value.uri === "string" ? value.uri : value.url
  const mime = typeof uri === "string" ? /^data:(image\/[^;,]+)/.exec(uri)?.[1] : undefined
  return mime ? { ...value, mime } : value
}

const storageError = (cause: unknown) => (cause instanceof StorageError ? cause : new StorageError({ cause }))

export const layerWith = (directory?: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const database = yield* Effect.serviceOption(Database.Service)
      const filename = Option.isSome(database) ? (database.value.filename ?? Database.path()) : Database.path()
      const memory = Option.isSome(database) ? (memoryRoots.get(database.value) ?? randomUUID()) : randomUUID()
      if (filename === ":memory:" && Option.isSome(database)) memoryRoots.set(database.value, memory)
      const root =
        directory ??
        path.join(
          global.data,
          "attachments",
          filename === ":memory:"
            ? memory
            : createHash("sha256").update(path.resolve(filename)).digest("hex").slice(0, 16),
        )
      const originals = path.join(root, "originals")
      const variants = path.join(root, "thumbnails")
      const models = path.join(root, "models")
      const refs = path.join(root, "sessions")
      const resizing = yield* Semaphore.make(2)
      const normalize = yield* Effect.cached(
        Effect.tryPromise({
          try: () => import("./image/photon"),
          catch: (cause) => new StorageError({ cause }),
        }).pipe(
          Effect.flatMap((adapter) => adapter.make),
          Effect.mapError(storageError),
        ),
      )

      const reference = (sessionID: string, id: string) => {
        if (!session.test(sessionID) || !Schema.is(Attachment.ID)(id)) throw new Error("Invalid attachment reference")
        return path.join(refs, sessionID, id)
      }
      const locked = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: (signal) =>
                  Flock.acquire(`${root}:${key}`, { dir: path.join(root, "locks"), timeoutMs: 2000, signal }),
                catch: storageError,
              }),
              (lock) =>
                Effect.tryPromise({ try: () => lock.release(), catch: storageError }).pipe(
                  Effect.catch((error) => Effect.logWarning("Attachment lock release failed", { error })),
                ),
            )
            return yield* effect
          }),
        )
      const atomic = Effect.fn("AttachmentStore.atomic")(function* (file: string, bytes: Uint8Array) {
        yield* fs.ensureDir(path.dirname(file))
        const temporary = `${file}.${randomUUID()}.tmp`
        yield* fs
          .writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
          .pipe(
            Effect.andThen(fs.rename(temporary, file)),
            Effect.ensuring(
              fs
                .remove(temporary, { force: true })
                .pipe(Effect.catch((error) => Effect.logWarning("Attachment temporary cleanup failed", { error }))),
            ),
          )
      })
      const retain = Effect.fn("AttachmentStore.retain")(function* (sessionID: string, id: string) {
        const file = reference(sessionID, id)
        yield* fs.ensureDir(path.dirname(file))
        if (yield* fs.exists(file)) {
          const now = yield* DateTime.nowAsDate
          // Reusing a restored session must not look orphaned to a concurrent maintenance scan.
          yield* fs.utimes(path.dirname(file), now, now)
          return
        }
        // Hard links are both ownership records and durable, deduplicated copies.
        yield* fs.link(path.join(originals, id), file)
      })
      const externalize = (sessionID: string, value: unknown, sourceSessionID = sessionID, recovering = false) => {
        const replacements = new Map<string, string>()
        return transform(value, (uri) => {
          const cached = replacements.get(uri)
          if (cached !== undefined) return Effect.succeed(cached)
          const existing = Attachment.id(uri)
          const match = dataImage.exec(uri)
          if (uri.startsWith(Attachment.PREFIX) && !existing)
            return recovering
              ? Effect.succeed(UNAVAILABLE)
              : Effect.fail(new StorageError({ cause: new Error("Invalid attachment reference") }))
          if (!existing && !match) return Effect.succeed(uri)
          const operation = Effect.gen(function* () {
            if (!session.test(sessionID) || !session.test(sourceSessionID))
              return yield* new StorageError({ cause: new Error("Invalid session ID") })
            if (existing && sourceSessionID === sessionID && (yield* fs.exists(reference(sessionID, existing))))
              return yield* locked(
                `session:${sessionID}`,
                Effect.gen(function* () {
                  yield* retain(sessionID, existing)
                  return uri
                }),
              )
            const bytes = match ? Buffer.from(match[2] ?? "", "base64") : undefined
            const extension = match?.[1] === "image/jpg" ? "jpeg" : match?.[1]?.slice(6)
            const id =
              existing ??
              `${createHash("sha256")
                .update(bytes ?? new Uint8Array())
                .digest("hex")}.${extension}`
            return yield* locked(
              `session:${sessionID}`,
              locked(
                `image:${id}`,
                Effect.gen(function* () {
                  if (!session.test(sessionID) || !session.test(sourceSessionID))
                    return yield* new StorageError({ cause: new Error("Invalid session ID") })
                  if (existing) {
                    if (!(yield* fs.exists(reference(sourceSessionID, existing))))
                      return yield* new StorageError({
                        cause: new Error("Attachment does not belong to the source session"),
                      })
                    if (!(yield* fs.exists(path.join(originals, existing)))) {
                      yield* fs.ensureDir(originals)
                      yield* fs.link(reference(sourceSessionID, existing), path.join(originals, existing))
                    }
                    yield* retain(sessionID, existing)
                    return uri
                  }
                  if (!match) return uri
                  if (!bytes?.length || bytes.toString("base64") !== match[2])
                    return yield* new StorageError({ cause: new Error("Invalid image Base64") })
                  const file = path.join(originals, id)
                  if (!(yield* fs.exists(file))) yield* atomic(file, bytes)
                  yield* retain(sessionID, id)
                  return Attachment.PREFIX + id
                }),
              ),
            )
          }).pipe(Effect.mapError(storageError))
          return (
            recovering
              ? operation.pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Attachment unavailable during persistence", { error }).pipe(
                      Effect.as(UNAVAILABLE),
                    ),
                  ),
                )
              : operation
          ).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                replacements.set(uri, result)
              }),
            ),
          )
        })
      }
      const externalizeRecovering = (sessionID: string, value: unknown, sourceSessionID?: string) =>
        externalize(sessionID, value, sourceSessionID, true).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Attachment persistence failed", { error }).pipe(
              Effect.andThen(
                transform(value, (uri) =>
                  Effect.succeed(Attachment.id(uri) || dataImage.test(uri) ? UNAVAILABLE : uri),
                ),
              ),
            ),
          ),
        )

      const capture = (sessionID: string, directory: string, value: unknown) =>
        Effect.gen(function* () {
          const root = yield* fs.realPath(directory)
          return (yield* Effect.forEach(
            imageReferences(value).filter((uri) => !Attachment.id(uri) && !uri.startsWith("data:")),
            (candidate) =>
              Effect.gen(function* () {
                const parsed = candidate.startsWith("file:") && URL.canParse(candidate) ? new URL(candidate) : undefined
                if (parsed?.hostname && parsed.hostname !== "localhost") return
                const file = yield* Effect.try({
                  try: () => path.resolve(directory, parsed ? fileURLToPath(parsed) : candidate),
                  catch: (cause) => new StorageError({ cause }),
                })
                const resolved = yield* fs.realPath(file)
                // Capturing a returned path never grants access outside the current project.
                if (!FSUtil.contains(root, resolved)) return
                const extension = path.extname(resolved).slice(1).toLowerCase().replace(/^jpg$/, "jpeg")
                const mime = Object.entries(formats).find(([format]) => format === extension)?.[1]
                if (!mime) return
                const bytes = yield* fs.readFile(resolved)
                const uri = yield* externalize(
                  sessionID,
                  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
                )
                if (typeof uri !== "string") return
                return { uri, mime, name: path.basename(resolved) }
              }).pipe(Effect.catch(() => Effect.succeed(undefined))),
          )).filter((file) => file !== undefined)
        }).pipe(Effect.mapError(storageError))

      const original = Effect.fn("AttachmentStore.original")(function* (sessionID: string, id: string) {
        if (!session.test(sessionID) || !Schema.is(Attachment.ID)(id))
          return yield* new StorageError({ cause: new Error("Invalid attachment reference") })
        return {
          content: yield* fs.readFile(reference(sessionID, id)),
          mime:
            Object.entries(formats).find(([extension]) => id.endsWith(`.${extension}`))?.[1] ??
            "application/octet-stream",
        }
      })
      const cachedVariant = Effect.fn("AttachmentStore.cachedVariant")(function* (prefix: string) {
        for (const [extension, mime] of Object.entries(formats)) {
          const file = `${prefix}.${extension}`
          if (yield* fs.exists(file)) return { content: yield* fs.readFile(file), mime }
        }
      })
      const derivative = Effect.fn("AttachmentStore.derivative")(function* (
        sessionID: string,
        id: string,
        prefix: string,
        limits: { autoResize: boolean; maxWidth: number; maxHeight: number; maxBase64Bytes: number },
      ) {
        if (!session.test(sessionID) || !Schema.is(Attachment.ID)(id))
          return yield* new StorageError({ cause: new Error("Invalid attachment reference") })
        if (!(yield* fs.exists(reference(sessionID, id))))
          return yield* new StorageError({ cause: new Error("Session attachment not found") })
        const cached = yield* cachedVariant(prefix)
        if (cached) return cached
        // CPU work is bounded and locks only this derivative, never other sessions' writes.
        return yield* locked(
          `variant:${prefix}`,
          resizing.withPermits(1)(
            Effect.gen(function* () {
              const cached = yield* cachedVariant(prefix)
              if (cached) return cached
              const image = yield* original(sessionID, id)
              const resize = yield* normalize
              const result = yield* resize(
                id,
                {
                  uri: Attachment.PREFIX + id,
                  content: Buffer.from(image.content).toString("base64"),
                  encoding: "base64",
                  mime: image.mime,
                },
                limits,
              )
              const content = Buffer.from(result.content, "base64")
              const extension = Object.entries(formats).find(([, mime]) => mime === result.mime)?.[0]
              if (!extension) return yield* new StorageError({ cause: new Error("Unsupported image variant format") })
              yield* atomic(`${prefix}.${extension}`, content).pipe(
                Effect.catch((error) => Effect.logWarning("Attachment variant cache write failed", { error })),
              )
              return { content, mime: result.mime }
            }),
          ),
        )
      })
      const read = (sessionID: string, id: string, variant: typeof Attachment.Variant.Type = "original") =>
        Effect.gen(function* () {
          if (variant === "original") return yield* original(sessionID, id)
          return yield* derivative(sessionID, id, path.join(variants, id), {
            autoResize: true,
            maxWidth: 400,
            maxHeight: 256,
            maxBase64Bytes: 128 * 1024,
          })
        }).pipe(Effect.mapError(storageError))

      const materialize = (sessionID: string, value: unknown, model: boolean | ModelLimits = false) =>
        Effect.gen(function* () {
          const settings = yield* Effect.cached(
            Effect.gen(function* () {
              if (typeof model === "object")
                return {
                  autoResize: model.autoResize,
                  maxWidth: model.maxWidth,
                  maxHeight: model.maxHeight,
                  maxBase64Bytes: model.maxBase64Bytes,
                }
              const configured = yield* Effect.serviceOption(Config.Service)
              const settings = Option.isSome(configured)
                ? Object.assign(
                    {},
                    ...(yield* configured.value.entries()).flatMap((entry) =>
                      entry.type === "document" ? [entry.info.attachments?.image ?? {}] : [],
                    ),
                  )
                : {}
              return {
                autoResize: settings.auto_resize ?? true,
                maxWidth: settings.max_width ?? 2000,
                maxHeight: settings.max_height ?? 2000,
                maxBase64Bytes: settings.max_base64_bytes ?? 5 * 1024 * 1024,
              }
            }),
          )
          const replacements = new Map<string, string>()
          return yield* transform(value, (uri) =>
            Effect.gen(function* () {
              const id = Attachment.id(uri)
              if (uri.startsWith(Attachment.PREFIX) && !id) return UNAVAILABLE
              if (!id) return uri
              const cached = replacements.get(uri)
              if (cached !== undefined) return cached
              const limits = model ? yield* settings : undefined
              const image = limits
                ? yield* derivative(
                    sessionID,
                    id,
                    path.join(models, id, createHash("sha256").update(JSON.stringify(limits)).digest("hex")),
                    limits,
                  )
                : yield* read(sessionID, id)
              return `data:${image.mime};base64,${Buffer.from(image.content).toString("base64")}`
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Attachment unavailable during materialization", { error }).pipe(
                  Effect.as(UNAVAILABLE),
                ),
              ),
              Effect.tap((result) =>
                Effect.sync(() => {
                  replacements.set(uri, result)
                }),
              ),
            ),
          )
        })

      const cleanup = (liveSessions?: ReadonlySet<string>) =>
        locked(
          "cleanup",
          Effect.gen(function* () {
            const cutoff = Date.now() - Duration.toMillis(Duration.days(1))
            if (liveSessions) {
              const sessions = yield* fs
                .readDirectory(refs)
                .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])))
              for (const id of sessions.filter((id) => session.test(id))) {
                if (liveSessions.has(id)) continue
                yield* locked(
                  `session:${id}`,
                  Effect.gen(function* () {
                    const info = yield* fs
                      .stat(path.join(refs, id))
                      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
                    if (
                      !info ||
                      Option.getOrElse(
                        Option.map(info.mtime, (date) => date.getTime()),
                        () => Date.now(),
                      ) > cutoff
                    )
                      return
                    yield* fs.remove(path.join(refs, id), { recursive: true, force: true })
                  }),
                )
              }
            }
            const files = yield* fs
              .readDirectory(originals)
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])))
            const sessions = yield* fs
              .readDirectory(refs)
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])))
            // Directory records remain authoritative even when a backup restores hard links as copies.
            const retained = new Set(
              (yield* Effect.forEach(
                sessions.filter((id) => session.test(id)),
                (id) =>
                  fs
                    .readDirectory(path.join(refs, id))
                    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([]))),
              )).flat(),
            )
            for (const id of files.filter(Schema.is(Attachment.ID))) {
              const file = path.join(originals, id)
              const info = yield* fs.stat(file)
              // A grace period protects abandoned writes and keeps cleanup off the capture hot path.
              if (
                retained.has(id) ||
                Option.getOrElse(
                  Option.map(info.mtime, (date) => date.getTime()),
                  () => Date.now(),
                ) > cutoff
              )
                continue
              yield* locked(
                `image:${id}`,
                Effect.gen(function* () {
                  const current = yield* fs
                    .readDirectory(refs)
                    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])))
                  if (
                    (yield* Effect.forEach(
                      current.filter((id) => session.test(id)),
                      (sessionID) => fs.exists(reference(sessionID, id)),
                    )).some(Boolean)
                  )
                    return
                  yield* fs.remove(file, { force: true })
                  yield* fs.remove(path.join(models, id), { recursive: true, force: true })
                  for (const extension of Object.keys(formats))
                    yield* fs.remove(path.join(variants, `${id}.${extension}`), { force: true })
                }),
              )
            }
          }),
        ).pipe(Effect.mapError(storageError))
      const remove = (sessionID: string) =>
        locked(
          `session:${sessionID}`,
          Effect.gen(function* () {
            if (!session.test(sessionID)) return yield* new StorageError({ cause: new Error("Invalid session ID") })
            yield* fs.remove(path.join(refs, sessionID), { recursive: true, force: true })
          }),
        ).pipe(Effect.mapError(storageError))
      return Service.of({
        directory: root,
        capture,
        externalize,
        externalizeRecovering,
        materialize,
        read,
        remove,
        cleanup,
      })
    }),
  )

export const layer = layerWith()
export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node, Database.node] })
export const defaultLayer = LayerNode.compile(node)
export const cleanupNode = makeGlobalNode({
  name: "attachment-cleanup",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* Service
      const database = yield* Database.Service
      if (cleanupOwners.has(store.directory)) return
      cleanupOwners.add(store.directory)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          cleanupOwners.delete(store.directory)
        }),
      )
      yield* Effect.gen(function* () {
        const rows = yield* database.db.select({ id: SessionTable.id }).from(SessionTable).all()
        const history = yield* database.db
          .select({ id: EventSequenceTable.aggregate_id })
          .from(EventSequenceTable)
          .all()
        // Replayable aggregates also pin their media when projections need rebuilding.
        yield* store.cleanup(new Set([...rows, ...history].map((row) => row.id)))
      }).pipe(
        Effect.catch((error) => Effect.logWarning("Attachment cleanup failed", { error })),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
        Effect.forkScoped,
      )
    }),
  ),
  deps: [node, Database.node],
})
