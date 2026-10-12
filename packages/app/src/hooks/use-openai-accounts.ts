import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import type { OpenAiAccount } from "@opencode-ai/sdk/v2"

export function useOpenAIAccounts() {
  const sdk = useSDK()
  const server = useServerSDK()
  const client = useQueryClient()
  const key = () => ["openai-accounts", server().url, sdk().directory]
  const accounts = createQuery(() => ({
    queryKey: [...key(), "list"],
    queryFn: async ({ signal }) =>
      (await sdk().client.experimental.openaiAccounts.list({}, { throwOnError: true, signal })).data ?? [],
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  }))
  const usage = createQuery(() => ({
    queryKey: [...key(), "usage"],
    queryFn: async ({ signal }) =>
      (await sdk().client.experimental.openaiAccounts.list({ usage: "true" }, { throwOnError: true, signal })).data ??
      [],
    enabled: !!accounts.data?.length,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  }))

  return {
    accounts,
    usage,
    forAccount: (id: string) => usage.data?.find((account) => account.accountID === id)?.usage,
    refresh: () => {
      void client.invalidateQueries({ queryKey: key() })
    },
    async activate(accountID: string) {
      const current = key()
      await sdk().client.experimental.openaiAccounts.activate({ accountID }, { throwOnError: true })
      client.setQueryData<OpenAiAccount[]>([...current, "list"], (accounts) =>
        accounts?.map((account) => ({ ...account, active: account.accountID === accountID })),
      )
      void client.invalidateQueries({ queryKey: current })
    },
  }
}
