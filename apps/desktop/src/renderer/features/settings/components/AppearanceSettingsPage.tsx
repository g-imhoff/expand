import { useTheme } from "@expand/desktop/renderer/app/theme"
import { Label } from "@expand/desktop/renderer/components/ui/label"
import { Switch } from "@expand/desktop/renderer/components/ui/switch"

export const AppearanceSettingsPage = () => {
  const { theme, setTheme } = useTheme()

  return (
    <section aria-labelledby="appearance-settings-heading">
      <h1 id="appearance-settings-heading" className="text-xl font-semibold">Appearance</h1>
      <div className="mt-6 flex items-center justify-between gap-6 rounded-lg border bg-card p-4">
        <div>
          <Label htmlFor="dark-mode">Dark mode</Label>
          <p id="dark-mode-description" className="mt-1 text-sm text-muted-foreground">Use a dark background across the app.</p>
        </div>
        <Switch
          id="dark-mode"
          aria-describedby="dark-mode-description"
          checked={theme === "dark"}
          onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
        />
      </div>
    </section>
  )
}
