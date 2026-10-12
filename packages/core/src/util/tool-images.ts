import { Option, Schema } from "effect"
import { Attachment } from "@opencode-ai/schema/attachment"

const extension = /\.(?:png|jpe?g|webp|gif|avif|bmp)$/i
const inline = /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,/i
const scheme = /^[a-z][a-z\d+.-]*:/i
const local = /^(?:file:|[a-z]:[\\/])/i

/** Shared capture/preview policy: raster images from inline data, managed media, or local files only. */
export function isImageReference(value: string) {
  const uri = value.trim()
  if (Attachment.id(uri) || inline.test(uri)) return true
  if (!extension.test(uri)) return false
  if (/^\/\//.test(uri)) return false
  return !scheme.test(uri) || local.test(uri)
}

export function imageReferences(value: unknown): string[] {
  const images = new Set<string>()
  const add = (value: string) => {
    const uri = value
      .trim()
      .replace(/^<|>$/g, "")
      .replace(/\s+["'][^"']*["']$/, "")
    if (isImageReference(uri)) images.add(uri)
  }
  const visit = (value: unknown, depth: number) => {
    if (depth > 8) return
    if (Array.isArray(value)) {
      value.slice(0, 64).forEach((item) => visit(item, depth + 1))
      return
    }
    if (value && typeof value === "object") {
      Object.values(value)
        .slice(0, 64)
        .forEach((item) => visit(item, depth + 1))
      return
    }
    if (typeof value !== "string") return
    if (
      !/[\r\n]/.test(value) &&
      !/^(?:saved(?:\s+(?:screenshot|image))?\s+(?:to|at)|(?:screenshot|image)(?:\s+(?:saved|captured))?\s+(?:to|at))\s/i.test(
        value.trim(),
      )
    )
      add(value)
    if (value.length > 32768) return
    if (/^[{[]/.test(value.trim())) {
      const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
      if (Option.isSome(parsed)) {
        visit(parsed.value, depth + 1)
        return
      }
    }
    for (const match of value.matchAll(
      /!?\[[^\]\n]*\]\((<[^>\n]+>|[^\n]+?)\)(?=\s|$)|`([^`\n]+)`|(?:saved(?:\s+(?:screenshot|image))?\s+(?:to|at)|(?:screenshot|image)(?:\s+(?:saved|captured))?\s*(?:to|at|:))\s*["']?([^\n]+?\.(?:png|jpe?g|webp|gif|avif|bmp))(?=["']?(?:[.!]?\s*$))/gim,
    ))
      add(match[1] ?? match[2] ?? match[3] ?? "")
    for (const match of value.matchAll(
      /"(?:path|file_?path|file_?name|screenshot(?:_?path)?|image(?:_?path)?|url|uri)"\s*:\s*"((?:\\.|[^"\\])*)"/gi,
    )) {
      const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(`"${match[1] ?? ""}"`)
      if (Option.isSome(parsed) && typeof parsed.value === "string") add(parsed.value)
    }
    value.split("\n").forEach((line) => {
      const uri = line.trim()
      if (/^(?:file:|[a-z]:[\\/]|\/|\.{1,2}[\\/])/i.test(uri) || !/\s/.test(uri)) add(uri)
    })
  }
  visit(value, 0)
  return [...images]
}
