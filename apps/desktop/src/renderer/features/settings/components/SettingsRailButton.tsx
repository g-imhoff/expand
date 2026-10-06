import { Settings } from "lucide-react"

export interface SettingsRailButtonProps {
  readonly active: boolean
  readonly onOpen: () => void
}

export const SettingsRailButton = ({ active, onOpen }: SettingsRailButtonProps) => (
  <button
    type="button"
    aria-label="Settings"
    aria-current={active ? "page" : undefined}
    data-active={active}
    onClick={onOpen}
    className="flex size-8 items-center justify-center rounded-md text-sidebar-foreground ring-sidebar-ring outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0"
  >
    <Settings aria-hidden="true" />
  </button>
)
