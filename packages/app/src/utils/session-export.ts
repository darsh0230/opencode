import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { Attachment } from "@opencode-ai/schema/attachment"
import { Encoding } from "effect"

// Matches the exact `{ info, messages: [{ info, parts }] }` structure produced by `opencode export` CLI
export type SessionExportData = {
  info: Session
  messages: {
    info: Message
    parts: Part[]
  }[]
}

export type SessionExportClient = {
  session: {
    get: (input: { sessionID: string }) => Promise<{ data?: Session | null }>
    messages: (input: { sessionID: string }) => Promise<{ data?: SessionExportData["messages"] | null }>
    attachment?: (
      input: { sessionID: string; attachmentID: string; variant?: "original" | "thumbnail" },
      options?: { parseAs: "blob" },
    ) => Promise<{ data?: unknown }>
  }
}

export class AttachmentUnavailableError extends Error {
  readonly _tag = "AttachmentUnavailable"
  constructor() {
    super("AttachmentUnavailable")
    this.name = "AttachmentUnavailableError"
  }
}

export async function fetchSessionExport(input: {
  sessionID: string
  client: SessionExportClient
}): Promise<SessionExportData> {
  const [sessionRes, messagesRes] = await Promise.all([
    input.client.session.get({ sessionID: input.sessionID }),
    input.client.session.messages({ sessionID: input.sessionID }),
  ])

  if (!sessionRes?.data) {
    throw new Error(`Session not found: ${input.sessionID}`)
  }
  if (!messagesRes?.data) {
    throw new Error(`Failed to load messages for session: ${input.sessionID}`)
  }

  const images = new Map<string, Promise<string>>()
  const portable = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(portable))
    if (value && typeof value === "object")
      return Object.fromEntries(
        await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await portable(item)])),
      )
    if (typeof value !== "string") return value
    const attachmentID = Attachment.id(value)
    if (!attachmentID) return value
    const pending = images.get(attachmentID)
    if (pending) return pending
    const result = (async () => {
      const response = await input.client.session.attachment?.(
        { sessionID: input.sessionID, attachmentID },
        { parseAs: "blob" },
      )
      const blob = response?.data
      if (!(blob instanceof Blob)) throw new AttachmentUnavailableError()
      return `data:${blob.type};base64,${Encoding.encodeBase64(new Uint8Array(await blob.arrayBuffer()))}`
    })()
    images.set(attachmentID, result)
    return result
  }
  const metadata = async (value: Record<string, unknown>) =>
    Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await portable(item)])))
  const messages = await Promise.all(
    messagesRes.data.map(async (message) => ({
      ...message,
      parts: await Promise.all(
        message.parts.map(async (part) => {
          if (part.type !== "tool" || part.state.status !== "completed") return part
          const output = await portable(part.state.output)
          return {
            ...part,
            metadata: part.metadata && (await metadata(part.metadata)),
            state: {
              ...part.state,
              output: typeof output === "string" ? output : part.state.output,
              metadata: await metadata(part.state.metadata),
              attachments: await Promise.all(
                (part.state.attachments ?? []).map(async (file) => {
                  const url = await portable(file.url)
                  if (typeof url !== "string") throw new AttachmentUnavailableError()
                  return { ...file, url }
                }),
              ),
            },
          }
        }),
      ),
    })),
  )
  return {
    info: sessionRes.data,
    messages,
  }
}

export function sessionExportFilename(session: { id: string; title?: string; slug?: string }) {
  const name = session.title || session.slug || session.id
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `${clean || session.id}.json`
}

export function downloadSessionExport(filename: string, data: unknown) {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
