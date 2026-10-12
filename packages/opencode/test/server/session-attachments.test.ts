import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Attachment } from "@opencode-ai/schema/attachment"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AttachmentStore } from "@opencode-ai/core/attachment-store"
import { MessageV2 } from "@/session/message-v2"
import { prepareExport } from "@/cli/cmd/export"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, AttachmentStore.node])),
    httpApiLayer,
  ),
)

afterEach(disposeAllInstances)

it.instance("serves original bytes through both APIs, enforces session ownership, and retains fork images", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const session = yield* Session.Service
    const original = yield* session.create({})
    const other = yield* session.create({})
    yield* Effect.addFinalizer(() => session.remove(original.id).pipe(Effect.ignore))
    yield* Effect.addFinalizer(() => session.remove(other.id).pipe(Effect.ignore))
    const messageID = MessageID.ascending()
    yield* session.updateMessage({
      id: messageID,
      role: "assistant",
      sessionID: original.id,
      parentID: MessageID.ascending(),
      mode: "build",
      agent: "build",
      path: { cwd: instance.directory, root: instance.directory },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish: "end_turn",
    })
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64")
    const part = yield* session.updatePart({
      type: "tool",
      id: PartID.ascending(),
      messageID,
      sessionID: original.id,
      callID: "screenshot",
      tool: "screenshot",
      state: {
        status: "completed",
        input: {},
        output: "Screenshot",
        title: "Screenshot",
        metadata: {},
        time: { start: Date.now(), end: Date.now() },
        attachments: [
          {
            type: "file",
            id: PartID.ascending(),
            messageID,
            sessionID: original.id,
            mime: "image/png",
            filename: "screenshot.png",
            url: `data:image/png;base64,${bytes.toString("base64")}`,
          },
        ],
      },
    })
    if (part.state.status !== "completed") throw new Error("Expected completed tool")
    const id = Attachment.id(part.state.attachments?.[0]?.url ?? "")
    if (!id) throw new Error("Expected managed image")
    for (const prefix of ["/session", "/api/session"]) {
      const response = yield* requestInDirectory(`${prefix}/${original.id}/attachment/${id}`, instance.directory)
      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("image/png")
      expect(Buffer.from(yield* response.arrayBuffer)).toEqual(bytes)
      expect((yield* requestInDirectory(`${prefix}/${other.id}/attachment/${id}`, instance.directory)).status).toBe(404)
    }
    const fork = yield* session.fork({ sessionID: original.id })
    yield* Effect.addFinalizer(() => session.remove(fork.id).pipe(Effect.ignore))
    yield* session.remove(original.id)
    const response = yield* requestInDirectory(`/session/${fork.id}/attachment/${id}`, instance.directory)
    expect(response.status).toBe(200)
    expect(Buffer.from(yield* response.arrayBuffer)).toEqual(bytes)
    const messages = yield* session.messages({ sessionID: fork.id })
    const portable = yield* prepareExport({ info: fork, messages })
    expect(JSON.stringify(portable)).toContain(bytes.toString("base64"))
    expect(JSON.stringify(portable)).not.toContain(Attachment.PREFIX)
    const redacted = yield* prepareExport({ info: fork, messages }, true)
    expect(JSON.stringify(redacted)).not.toContain(Attachment.PREFIX)
    const store = yield* AttachmentStore.Service
    const sanitizedPart = redacted.messages.flatMap((message) => message.parts).find((part) => part.type === "tool")
    if (!sanitizedPart) throw new Error("Missing sanitized tool part")
    expect((yield* MessageV2.externalizeToolPart(store, sanitizedPart)).type).toBe("tool")
    // Raw API archives retain managed URIs; importing them into an unowned session must degrade.
    const imported = yield* MessageV2.externalizeToolPart(store, { ...part, sessionID: other.id })
    expect(JSON.stringify(imported)).not.toContain(Attachment.PREFIX)
    expect(JSON.stringify(imported)).toContain(AttachmentStore.UNAVAILABLE)
  }),
)
