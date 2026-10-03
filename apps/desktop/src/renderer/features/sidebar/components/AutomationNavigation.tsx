import { cn } from "@expand/desktop/renderer/components/ui/class-names"

export interface AutomationNavigationProps {
  readonly activePage: AutomationPage
  readonly onSelectPage: (page: AutomationPage) => void
  readonly className?: string | undefined
}

export type AutomationPage = "overview" | "integrations" | "routine-setup" | "history"

export const AutomationNavigation = ({
  activePage,
  onSelectPage,
  className
}: AutomationNavigationProps) => (
  <nav aria-label="Automation pages" className={cn("flex min-w-0 flex-wrap gap-x-4 border-b", className)}>
    {automationPages.map(({ page, label }) => (
      <button
        key={page}
        type="button"
        aria-current={activePage === page ? "page" : undefined}
        data-active={activePage === page}
        onClick={() => onSelectPage(page)}
        className="min-h-10 border-b-2 border-transparent px-1 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-foreground data-[active=true]:border-primary data-[active=true]:font-medium data-[active=true]:text-foreground"
      >
        {label}
      </button>
    ))}
  </nav>
)

const automationPages: ReadonlyArray<{ readonly page: AutomationPage; readonly label: string }> = [
  { page: "overview", label: "Overview" },
  { page: "integrations", label: "Integrations" },
  { page: "routine-setup", label: "Routine setup" },
  { page: "history", label: "History" }
]
