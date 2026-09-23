import { Fragment, useState } from "react"
import { CheckIcon, ChevronDownIcon, StarIcon } from "lucide-react"
import { Command } from "cmdk"
import { cn } from "@expand/desktop/renderer/components/ui/class-names"
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from "@expand/desktop/renderer/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@expand/desktop/renderer/components/ui/popover"
import type { PromptModelOption } from "@expand/desktop/renderer/features/chat/components/PromptInput"
import { ProviderLogo } from "@expand/desktop/renderer/features/chat/components/provider-logos"

export interface ModelPickerProps {
  readonly models: ReadonlyArray<PromptModelOption>
  readonly selectedModelId: string
  readonly onModelChange: (modelId: string) => void
  readonly favoriteModelIds: ReadonlyArray<string>
  readonly onFavoritesChange: (modelIds: ReadonlyArray<string>) => void
  readonly disabled?: boolean
}

export const ModelPicker = ({
  models,
  selectedModelId,
  onModelChange,
  favoriteModelIds,
  onFavoritesChange,
  disabled = false
}: ModelPickerProps) => {
  const [open, setOpen] = useState(false)
  const selected = models.find((model) => model.id === selectedModelId)
  const favorites = new Set(favoriteModelIds)

  const toggleFavorite = (modelId: string) => {
    onFavoritesChange(
      favorites.has(modelId)
        ? favoriteModelIds.filter((id) => id !== modelId)
        : [...favoriteModelIds, modelId]
    )
  }

  const providers = [...new Set(models.map((model) => model.provider))].sort((a, b) => {
    const favoriteOrder =
      Number(models.some((model) => model.provider === b && favorites.has(model.id))) -
      Number(models.some((model) => model.provider === a && favorites.has(model.id)))
    if (favoriteOrder !== 0) return favoriteOrder
    return a.localeCompare(b)
  })

  const grouped = new Map<string, ReadonlyArray<PromptModelOption>>()
  for (const provider of providers) {
    grouped.set(
      provider,
      models
        .filter((model) => model.provider === provider)
        .sort((a, b) => {
          const favoriteOrder = Number(favorites.has(b.id)) - Number(favorites.has(a.id))
          if (favoriteOrder !== 0) return favoriteOrder
          return a.label.localeCompare(b.label)
        })
    )
  }

  const choose = (modelId: string) => {
    onModelChange(modelId)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={selected === undefined ? "Choose model" : `Model: ${selected.label}`}
        disabled={disabled}
        className="border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-ring flex h-9 min-w-0 max-w-48 flex-1 items-center gap-1 rounded-md border px-3 text-sm outline-none focus-visible:outline-2 disabled:opacity-50 sm:max-w-56 sm:flex-none"
      >
        {selected !== undefined && favorites.has(selected.id) && (
          <StarIcon className="size-3.5 shrink-0 fill-current" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">
          {selected === undefined ? "Choose model" : selected.label}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 overflow-hidden rounded-xl p-0">
        <Command
          label="Search models"
          className="flex h-full w-full flex-col overflow-hidden rounded-md"
        >
          <CommandInput placeholder="Search models…" />
          <CommandList>
            <CommandEmpty>No models match.</CommandEmpty>
            {providers.map((provider, index) => (
              <Fragment key={provider}>
                {index > 0 && <CommandSeparator />}
                <CommandGroup
                  heading={
                    <span className="flex items-center gap-2 px-1 py-1">
                      <ProviderLogo provider={provider} className="size-4 shrink-0" />
                      {provider}
                    </span>
                  }
                >
                {(grouped.get(provider) ?? []).map((model) => {
                  const isFavorite = favorites.has(model.id)
                  return (
                    <CommandItem
                      key={model.id}
                      value={`${model.label} ${model.provider} ${model.description ?? ""}`}
                      {...(model.disabled === true ? { disabled: true } : null)}
                      onSelect={() => choose(model.id)}
                    >
                      {selectedModelId === model.id ? (
                        <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
                      ) : (
                        <span className="size-4 shrink-0" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{model.label}</span>
                        {model.description !== undefined && (
                          <span className="text-muted-foreground block truncate text-xs">
                            {model.description}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        aria-label={isFavorite ? `Unfavorite ${model.label}` : `Favorite ${model.label}`}
                        aria-pressed={isFavorite}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleFavorite(model.id)
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                        className="text-muted-foreground hover:text-foreground focus-visible:outline-ring flex size-6 shrink-0 items-center justify-center rounded outline-none focus-visible:outline-2"
                      >
                        <StarIcon
                          className={cn("size-3.5", isFavorite && "fill-current")}
                          aria-hidden="true"
                        />
                      </button>
                    </CommandItem>
                  )
                })}
                </CommandGroup>
              </Fragment>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
