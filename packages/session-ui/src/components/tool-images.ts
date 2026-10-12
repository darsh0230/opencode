import type { ToolPart } from "@opencode-ai/sdk/v2"
import { imageReferences, isImageReference } from "@opencode-ai/core/util/tool-images"

export type ToolImage = { url: string; name?: string }

export function toolImages(state: ToolPart["state"]): ToolImage[] {
  if (state.status !== "completed") return []
  const attachments = (state.attachments ?? [])
    .filter((file) => file.mime.startsWith("image/") && isImageReference(file.url))
    .map((file) => ({ url: file.url, name: file.filename }))
  // MCPs commonly return both image bytes and a link to the same screenshot.
  // Treat their attachments as authoritative, using paths only as a fallback.
  if (attachments.length) return [...new Map(attachments.map((image) => [image.url, image])).values()]
  return imageReferences([state.output, state.metadata]).map((url) => ({ url }))
}

/** Convert a server-local image reference to a location-relative file API path. */
export function toolImagePath(url: string, directory: string) {
  const file = /^file:/i.test(url)
  if (file && !URL.canParse(url)) return
  const parsed = file ? new URL(url) : undefined
  if (parsed && parsed.hostname && parsed.hostname !== "localhost") return
  const path = decodePath(parsed ? parsed.pathname : url)
    .replace(/\\/g, "/")
    .replace(/^\/([a-z]:\/)/i, "$1")
  const root = directory.replace(/\\/g, "/").replace(/\/$/, "")
  const windows = /^[a-z]:\//i.test(root)
  const absolute = path.startsWith("/") || /^[a-z]:\//i.test(path)
  const inside = windows ? path.toLowerCase().startsWith(root.toLowerCase() + "/") : path.startsWith(root + "/")
  if (absolute && !inside) return
  if (!absolute && /^[a-z][a-z\d+.-]*:/i.test(path)) return
  const relative = absolute ? path.slice(root.length + 1) : path
  const segments: string[] = []
  for (const segment of relative.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (!segments.length) return
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length ? segments.join("/") : undefined
}

function decodePath(path: string) {
  return path.replace(/(?:%[\da-f]{2})+/gi, (value) =>
    new TextDecoder().decode(Uint8Array.from(value.match(/%[\da-f]{2}/gi)!, (byte) => parseInt(byte.slice(1), 16))),
  )
}
