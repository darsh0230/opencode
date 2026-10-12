import { Auth } from "@/auth"
import { Clock, Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { HttpApiEndpoint, HttpApiError, OpenApi } from "effect/unstable/httpapi"
import { described } from "./groups/metadata"
import { WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "./middleware/workspace-routing"
import { QueryBoolean } from "./groups/query"

// Per-account OpenAI OAuth entries are written by the Codex multi-account
// plugin under "openai/<label>" (legacy: "OpenAI (<label>)") auth keys. The
// canonical "openai" entry mirrors the active account.
export const OpenAIAccountsPaths = {
  list: "/experimental/openai/accounts",
  activate: "/experimental/openai/accounts/activate",
} as const

const OpenAIAccountUsage = Schema.Struct({
  fetchedAt: Schema.Finite,
  planType: Schema.optionalKey(Schema.String),
  windows: Schema.Array(
    Schema.Struct({
      windowMinutes: Schema.Finite,
      usedPercent: Schema.Finite,
      resetAtMs: Schema.Finite,
    }),
  ),
}).annotate({ identifier: "OpenAIAccountUsage" })

const UsageWindow = Schema.Struct({
  used_percent: Schema.optionalKey(Schema.Number),
  limit_window_seconds: Schema.optionalKey(Schema.Number),
  reset_at: Schema.optionalKey(Schema.Number),
  reset_after_seconds: Schema.optionalKey(Schema.Number),
})
const UsagePayload = Schema.Struct({
  plan_type: Schema.optionalKey(Schema.String),
  rate_limit: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        primary_window: Schema.optionalKey(Schema.NullOr(UsageWindow)),
        secondary_window: Schema.optionalKey(Schema.NullOr(UsageWindow)),
      }),
    ),
  ),
})

export const OpenAIAccountsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  usage: Schema.optionalKey(QueryBoolean),
})

const OpenAIAccount = Schema.Struct({
  accountID: Schema.String,
  label: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  active: Schema.Boolean,
  usage: Schema.optionalKey(OpenAIAccountUsage),
}).annotate({ identifier: "OpenAIAccount" })

const OpenAIAccountList = Schema.Array(OpenAIAccount).annotate({ identifier: "OpenAIAccountList" })

export const OpenAIAccountActivatePayload = Schema.Struct({
  accountID: Schema.String,
})

export const openAIAccountsEndpoint = HttpApiEndpoint.get("openaiAccounts", OpenAIAccountsPaths.list, {
  query: OpenAIAccountsQuery,
  success: described(OpenAIAccountList, "OpenAI OAuth accounts"),
  error: HttpApiError.InternalServerError,
}).annotateMerge(
  OpenApi.annotations({
    identifier: "experimental.openaiAccounts.list",
    summary: "List OpenAI OAuth accounts",
    description:
      "List the OpenAI OAuth accounts stored as per-account auth entries in multi-account setups. Set usage=true to fetch current Codex quota windows and plan information. OAuth tokens are never exposed; unavailable usage is omitted.",
  }),
)

export const openAIAccountsActivateEndpoint = HttpApiEndpoint.post(
  "openaiAccountsActivate",
  OpenAIAccountsPaths.activate,
  {
    query: WorkspaceRoutingQuery,
    payload: OpenAIAccountActivatePayload,
    success: described(OpenAIAccount, "Newly active OpenAI account"),
    error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
  },
).annotateMerge(
  OpenApi.annotations({
    identifier: "experimental.openaiAccounts.activate",
    summary: "Activate an OpenAI OAuth account",
    description:
      'Copy the selected per-account OpenAI OAuth credential into the canonical "openai" auth entry so subsequent OpenAI requests use the chosen account.',
  }),
)

function openAIAccountLabel(key: string) {
  if (key.startsWith("openai/")) return key.slice("openai/".length)
  if (key.startsWith("OpenAI (") && key.endsWith(")")) return key.slice("OpenAI (".length, -1)
  return undefined
}

function openAIAccounts(all: Record<string, Auth.Info>) {
  const byID = new Map<string, { id: string; entry: Auth.Oauth; email?: string; label?: string }>()
  for (const [key, info] of Object.entries(all)) {
    const label = openAIAccountLabel(key)
    // Entries without an accountId predate the multi-account format; they are
    // upgraded on plugin sync, so skip them until they carry a stable id.
    if (label === undefined || info.type !== "oauth" || !info.accountId) continue
    // Prefer modern "openai/<label>" entries over legacy duplicates.
    if (byID.has(info.accountId) && !key.startsWith("openai/")) continue
    const email = label.includes("@") ? label : undefined
    byID.set(info.accountId, { id: info.accountId, entry: info, email, label: email ? undefined : label })
  }
  return byID
}

function activeOpenAIAccountID(
  all: Record<string, Auth.Info>,
  accounts: Map<string, { id: string; entry: Auth.Oauth }>,
) {
  const canonical = all["openai"]
  if (!canonical || canonical.type !== "oauth") return undefined
  if (canonical.accountId) return canonical.accountId
  // Legacy canonical entries predate accountId; fall back to token equality.
  return [...accounts.values()].find(
    (account) => account.entry.access === canonical.access && account.entry.refresh === canonical.refresh,
  )?.id
}

function sanitizeOpenAIAccount(record: { id: string; email?: string; label?: string }, activeID: string | undefined) {
  return {
    accountID: record.id,
    ...(record.email ? { email: record.email } : {}),
    ...(record.label ? { label: record.label } : {}),
    active: record.id === activeID,
  }
}

function sortedOpenAIAccounts(all: Record<string, Auth.Info>): (typeof OpenAIAccount.Type)[] {
  const accounts = openAIAccounts(all)
  const activeID = activeOpenAIAccountID(all, accounts)
  return [...accounts.values()]
    .sort((a, b) => {
      if (a.id === activeID) return -1
      if (b.id === activeID) return 1
      return (a.email ?? a.label ?? a.id).localeCompare(b.email ?? b.label ?? b.id)
    })
    .map((record) => sanitizeOpenAIAccount(record, activeID))
}

export function openAIAccountsHandler(auth: Auth.Interface, http: HttpClient.HttpClient) {
  return Effect.fn("ExperimentalHttpApi.openaiAccounts")(function* (ctx: { query: typeof OpenAIAccountsQuery.Type }) {
    const all = yield* auth.all().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))))
    const accounts = sortedOpenAIAccounts(all)
    if (!ctx.query.usage) return accounts
    const records = openAIAccounts(all)
    return yield* Effect.forEach(
      accounts,
      (account) =>
        Effect.gen(function* () {
          const record = records.get(account.accountID)!
          const now = yield* Clock.currentTimeMillis
          if (record.entry.expires <= now) return account
          const usage = yield* HttpClient.filterStatusOk(http)
            .get("https://chatgpt.com/backend-api/wham/usage", {
              headers: {
                authorization: `Bearer ${record.entry.access}`,
                "ChatGPT-Account-Id": record.id,
                "User-Agent": "opencode-codex/0.1",
                accept: "application/json",
              },
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(UsagePayload)),
              Effect.map((payload) => {
                const windows = [payload.rate_limit?.primary_window, payload.rate_limit?.secondary_window]
                  .flatMap((window) => {
                    if (
                      !window ||
                      !Number.isFinite(window.used_percent) ||
                      !Number.isFinite(window.limit_window_seconds)
                    )
                      return []
                    if (
                      window.used_percent === undefined ||
                      window.limit_window_seconds === undefined ||
                      window.limit_window_seconds <= 0
                    )
                      return []
                    const resetAtMs =
                      window.reset_at && Number.isFinite(window.reset_at) && window.reset_at > 0
                        ? window.reset_at > 1e12
                          ? window.reset_at
                          : window.reset_at * 1000
                        : window.reset_after_seconds &&
                            Number.isFinite(window.reset_after_seconds) &&
                            window.reset_after_seconds > 0
                          ? now + window.reset_after_seconds * 1000
                          : undefined
                    if (resetAtMs === undefined) return []
                    return [
                      {
                        usedPercent: Math.max(0, Math.min(100, window.used_percent)),
                        windowMinutes: Math.round(window.limit_window_seconds / 60),
                        resetAtMs,
                      },
                    ]
                  })
                  .sort((a, b) => a.windowMinutes - b.windowMinutes)
                if (!windows.length) return undefined
                return { fetchedAt: now, ...(payload.plan_type ? { planType: payload.plan_type } : {}), windows }
              }),
              Effect.timeout("10 seconds"),
              Effect.catch(() => Effect.succeed(undefined)),
            )
          return usage ? { ...account, usage } : account
        }),
      { concurrency: 4 },
    )
  })
}

export function openAIAccountsActivateHandler(auth: Auth.Interface) {
  return Effect.fn("ExperimentalHttpApi.openaiAccountsActivate")(function* (ctx: {
    payload: typeof OpenAIAccountActivatePayload.Type
  }) {
    const all = yield* auth.all().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))))
    const record = openAIAccounts(all).get(ctx.payload.accountID)
    if (!record) return yield* new HttpApiError.NotFound({})
    yield* auth
      .set("openai", record.entry)
      .pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))))
    return sanitizeOpenAIAccount(record, record.id)
  })
}
