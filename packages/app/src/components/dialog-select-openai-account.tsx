import { Component, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Button } from "@opencode-ai/ui/button"
import type { OpenAiAccount } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useOpenAIAccounts } from "@/hooks/use-openai-accounts"
import { showToast } from "@/utils/toast"
import { OpenAIAccountUsage } from "./openai-account-usage"

export const DialogSelectOpenAIAccount: Component = () => {
  const accounts = useOpenAIAccounts()
  const dialog = useDialog()
  const language = useLanguage()
  const [store, setStore] = createStore({ switching: undefined as string | undefined })
  const display = (account: OpenAiAccount) => account.email ?? account.label ?? account.accountID

  const select = async (account: OpenAiAccount | undefined) => {
    if (!account || store.switching) return
    if (account.active) {
      dialog.close()
      return
    }
    setStore("switching", account.accountID)
    await accounts
      .activate(account.accountID)
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
        when={!accounts.accounts.isError}
        fallback={<div class="px-3 py-2 text-text-weaker">{language.t("dialog.openai.accounts.loadFailed")}</div>}
      >
        <Show
          when={accounts.accounts.data}
          fallback={<div class="px-3 py-2 text-text-weaker">{language.t("common.loading")}</div>}
        >
          <List
            class="px-3"
            search={{
              placeholder: language.t("common.search.placeholder"),
              autofocus: true,
              action: (
                <Show when={accounts.accounts.data?.length}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    disabled={accounts.usage.isFetching}
                    onClick={accounts.refresh}
                  >
                    {language.t(accounts.usage.isFetching ? "common.loading" : "dialog.openai.accounts.usage.refresh")}
                  </Button>
                </Show>
              ),
            }}
            emptyMessage={language.t("dialog.openai.accounts.empty")}
            key={(account) => account.accountID}
            filterKeys={["email", "label"]}
            items={() => accounts.accounts.data ?? []}
            onSelect={(account) => void select(account)}
          >
            {(account) => (
              <div class="flex w-full min-w-0 flex-col gap-1 py-0.5">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="min-w-0 flex-1 truncate text-start">{display(account)}</span>
                  <Show when={accounts.forAccount(account.accountID)?.planType}>
                    {(plan) => <span class="shrink-0 text-11-regular text-text-weaker capitalize">{plan()}</span>}
                  </Show>
                  <Show when={account.active}>
                    <span class="shrink-0 rounded bg-surface-base-active px-1.5 text-11-regular text-text-weak">
                      {language.t("dialog.openai.accounts.status.active")}
                    </span>
                  </Show>
                  <Show when={store.switching === account.accountID}>
                    <span class="text-11-regular text-text-weaker">{language.t("common.loading")}</span>
                  </Show>
                </div>
                <Show
                  when={accounts.forAccount(account.accountID)}
                  fallback={
                    <span class="text-11-regular text-text-weaker">
                      {language.t(
                        accounts.usage.isPending ? "common.loading" : "dialog.openai.accounts.usage.unavailable",
                      )}
                    </span>
                  }
                >
                  {(usage) => <OpenAIAccountUsage usage={usage()} />}
                </Show>
              </div>
            )}
          </List>
        </Show>
      </Show>
    </Dialog>
  )
}
