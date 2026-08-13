import { createContext, type ReactNode, useContext } from "react"
import type { RendererRunner } from "@expand/desktop/renderer/app/runner"

export const RendererRunnerProvider = ({
  value,
  children
}: {
  readonly value: RendererRunner
  readonly children: ReactNode
}) => <RendererRunnerContext.Provider value={value}>{children}</RendererRunnerContext.Provider>

export const useRendererRunner = (): RendererRunner => {
  const value = useContext(RendererRunnerContext)
  if (value === null) {
    throw new Error("renderer runner must be used within <RendererRunnerProvider>")
  }
  return value
}

const RendererRunnerContext = createContext<RendererRunner | null>(null)
