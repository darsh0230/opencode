import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { OpenAIAccountsPaths } from "../../src/server/routes/instance/httpapi/openai-accounts"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

describe("experimental OpenAI account endpoints", () => {
  const file = path.join(Global.Path.data, "auth.json")

  const accounts = {
    "openai/dimenl466@gmail.com": {
      type: "oauth",
      access: "SECRET-ACCESS-DIMENL",
      refresh: "SECRET-REFRESH-DIMENL",
      expires: 100,
      accountId: "account-dimenl",
    },
    "openai/gmiscss@gmail.com": {
      type: "oauth",
      access: "SECRET-ACCESS-GMIS",
      refresh: "SECRET-REFRESH-GMIS",
      expires: 100,
      accountId: "account-gmiscss",
    },
    openai: {
      type: "oauth",
      access: "SECRET-ACCESS-GMIS",
      refresh: "SECRET-REFRESH-GMIS",
      expires: 100,
      accountId: "account-gmiscss",
    },
    anthropic: { type: "api", key: "SECRET-ANTHROPIC-KEY" },
  }

  function seedAuth(entries: Record<string, unknown>) {
    return Effect.promise(() => Bun.write(file, JSON.stringify(entries)))
  }

  function readAuth() {
    return Effect.promise(async () => (await Bun.file(file).json()) as Record<string, Record<string, unknown>>)
  }

  it.instance("lists sanitized accounts with the active account first", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      yield* seedAuth(accounts)

      const response = yield* request(OpenAIAccountsPaths.list, tmp.directory)
      expect(response.status).toBe(200)

      const body = yield* json<unknown[]>(response)
      expect(body).toEqual([
        { accountID: "account-gmiscss", email: "gmiscss@gmail.com", active: true },
        { accountID: "account-dimenl", email: "dimenl466@gmail.com", active: false },
      ])
      expect(JSON.stringify(body)).not.toContain("SECRET")
    }),
  )

  it.instance("returns an empty list when no per-account entries exist", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      yield* seedAuth({
        openai: { type: "oauth", access: "SECRET-ACCESS-SOLO", refresh: "SECRET-REFRESH-SOLO", expires: 100 },
        anthropic: { type: "api", key: "SECRET-ANTHROPIC-KEY" },
      })

      const response = yield* request(OpenAIAccountsPaths.list, tmp.directory)
      expect(response.status).toBe(200)
      expect(yield* json(response)).toEqual([])
    }),
  )

  it.instance("activates an account by copying it into the canonical entry", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      yield* seedAuth(accounts)

      const response = yield* request(OpenAIAccountsPaths.activate, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountID: "account-dimenl" }),
      })
      expect(response.status).toBe(200)
      expect(yield* json(response)).toEqual({
        accountID: "account-dimenl",
        email: "dimenl466@gmail.com",
        active: true,
      })

      // The selected credential replaces the canonical "openai" entry while
      // per-account and unrelated provider entries are preserved.
      const written = yield* readAuth()
      expect(written["openai"]).toMatchObject({
        type: "oauth",
        access: "SECRET-ACCESS-DIMENL",
        refresh: "SECRET-REFRESH-DIMENL",
        accountId: "account-dimenl",
      })
      expect(written["openai/dimenl466@gmail.com"]).toMatchObject({ accountId: "account-dimenl" })
      expect(written["openai/gmiscss@gmail.com"]).toMatchObject({ accountId: "account-gmiscss" })
      expect(written["anthropic"]).toEqual({ type: "api", key: "SECRET-ANTHROPIC-KEY" })

      const after = yield* request(OpenAIAccountsPaths.list, tmp.directory)
      expect(yield* json<unknown[]>(after)).toEqual([
        { accountID: "account-dimenl", email: "dimenl466@gmail.com", active: true },
        { accountID: "account-gmiscss", email: "gmiscss@gmail.com", active: false },
      ])
    }),
  )

  it.instance("returns 404 when activating an unknown account", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      yield* seedAuth(accounts)

      const response = yield* request(OpenAIAccountsPaths.activate, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountID: "missing" }),
      })
      expect(response.status).toBe(404)
    }),
  )
})
