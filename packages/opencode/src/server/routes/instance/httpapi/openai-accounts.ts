import { Auth } from "@/auth"
import { Effect, Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, OpenApi } from "effect/unstable/httpapi"
import { described } from "./groups/metadata"
import { WorkspaceRoutingQuery } from "./middleware/workspace-routing"

// Per-account OpenAI OAuth entries are written by the Codex multi-account
// plugin under "openai/<label>" (legacy: "OpenAI (<label>)") auth keys. The
// canonical "openai" entry mirrors the active account.
export const OpenAIAccountsPaths = {
  list: "/experimental/openai/accounts",
  activate: "/experimental/openai/accounts/activate",
} as const

const OpenAIAccount = Schema.Struct({
  accountID: Schema.String,
  label: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  active: Schema.Boolean,
}).annotate({ identifier: "OpenAIAccount" })

const OpenAIAccountList = Schema.Array(OpenAIAccount).annotate({ identifier: "OpenAIAccountList" })

export const OpenAIAccountActivatePayload = Schema.Struct({
  accountID: Schema.String,
})

export const openAIAccountsEndpoint = HttpApiEndpoint.get("openaiAccounts", OpenAIAccountsPaths.list, {
  query: WorkspaceRoutingQuery,
  success: described(OpenAIAccountList, "OpenAI OAuth accounts"),
  error: HttpApiError.InternalServerError,
}).annotateMerge(
  OpenApi.annotations({
    identifier: "experimental.openaiAccounts.list",
    summary: "List OpenAI OAuth accounts",
    description:
      "List the OpenAI OAuth accounts stored as per-account auth entries in multi-account setups. Returns sanitized account metadata only; OAuth tokens are never exposed.",
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

function sortedOpenAIAccounts(all: Record<string, Auth.Info>) {
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

export function openAIAccountsHandler(auth: Auth.Interface) {
  return Effect.fn("ExperimentalHttpApi.openaiAccounts")(function* () {
    const all = yield* auth.all().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))))
    return sortedOpenAIAccounts(all)
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
