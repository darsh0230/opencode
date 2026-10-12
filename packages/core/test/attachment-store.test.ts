import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { LLMEvent, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Attachment } from "@opencode-ai/schema/attachment"
import { AttachmentStore } from "../src/attachment-store"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { LayerNode } from "../src/effect/layer-node"
import { makeGlobalNode } from "../src/effect/app-node"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { FSUtil } from "../src/fs-util"
import { Global } from "../src/global"
import { ModelV2 } from "../src/model"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { createLLMEventPublisher } from "../src/session/runner/publish-llm-event"
import { toLLMMessagesEffect } from "../src/session/runner/to-llm-message"
import { SessionSchema } from "../src/session/schema"
import { SessionMessageTable, SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const sessionID = SessionSchema.ID.make("ses_attachment_test")
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
const uri = `data:image/png;base64,${png}`
const decodeString = Schema.decodeUnknownSync(Schema.String)

const withStore = <A, E, R>(
  body: (input: { root: string; store: AttachmentStore.Interface; fs: FSUtil.Interface }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = LayerNode.compile(
        LayerNode.group([
          AttachmentStore.node,
          FSUtil.node,
          Global.node,
          Database.node,
          EventV2.node,
          SessionProjector.node,
        ]),
        [
          [
            AttachmentStore.node,
            makeGlobalNode({
              service: AttachmentStore.Service,
              layer: AttachmentStore.layerWith(path.join(tmp.path, "attachments")),
              deps: [FSUtil.node, Global.node],
            }),
          ],
          [Global.node, Global.layerWith({ data: tmp.path })],
          [Database.node, Database.layerFromPath(":memory:")],
        ],
      )
      return Effect.gen(function* () {
        return yield* body({ root: tmp.path, store: yield* AttachmentStore.Service, fs: yield* FSUtil.Service })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("AttachmentStore", () => {
  it.live("missing references degrade independently without changing durable history", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const stored = decodeString(yield* store.externalize(sessionID, uri))
        const missing = `${Attachment.PREFIX}${"f".repeat(64)}.png`
        const value = {
          output: "Tool completed",
          attachments: [
            { mime: "image/png", url: missing },
            { mime: "image/png", url: stored },
          ],
          metadata: { image: missing },
        }
        const expected = {
          output: `Tool completed\n${AttachmentStore.UNAVAILABLE}`,
          attachments: [{ mime: "image/png", url: uri }],
          metadata: { image: AttachmentStore.UNAVAILABLE },
        }
        expect(yield* store.materialize(sessionID, value)).toEqual(expected)
        expect(yield* store.materialize(sessionID, value)).toEqual(expected)
        expect(value.attachments[0]?.url).toBe(missing)
        const imported = yield* store.externalizeRecovering("ses_imported", value)
        expect(JSON.stringify(imported)).not.toContain(Attachment.PREFIX)
        expect(JSON.stringify(imported)).toContain(AttachmentStore.UNAVAILABLE)
      }),
    ),
  )

  it.live("storage failures preserve tool text and omit failed media", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        yield* fs.ensureDir(path.join(root, "attachments"))
        yield* fs.writeFileString(path.join(root, "attachments/originals"), "not a directory")
        expect(
          yield* store.externalizeRecovering(sessionID, {
            output: "Done",
            attachments: [{ url: uri, mime: "image/png" }],
          }),
        ).toEqual({ output: `Done\n${AttachmentStore.UNAVAILABLE}`, attachments: [] })
      }),
    ),
  )

  it.live("invalid images fail thumbnail requests instead of returning the original", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const stored = decodeString(yield* store.externalize(sessionID, uri))
        const id = Attachment.id(stored)
        if (!id) throw new Error("Missing managed attachment")
        expect(Option.isNone(yield* store.read(sessionID, id, "thumbnail").pipe(Effect.option))).toBe(true)
        expect((yield* store.read(sessionID, id)).content).toEqual(Buffer.from(png, "base64"))
      }),
    ),
  )

  it.live("default stores isolate separate in-memory databases and use the configured database filename", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const make = (filename: string) =>
            LayerNode.compile(AttachmentStore.node, [
              [Global.node, Global.layerWith({ data: tmp.path })],
              [Database.node, Database.layerFromPath(filename)],
            ])
          const first = yield* AttachmentStore.Service.pipe(Effect.provide(make(":memory:")))
          const second = yield* AttachmentStore.Service.pipe(Effect.provide(make(":memory:")))
          expect(first.directory).not.toBe(second.directory)
          const stored = decodeString(yield* first.externalize(sessionID, uri))
          const id = Attachment.id(stored)
          if (!id) throw new Error("Missing managed attachment")
          expect(Option.isNone(yield* second.read(sessionID, id).pipe(Effect.option))).toBe(true)
          const disk = yield* AttachmentStore.Service.pipe(Effect.provide(make(path.join(tmp.path, "other.db"))))
          expect(disk.directory).not.toBe(first.directory)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("retains restored ownership copies and reconstructs the shared original index", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const stored = decodeString(yield* store.externalize(sessionID, uri))
        const id = Attachment.id(stored)
        if (!id) throw new Error("Missing managed attachment")
        const original = path.join(root, "attachments/originals", id)
        const reference = path.join(root, "attachments/sessions", sessionID, id)
        yield* fs.copyFile(reference, reference + ".copy")
        yield* fs.remove(reference)
        yield* fs.rename(reference + ".copy", reference)
        yield* fs.utimes(original, new Date(0), new Date(0))
        yield* store.cleanup()
        expect(yield* fs.exists(original)).toBe(true)
        yield* fs.remove(original)
        yield* store.externalize("ses_restored", stored, sessionID)
        yield* store.remove(sessionID)
        expect(yield* store.materialize("ses_restored", stored)).toBe(uri)
      }),
    ),
  )

  it.live("cleans old orphan ownership records while preserving live sessions", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const stored = decodeString(yield* store.externalize(sessionID, uri))
        const id = Attachment.id(stored)
        if (!id) throw new Error("Missing managed attachment")
        const original = path.join(root, "attachments/originals", id)
        yield* fs.utimes(original, new Date(0), new Date(0))
        yield* fs.utimes(path.join(root, "attachments/sessions", sessionID), new Date(0), new Date(0))
        yield* store.cleanup(new Set([sessionID]))
        expect(yield* fs.exists(original)).toBe(true)
        yield* store.cleanup(new Set())
        expect(yield* fs.exists(original)).toBe(false)
      }),
    ),
  )

  it.live("round-trips portable images and metadata into a new session without rewriting the source", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const source = { attachments: [{ uri, mime: "image/png" }], metadata: { image: uri } }
        const stored = yield* store.externalize(sessionID, source)
        const portable = yield* store.materialize(sessionID, stored)
        expect(portable).toEqual(source)
        const imported = yield* store.externalize("ses_imported", portable)
        yield* store.remove(sessionID)
        expect(yield* store.materialize("ses_imported", imported)).toEqual(source)
        expect(source.attachments[0]?.uri).toBe(uri)
      }),
    ),
  )

  it.live("preserves original bytes, deduplicates concurrent captures, and reloads from disk", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          Array.from({ length: 6 }, () => store.externalize(sessionID, uri)),
          { concurrency: "unbounded" },
        )
        expect(new Set(results).size).toBe(1)
        const stored = decodeString(results[0])
        const id = Attachment.id(stored)
        if (!id) throw new Error("Missing managed attachment")
        expect((yield* store.read(sessionID, id)).content).toEqual(Buffer.from(png, "base64"))
        expect(yield* fs.readDirectory(path.join(root, "attachments/originals"))).toEqual([id])
        expect(yield* store.materialize(sessionID, { image: stored, historic: uri })).toEqual({
          image: uri,
          historic: uri,
        })
        const reloaded = yield* AttachmentStore.Service.use((next) => next.materialize(sessionID, stored)).pipe(
          Effect.provide(AttachmentStore.layerWith(path.join(root, "attachments"))),
        )
        expect(reloaded).toBe(uri)
      }),
    ),
  )

  it.live("fork ownership survives deletion and cleanup removes only unreferenced originals", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const stored = decodeString(yield* store.externalize(sessionID, uri))
        const id = Attachment.id(stored)
        if (!id) throw new Error("Missing managed attachment")
        yield* store.externalize("ses_fork", stored, sessionID)
        const file = path.join(root, "attachments/originals", id)
        yield* fs.utimes(file, new Date(0), new Date(0))
        expect(Option.getOrUndefined((yield* fs.stat(file)).nlink)).toBe(3)
        yield* store.remove(sessionID)
        yield* store.cleanup()
        expect(yield* store.materialize("ses_fork", stored)).toBe(uri)
        yield* store.remove("ses_fork")
        yield* store.cleanup()
        expect(yield* fs.exists(file)).toBe(false)
      }),
    ),
  )

  it.live("rejects cross-session access and traversal, and retains recent orphan writes", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const stored = decodeString(yield* store.externalize(sessionID, uri))
        const id = Attachment.id(stored)
        if (!id) throw new Error("Missing managed attachment")
        expect(Option.isNone(yield* store.read("ses_other", id).pipe(Effect.option))).toBe(true)
        expect(Option.isNone(yield* store.externalize("ses_other", stored).pipe(Effect.option))).toBe(true)
        expect(Option.isNone(yield* store.read(sessionID, "../../secret").pipe(Effect.option))).toBe(true)
        yield* store.remove(sessionID)
        yield* store.cleanup()
        expect(yield* fs.exists(path.join(root, "attachments/originals", id))).toBe(true)
      }),
    ),
  )

  it.live("captures paths before they are overwritten and rejects external symlinks", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const directory = path.join(root, "project")
        yield* fs.ensureDir(directory)
        yield* fs.writeFile(path.join(directory, "screen (dark).png"), Buffer.from(png, "base64"))
        yield* fs.writeFile(path.join(root, "outside.png"), Buffer.from(png, "base64"))
        yield* fs.symlink(path.join(root, "outside.png"), path.join(directory, "escape.png"))
        const captured = yield* store.capture(sessionID, directory, {
          output: "[Screenshot](screen (dark).png)",
          metadata: { screenshot: "escape.png" },
        })
        expect(captured).toHaveLength(1)
        expect(yield* store.capture(sessionID, directory, JSON.stringify({ filePath: "screen (dark).png" }))).toEqual(
          captured,
        )
        yield* fs.writeFileString(path.join(directory, "screen (dark).png"), "overwritten")
        expect(yield* store.materialize(sessionID, captured[0]?.uri)).toBe(uri)
      }),
    ),
  )

  it.live("creates thumbnails and model variants while keeping full-resolution originals", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const adapter = yield* Effect.promise(() => import("../src/image/photon"))
        yield* adapter.make
        const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
        const source = new photon.PhotonImage(new Uint8Array(9000 * 4).fill(255), 9000, 1)
        const original = source.get_bytes()
        source.free()
        const stored = decodeString(
          yield* store.externalize(sessionID, `data:image/png;base64,${Buffer.from(original).toString("base64")}`),
        )
        const id = Attachment.id(stored)
        if (!id) throw new Error("Missing managed attachment")
        const thumbnail = yield* store.read(sessionID, id, "thumbnail")
        const thumb = photon.PhotonImage.new_from_byteslice(thumbnail.content)
        expect(thumb.get_width()).toBeLessThanOrEqual(400)
        thumb.free()
        const modeled = decodeString(yield* store.materialize(sessionID, stored, true))
        const model = photon.PhotonImage.new_from_byteslice(
          Buffer.from(modeled.slice(modeled.indexOf(",") + 1), "base64"),
        )
        expect(model.get_width()).toBeLessThanOrEqual(2000)
        model.free()
        expect((yield* store.read(sessionID, id)).content).toEqual(original)
        const reads: number[] = []
        expect(
          yield* store.materialize(sessionID, [stored, stored], true).pipe(
            Effect.provide(
              Layer.mock(Config.Service, {
                entries: () =>
                  Effect.sync(() => {
                    reads.push(1)
                    return []
                  }),
              }),
            ),
          ),
        ).toEqual([modeled, modeled])
        expect(reads).toHaveLength(1)
        const limits = { autoResize: true, maxWidth: 1000, maxHeight: 1000, maxBase64Bytes: 5 * 1024 * 1024 }
        const smaller = decodeString(yield* store.materialize(sessionID, stored, limits))
        const decoded = photon.PhotonImage.new_from_byteslice(
          Buffer.from(smaller.slice(smaller.indexOf(",") + 1), "base64"),
        )
        expect(decoded.get_width()).toBeLessThanOrEqual(1000)
        decoded.free()
        expect(yield* fs.readDirectory(path.join(store.directory, "models", id))).toHaveLength(2)
        // Cache hits must work without decoding the original again.
        yield* fs.writeFileString(path.join(store.directory, "sessions", sessionID, id), "undecodable")
        expect(yield* store.materialize(sessionID, stored, true)).toBe(modeled)
        expect(yield* store.materialize(sessionID, stored, limits)).toBe(smaller)
      }),
    ),
  )

  it.live("persists reference-only events and projections and replays images into model history", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const adapter = yield* Effect.promise(() => import("../src/image/photon"))
        yield* adapter.make
        const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
        const pixel = new photon.PhotonImage(new Uint8Array([255, 255, 255, 255]), 1, 1)
        const base64 = Buffer.from(pixel.get_bytes()).toString("base64")
        pixel.free()
        const db = (yield* Database.Service).db
        const projectID = Project.ID.make("project-attachments")
        yield* db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: AbsolutePath.make(root), sandboxes: [] })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "attachments",
            directory: AbsolutePath.make(root),
            title: "Attachments",
            version: "test",
          })
          .run()
        const publisher = createLLMEventPublisher(
          yield* EventV2.Service,
          {
            sessionID,
            agent: "build",
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          },
          store,
        )
        yield* publisher.publish(
          LLMEvent.toolCall({ id: "screen", name: "screenshot", input: {}, providerExecuted: true }),
        )
        yield* publisher.publish(
          LLMEvent.toolResult({
            id: "screen",
            name: "screenshot",
            providerExecuted: true,
            result: {
              type: "content",
              value: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }],
            },
          }),
        )
        const events = yield* db.select().from(EventTable).all()
        const rows = yield* db.select().from(SessionMessageTable).all()
        expect(JSON.stringify(events)).not.toContain(base64)
        expect(JSON.stringify(rows)).not.toContain(base64)
        expect(JSON.stringify(events)).toContain(Attachment.PREFIX)
        const portable = yield* store.materialize(sessionID, rows)
        expect(JSON.stringify(portable)).toContain(base64)
        const messages = rows.map((row) =>
          Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, type: row.type, id: row.id }),
        )
        const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })
        const resolved = yield* toLLMMessagesEffect(messages, model, store, sessionID)
        expect(JSON.stringify(resolved)).toContain(base64)
        expect(JSON.stringify(resolved)).not.toContain(Attachment.PREFIX)
        expect(JSON.stringify(messages)).toContain(Attachment.PREFIX)
        // Losing files must never poison a durable session's later provider turns.
        yield* store.remove(sessionID)
        const degraded = yield* toLLMMessagesEffect(messages, model, store, sessionID)
        expect(JSON.stringify(degraded)).toContain(AttachmentStore.UNAVAILABLE)
        expect(JSON.stringify(degraded)).not.toContain(Attachment.PREFIX)
        expect(JSON.stringify(yield* toLLMMessagesEffect(messages, model, store, sessionID))).toContain(
          AttachmentStore.UNAVAILABLE,
        )
        yield* fs.remove(path.join(store.directory, "originals"), { recursive: true })
        yield* fs.writeFileString(path.join(store.directory, "originals"), "not a directory")
        yield* publisher.publish(
          LLMEvent.toolCall({ id: "blocked", name: "screenshot", input: {}, providerExecuted: true }),
        )
        yield* publisher.publish(
          LLMEvent.toolResult({
            id: "blocked",
            name: "screenshot",
            providerExecuted: true,
            result: {
              type: "content",
              value: [
                { type: "text", text: "Tool finished" },
                { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" },
              ],
            },
          }),
        )
        const published = yield* db.select().from(SessionMessageTable).all()
        expect(JSON.stringify(published)).toContain("Tool finished")
        expect(JSON.stringify(published)).toContain(AttachmentStore.UNAVAILABLE)
        const projected = published.map((row) =>
          Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, type: row.type, id: row.id }),
        )
        const blocked = projected.flatMap((message) =>
          message.type === "assistant"
            ? message.content.filter((part) => part.type === "tool" && part.id === "blocked")
            : [],
        )[0]
        expect(blocked).toMatchObject({
          type: "tool",
          state: {
            status: "completed",
            content: [
              { type: "text", text: "Tool finished" },
              { type: "text", text: AttachmentStore.UNAVAILABLE },
            ],
          },
        })
      }),
    ),
  )
})
