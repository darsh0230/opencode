import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { OpenAIAccountsPaths, openAIAccountsHandler } from "../../src/server/routes/instance/httpapi/openai-accounts"
import { Auth } from "@/auth"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))
const usageIt = testEffect(LayerNode.compile(Auth.node))

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
      const withUsage = yield* request(`${OpenAIAccountsPaths.list}?usage=true`, tmp.directory)
      expect(withUsage.status).toBe(200)
      expect(yield* json(withUsage)).toEqual(body)
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

  usageIt.live("fetches per-account usage without exposing credentials or changing the active account", () =>
    Effect.gen(function* () {
      yield* seedAuth(
        Object.fromEntries(
          Object.entries(accounts).map(([key, value]) => [
            key,
            "expires" in value ? { ...value, expires: Date.now() + 60_000 } : value,
          ]),
        ),
      )
      const auth = yield* Auth.Service
      const before = yield* readAuth()
      const client = HttpClient.make((req) => {
        expect(req.url).toBe("https://chatgpt.com/backend-api/wham/usage")
        const id = req.headers["chatgpt-account-id"]
        expect(req.headers.authorization).toBe(
          id === "account-gmiscss" ? "Bearer SECRET-ACCESS-GMIS" : "Bearer SECRET-ACCESS-DIMENL",
        )
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            Response.json({
              plan_type: "plus",
              rate_limit: {
                primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
                secondary_window: { used_percent: 110, limit_window_seconds: 604_800, reset_after_seconds: 60 },
              },
              secret: "SECRET-PAYLOAD",
            }),
          ),
        )
      })
      const body = yield* openAIAccountsHandler(auth, client)({ query: { usage: true } })
      expect(body.map((account) => account.accountID)).toEqual(["account-gmiscss", "account-dimenl"])
      for (const account of body) {
        expect(account.usage?.planType).toBe("plus")
        expect(account.usage?.windows[0]).toEqual({ usedPercent: 25, windowMinutes: 300, resetAtMs: 2_000_000_000_000 })
        expect(account.usage?.windows[1]).toEqual({
          usedPercent: 100,
          windowMinutes: 10080,
          resetAtMs: account.usage!.fetchedAt + 60_000,
        })
      }
      expect(JSON.stringify(body)).not.toContain("SECRET")
      expect(yield* readAuth()).toEqual(before)
    }),
  )

  usageIt.live("keeps accounts selectable when usage is expired, invalid, or unavailable", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const unexpected = HttpClient.make(() => Effect.die("unexpected usage request"))
      yield* seedAuth(accounts)
      const expected = [
        { accountID: "account-gmiscss", email: "gmiscss@gmail.com", active: true },
        { accountID: "account-dimenl", email: "dimenl466@gmail.com", active: false },
      ]
      expect(yield* openAIAccountsHandler(auth, unexpected)({ query: { usage: true } })).toEqual(expected)
      yield* seedAuth(
        Object.fromEntries(
          Object.entries(accounts).map(([key, value]) => [
            key,
            "expires" in value ? { ...value, expires: Date.now() + 60_000 } : value,
          ]),
        ),
      )
      expect(yield* openAIAccountsHandler(auth, unexpected)({ query: {} })).toEqual(expected)
      const client = HttpClient.make((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            req.headers["chatgpt-account-id"] === "account-gmiscss"
              ? Response.json({ rate_limit: { primary_window: { used_percent: "invalid" } } })
              : new Response(null, { status: 401 }),
          ),
        ),
      )
      expect(yield* openAIAccountsHandler(auth, client)({ query: { usage: true } })).toEqual(expected)
    }),
  )
})
