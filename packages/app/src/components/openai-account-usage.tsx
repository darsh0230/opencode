import { For, Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { OpenAiAccountUsage } from "@opencode-ai/sdk/v2"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"

export function OpenAIAccountUsage(props: { usage: OpenAiAccountUsage; compact?: boolean; details?: boolean }) {
  const language = useLanguage()
  const [clock, setClock] = createStore({ now: Date.now() })
  createEffect(() => {
    const interval = setInterval(() => setClock("now", Date.now()), 30_000)
    onCleanup(() => clearInterval(interval))
  })
  const label = (minutes: number) =>
    new Intl.NumberFormat(language.intl(), {
      style: "unit",
      unit: minutes >= 1440 ? "day" : minutes >= 60 ? "hour" : "minute",
      unitDisplay: "narrow",
      maximumFractionDigits: 1,
    }).format(minutes >= 1440 ? minutes / 1440 : minutes >= 60 ? minutes / 60 : minutes)
  const remaining = (used: number) => Math.round(Math.max(0, Math.min(100, 100 - used)))
  const percent = (used: number) =>
    new Intl.NumberFormat(language.intl(), { style: "percent" }).format(remaining(used) / 100)
  const resets = (time: number) => {
    const minutes = Math.max(0, Math.floor((time - clock.now) / 60_000))
    const unit = minutes >= 1440 ? "day" : minutes >= 60 ? "hour" : "minute"
    const value = Math.floor(minutes >= 1440 ? minutes / 1440 : minutes >= 60 ? minutes / 60 : minutes)
    return language.t("dialog.openai.accounts.usage.countdown", {
      time: new Intl.NumberFormat(language.intl(), {
        style: "unit",
        unit,
        unitDisplay: "narrow",
        maximumFractionDigits: 0,
      }).format(value),
    })
  }

  return (
    <div
      class="flex tabular-nums"
      classList={{
        "flex-wrap items-center gap-x-3 gap-y-1 text-11-regular": !props.details,
        "flex-col gap-1.5 text-[12px] leading-4": props.details,
      }}
      data-component="openai-account-usage"
    >
      <For each={props.usage.windows}>
        {(window) => (
          <Show
            when={props.details}
            fallback={
              <Tooltip
                placement="top"
                value={
                  <div class="flex flex-col gap-1">
                    <span>
                      {language.t("dialog.openai.accounts.usage.meter", { window: label(window.windowMinutes) })}
                    </span>
                    <span>
                      {language.t("dialog.openai.accounts.usage.remaining", { percent: percent(window.usedPercent) })}
                    </span>
                    <span>{resets(window.resetAtMs)}</span>
                    <span>
                      {language.t("dialog.openai.accounts.usage.resets", {
                        time: new Intl.DateTimeFormat(language.intl(), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(window.resetAtMs),
                      })}
                    </span>
                  </div>
                }
              >
                <span
                  class="inline-flex items-center gap-1.5 whitespace-nowrap"
                  aria-label={language.t("dialog.openai.accounts.usage.summaryWithReset", {
                    window: label(window.windowMinutes),
                    percent: percent(window.usedPercent),
                    reset: resets(window.resetAtMs),
                  })}
                >
                  <span class="text-text-weaker">{label(window.windowMinutes)}</span>
                  <Show when={!props.compact}>
                    <span
                      aria-hidden="true"
                      class="hidden sm:inline h-1 w-10 overflow-hidden rounded-full bg-surface-base-active"
                    >
                      <span
                        class="block h-full rounded-full"
                        classList={{
                          "bg-icon-success-base": remaining(window.usedPercent) > 20,
                          "bg-icon-warning-base":
                            remaining(window.usedPercent) > 0 && remaining(window.usedPercent) <= 20,
                          "bg-icon-critical-base": remaining(window.usedPercent) === 0,
                        }}
                        style={{ width: `${remaining(window.usedPercent)}%` }}
                      />
                    </span>
                  </Show>
                  <span
                    class="font-medium"
                    classList={{
                      "text-text-weak": remaining(window.usedPercent) > 20,
                      "text-icon-warning-base":
                        remaining(window.usedPercent) > 0 && remaining(window.usedPercent) <= 20,
                      "text-icon-critical-base": remaining(window.usedPercent) === 0,
                    }}
                  >
                    {percent(window.usedPercent)}
                  </span>
                  <span class="text-[11px] leading-4 text-text-weaker">{resets(window.resetAtMs)}</span>
                </span>
              </Tooltip>
            }
          >
            <div class="grid grid-cols-[auto_auto_1fr] items-center gap-x-3 whitespace-nowrap">
              <span class="text-text-weaker">{label(window.windowMinutes)}</span>
              <span
                class="font-medium"
                classList={{
                  "text-text-weak": remaining(window.usedPercent) > 20,
                  "text-icon-warning-base": remaining(window.usedPercent) > 0 && remaining(window.usedPercent) <= 20,
                  "text-icon-critical-base": remaining(window.usedPercent) === 0,
                }}
                aria-label={language.t("dialog.openai.accounts.usage.remaining", {
                  percent: percent(window.usedPercent),
                })}
              >
                {percent(window.usedPercent)}
              </span>
              <span class="text-text-weaker text-end">{resets(window.resetAtMs)}</span>
            </div>
          </Show>
        )}
      </For>
    </div>
  )
}
