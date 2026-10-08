import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

export const initializeTheme = () => applyTheme(readTheme())

export const ThemeProvider = ({ children }: { readonly children: ReactNode }) => {
  const [theme, setTheme] = useState(readTheme)

  useEffect(() => {
    applyTheme(theme)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {}
  }, [theme])

  const value = useMemo(() => ({ theme, setTheme }), [theme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useTheme = () => {
  const context = useContext(ThemeContext)
  if (context === null) throw new Error("useTheme must be used within a ThemeProvider.")
  return context
}

type Theme = "dark" | "light"

const THEME_STORAGE_KEY = "expand.theme"

const ThemeContext = createContext<{
  readonly theme: Theme
  readonly setTheme: (theme: Theme) => void
} | null>(null)

const readTheme = (): Theme => {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

const applyTheme = (theme: Theme) => {
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.style.colorScheme = theme
}
