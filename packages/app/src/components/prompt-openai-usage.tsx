import { Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Popover } from "@kobalte/core/popover"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { createMediaQuery } from "@solid-primitives/media"
import { useLanguage } from "@/context/language"
import { useOpenAIAccounts } from "@/hooks/use-openai-accounts"
import { DialogSelectOpenAIAccount } from "./dialog-select-openai-account"
import { OpenAIAccountUsage } from "./openai-account-usage"

export function PromptOpenAIUsage(props: { providerID?: string }) {
  return (
    <Show when={props.providerID === "openai"}>
      <ActiveAccountUsage />
    </Show>
  )
}

function ActiveAccountUsage() {
  const accounts = useOpenAIAccounts()
  const language = useLanguage()
  const dialog = useDialog()
  const mobile = createMediaQuery("(max-width: 767px)")
  const active = () => accounts.accounts.data?.find((account) => account.active)

  return (
    <Show when={active()}>
      {(account) => (
        <Show
          when={!mobile()}
          fallback={
            <Popover placement="top-end" gutter={8}>
              <Popover.Trigger
                type="button"
                data-action="prompt-openai-usage"
                aria-label={language.t("prompt.openai.usage.view")}
                class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-weaker hover:bg-surface-base-hover focus-visible:outline-2 focus-visible:outline-border-strong-base"
              >
                <ProgressCircle
                  size={16}
                  strokeWidth={2}
                  percentage={Math.max(
                    0,
                    Math.min(
                      100,
                      ...(accounts.forAccount(account().accountID)?.windows ?? []).map(
                        (window) => 100 - window.usedPercent,
                      ),
                    ),
                  )}
                />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  aria-label={language.t("prompt.openai.usage.view")}
                  class="z-50 rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-2.5 shadow-md focus:outline-none"
                >
                  <Show
                    when={accounts.forAccount(account().accountID)}
                    fallback={
                      <span class="text-11-regular text-text-weaker">
                        {language.t(
                          accounts.usage.isPending ? "common.loading" : "dialog.openai.accounts.usage.unavailable",
                        )}
                      </span>
                    }
                  >
                    {(usage) => <OpenAIAccountUsage usage={usage()} details />}
                  </Show>
                </Popover.Content>
              </Popover.Portal>
            </Popover>
          }
        >
          <Tooltip
            placement="top"
            value={
              <div class="flex flex-col gap-1">
                <span>{account().email ?? account().label ?? account().accountID}</span>
                <Show when={accounts.forAccount(account().accountID)?.planType}>
                  {(plan) => <span class="capitalize">{plan()}</span>}
                </Show>
                <span>{language.t("prompt.openai.usage.open")}</span>
              </div>
            }
          >
            <button
              type="button"
              data-action="prompt-openai-usage"
              aria-label={language.t("prompt.openai.usage.open")}
              class="inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-11-regular text-text-weaker transition-colors hover:bg-surface-base-hover focus-visible:outline-2 focus-visible:outline-border-strong-base"
              onClick={() => dialog.show(() => <DialogSelectOpenAIAccount />)}
            >
              <span>{language.t("prompt.openai.usage.label")}</span>
              <Show
                when={accounts.forAccount(account().accountID)}
                fallback={
                  <span>
                    {language.t(
                      accounts.usage.isPending ? "common.loading" : "dialog.openai.accounts.usage.unavailable",
                    )}
                  </span>
                }
              >
                {(usage) => <OpenAIAccountUsage usage={usage()} compact />}
              </Show>
            </button>
          </Tooltip>
        </Show>
      )}
    </Show>
  )
}
