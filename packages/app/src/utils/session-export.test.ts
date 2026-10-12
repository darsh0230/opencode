import { describe, expect, test } from "bun:test"
import { fetchSessionExport, sessionExportFilename } from "./session-export"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

describe("sessionExportFilename", () => {
  test("generates filename from title", () => {
    expect(sessionExportFilename({ id: "ses_123", title: "Clone PR in worktree from fork" })).toBe(
      "clone-pr-in-worktree-from-fork.json",
    )
  })

  test("generates filename from slug when title missing", () => {
    expect(sessionExportFilename({ id: "ses_123", slug: "my-session-slug" })).toBe("my-session-slug.json")
  })

  test("falls back to id when title and slug are empty", () => {
    expect(sessionExportFilename({ id: "ses_123" })).toBe("ses_123.json")
  })
})

describe("fetchSessionExport", () => {
  test("embeds original managed images and nested metadata once for portable exports", async () => {
    const session: Session = {
      id: "ses_1",
      slug: "test",
      projectID: "project",
      directory: "/project",
      title: "Test",
      version: "test",
      time: { created: 0, updated: 0 },
    }
    const message: Message = {
      id: "msg_1",
      sessionID: session.id,
      role: "assistant",
      parentID: "msg_parent",
      agent: "build",
      mode: "build",
      path: { cwd: "/project", root: "/project" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: "test",
      modelID: "test",
      time: { created: 0 },
    }
    const url = `opencode-attachment:${"a".repeat(64)}.png`
    const part: Part = {
      id: "prt_1",
      sessionID: session.id,
      messageID: message.id,
      type: "tool",
      callID: "call_1",
      tool: "screenshot",
      state: {
        status: "completed",
        input: {},
        title: "Screenshot",
        output: "Screenshot",
        metadata: { nested: { uri: url } },
        time: { start: 0, end: 1 },
        attachments: [
          { id: "prt_image", sessionID: session.id, messageID: message.id, type: "file", mime: "image/png", url },
        ],
      },
    }
    const requests: unknown[] = []
    const client = {
      session: {
        get: async () => ({ data: session }),
        messages: async () => ({ data: [{ info: message, parts: [part] }] }),
        attachment: async (input: unknown) => {
          requests.push(input)
          return { data: new Blob([new Uint8Array([0, 1, 255])], { type: "image/png" }) }
        },
      },
    }
    const result = await fetchSessionExport({ sessionID: session.id, client })
    expect(requests).toEqual([{ sessionID: session.id, attachmentID: `${"a".repeat(64)}.png` }])
    expect(JSON.stringify(result)).not.toContain("opencode-attachment:")
    expect(JSON.stringify(result)).toContain("data:image/png;base64,AAH/")
    expect(part.state.status === "completed" ? part.state.attachments?.[0]?.url : undefined).toBe(url)
    await expect(
      fetchSessionExport({
        sessionID: session.id,
        client: { session: { ...client.session, attachment: async () => ({ data: undefined }) } },
      }),
    ).rejects.toMatchObject({ _tag: "AttachmentUnavailable" })
  })

  test("fetches full transcript from client", async () => {
    const session = { id: "ses_1", title: "Test Session" } as Session
    const msg = { id: "msg_1", role: "user" } as Message
    const part = { id: "prt_1", type: "text", text: "hello" } as Part
    const messages = [{ info: msg, parts: [part] }]

    const client = {
      session: {
        get: async () => ({ data: session }),
        messages: async () => ({ data: messages }),
      },
    }

    const result = await fetchSessionExport({
      sessionID: "ses_1",
      client,
    })

    expect(result).toEqual({
      info: session,
      messages,
    })
  })

  test("throws when session not found", async () => {
    const client = {
      session: {
        get: async () => ({ data: null }),
        messages: async () => ({ data: [] }),
      },
    }

    expect(
      fetchSessionExport({
        sessionID: "ses_missing",
        client,
      }),
    ).rejects.toThrow("Session not found: ses_missing")
  })
})
