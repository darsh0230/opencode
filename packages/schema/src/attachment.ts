export * as Attachment from "./attachment"

import { Schema } from "effect"

export const PREFIX = "opencode-attachment:"
export const ID = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\.(?:png|jpeg|webp|gif|avif|bmp)$/)).annotate({
  identifier: "Attachment.ID",
})
export const Variant = Schema.Literals(["original", "thumbnail"]).annotate({ identifier: "Attachment.Variant" })

export function id(uri: string) {
  if (!uri.startsWith(PREFIX)) return
  const value = uri.slice(PREFIX.length)
  return Schema.is(ID)(value) ? value : undefined
}
