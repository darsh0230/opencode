import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { toolImagePath, toolImages } from "./tool-images"

function completed(output: string, metadata: Record<string, unknown> = {}): ToolPart["state"] {
  return { status: "completed", input: {}, output, metadata, title: "Screenshot", time: { start: 1, end: 2 } }
}

describe("toolImages", () => {
  test("never extracts remote URLs, SVGs or protocol-relative image sources", () => {
    const state = completed(
      "[remote](https://tracker.example/pixel.png)\nhttp://127.0.0.1/private.png\n//tracker.example/pixel.png\n[vector](vector.svg)",
      { image: "https://tracker.example/pixel.png" },
    )
    if (state.status !== "completed") throw new Error("Expected completed tool")
    state.attachments = [
      {
        id: "remote",
        type: "file",
        sessionID: "session",
        messageID: "message",
        mime: "image/png",
        url: "https://tracker.example/pixel.png",
      },
    ]
    expect(toolImages(state)).toEqual([])
  })
  test("recognizes managed image references in output and metadata", () => {
    const url = `opencode-attachment:${"a".repeat(64)}.png`
    expect(toolImages(completed(url, { image: url }))).toEqual([{ url }])
  })
  test("extracts Playwright file links with spaces and parentheses", () => {
    expect(toolImages(completed("### Artifacts\n- [Screenshot](screenshots/home (dark mode).png)"))).toEqual([
      { url: "screenshots/home (dark mode).png" },
    ])
  })

  test("extracts Electron debug screenshot paths from structured output", () => {
    expect(toolImages(completed('{"filePath":"/project/screenshots/window.png"}'))).toEqual([
      { url: "/project/screenshots/window.png" },
    ])
    expect(toolImages(completed("", { screenshots: [{ path: "one.png" }, "two.png"] }))).toEqual([
      { url: "one.png" },
      { url: "two.png" },
    ])
  })

  test("extracts reported and bare screenshot paths without tool-name matching", () => {
    expect(toolImages(completed("Screenshot saved to /project/screen shot.png\nsecond.webp"))).toEqual([
      { url: "/project/screen shot.png" },
      { url: "second.webp" },
    ])
  })

  test("deduplicates paths and excludes non-images and unsupported schemes", () => {
    expect(
      toolImages(completed("`one.png`\n[image](one.png)\n[doc](notes.txt)\n[image](javascript:evil.png)")),
    ).toEqual([{ url: "one.png" }])
  })

  test("prefers returned image bytes to links to the same screenshot", () => {
    const state = completed("[Screenshot](screenshot.png)")
    if (state.status !== "completed") throw new Error("Expected completed tool")
    state.attachments = [
      {
        id: "file",
        sessionID: "session",
        messageID: "message",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAAA",
      },
      { id: "doc", sessionID: "session", messageID: "message", type: "file", mime: "text/plain", url: "notes.txt" },
    ]
    expect(toolImages(state)).toEqual([{ url: "data:image/png;base64,AAAA", name: undefined }])
  })

  test("does not infer previews for running or failed calls", () => {
    expect(toolImages({ status: "running", input: {}, metadata: { path: "one.png" }, time: { start: 1 } })).toEqual([])
    expect(toolImages({ status: "error", input: {}, error: "one.png", time: { start: 1, end: 2 } })).toEqual([])
  })
})

describe("toolImagePath", () => {
  test("resolves local file URIs and normalizes relative paths", () => {
    expect(toolImagePath("file:///project/screen%20shot.png", "/project")).toBe("screen shot.png")
    expect(toolImagePath("./screen%20shot.png", "/project")).toBe("screen shot.png")
    expect(toolImagePath("./screenshots/../screen.png", "/project")).toBe("screen.png")
    expect(toolImagePath("/project/screenshots/screen.png", "/project")).toBe("screenshots/screen.png")
  })

  test("handles Windows separators, drive letters and file URIs", () => {
    expect(toolImagePath("c:\\Project\\shots\\screen.png", "C:\\Project")).toBe("shots/screen.png")
    expect(toolImagePath("file:///C:/Project/screen%20shot.png", "C:\\Project")).toBe("screen shot.png")
  })

  test("keeps file reads within the location and rejects remote file hosts", () => {
    expect(toolImagePath("../screen.png", "/project")).toBeUndefined()
    expect(toolImagePath("/project-other/screen.png", "/project")).toBeUndefined()
    expect(toolImagePath("file:///project/%2e%2e/screen.png", "/project")).toBeUndefined()
    expect(toolImagePath("file://remote/project/screen.png", "/project")).toBeUndefined()
    expect(toolImagePath("https://example.com/screen.png", "/project")).toBeUndefined()
  })
})
