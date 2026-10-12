import { createEffect, createResource, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useData } from "../context"
import type { ToolImage } from "./tool-images"
import { isImageReference } from "@opencode-ai/core/util/tool-images"

export function ToolImageThumbnail(props: { image: ToolImage; toolID: string; onLoad?: () => void }) {
  const data = useData()
  const dialog = useDialog()
  const i18n = useI18n()
  const lifetime = new AbortController()
  onCleanup(() => lifetime.abort())
  const [state, setState] = createStore({ loaded: false, failed: false, opening: false, src: "" })
  const [image] = createResource(
    () => ({ url: props.image.url, toolID: props.toolID, sessionID: data.sessionID, directory: data.directory }),
    async (source) => {
      setState({ loaded: false, failed: false })
      if (!isImageReference(source.url)) return
      if (/^data:image\//i.test(source.url)) return source.url
      return data.resolveToolImage?.(source.url, source.toolID, "thumbnail").catch(() => undefined)
    },
  )
  createEffect(() => {
    const value = image()
    const url = value instanceof Blob ? URL.createObjectURL(value) : value
    setState({ src: url ?? "", loaded: false, failed: false })
    if (value instanceof Blob && url) onCleanup(() => URL.revokeObjectURL(url))
  })
  const name = () => props.image.name ?? i18n.t("ui.imagePreview.alt")
  const unavailable = () => state.failed || (!image.loading && !state.src)

  return (
    <button
      type="button"
      data-component="tool-image-thumbnail"
      disabled={!state.loaded || state.opening || unavailable()}
      aria-busy={state.opening}
      aria-label={name()}
      aria-haspopup="dialog"
      title={props.image.name ?? (/^data:/i.test(props.image.url) ? name() : props.image.url)}
      onClick={async () => {
        if (!props.image.url.startsWith("opencode-attachment:")) {
          dialog.show(() => <ImagePreview src={state.src} alt={name()} />)
          return
        }
        setState("opening", true)
        const original = await data.resolveToolImage?.(props.image.url, props.toolID, "original").catch(() => undefined)
        if (lifetime.signal.aborted) return
        setState("opening", false)
        if (!original) {
          setState("failed", true)
          return
        }
        dialog.show(() => <OriginalPreview image={original} alt={name()} />)
      }}
    >
      <Show
        when={!unavailable()}
        fallback={
          <span data-slot="tool-image-placeholder">
            {i18n.t("ui.fileMedia.state.unavailable", { kind: i18n.t("ui.fileMedia.kind.image") })}
          </span>
        }
      >
        <Show when={!state.loaded || state.opening}>
          <span data-slot="tool-image-placeholder">
            <Spinner />
          </span>
        </Show>
        <Show when={state.src}>
          {(url) => (
            <img
              src={url()}
              alt={name()}
              decoding="async"
              onLoad={() => {
                setState("loaded", true)
                props.onLoad?.()
              }}
              onError={() => {
                setState("failed", true)
                props.onLoad?.()
              }}
            />
          )}
        </Show>
      </Show>
    </button>
  )
}

function OriginalPreview(props: { image: string | Blob; alt: string }) {
  const url = props.image instanceof Blob ? URL.createObjectURL(props.image) : props.image
  if (props.image instanceof Blob) onCleanup(() => URL.revokeObjectURL(url))
  return <ImagePreview src={url} alt={props.alt} />
}
