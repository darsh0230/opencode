import { Component, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import type { OpenAiAccount } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

export const DialogSelectOpenAIAccount: Component = () => {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()

  const [store, setStore] = createStore<{
    accounts: OpenAiAccount[] | undefined
    failed: boolean
    switching: string | undefined
  }>({
    accounts: undefined,
    failed: false,
    switching: undefined,
  })

  sdk()
    .client.experimental.openaiAccounts.list({}, { throwOnError: true })
    .then((res) => setStore("accounts", res.data ?? []))
    .catch(() => setStore("failed", true))

  const display = (account: OpenAiAccount) => account.email ?? account.label ?? account.accountID

  const select = async (account: OpenAiAccount | undefined) => {
    if (!account || store.switching) return
    if (account.active) {
      dialog.close()
      return
    }

    setStore("switching", account.accountID)
    await sdk()
      .client.experimental.openaiAccounts.activate({ accountID: account.accountID }, { throwOnError: true })
      .then(() => {
        showToast({
          variant: "success",
          title: language.t("toast.openai.accounts.switched.title", { label: display(account) }),
        })
        dialog.close()
      })
      .catch(() => {
        showToast({ variant: "error", title: language.t("toast.openai.accounts.switch.failed.title") })
        setStore("switching", undefined)
      })
  }

  return (
    <Dialog title={language.t("dialog.openai.accounts.title")}>
      <Show
        when={!store.failed}
        fallback={<div class="px-3 py-2 text-text-weaker">{language.t("dialog.openai.accounts.loadFailed")}</div>}
      >
        <Show
          when={store.accounts}
          fallback={<div class="px-3 py-2 text-text-weaker">{language.t("common.loading")}</div>}
        >
          <List
            class="px-3"
            search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
            emptyMessage={language.t("dialog.openai.accounts.empty")}
            key={(x) => x.accountID}
            filterKeys={["email", "label"]}
            items={() => store.accounts ?? []}
            onSelect={(x) => void select(x)}
          >
            {(i) => (
              <div class="w-full flex items-center justify-between gap-x-3">
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="truncate">{display(i)}</span>
                  <Show when={i.email && i.label}>
                    <span class="text-11-regular text-text-weaker truncate">{i.label}</span>
                  </Show>
                </div>
                <Show when={i.active}>
                  <span class="text-11-regular text-text-weaker">
                    {language.t("dialog.openai.accounts.status.active")}
                  </span>
                </Show>
              </div>
            )}
          </List>
        </Show>
      </Show>
    </Dialog>
  )
}
