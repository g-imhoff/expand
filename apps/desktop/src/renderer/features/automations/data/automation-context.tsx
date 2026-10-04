import { createContext, type ReactNode, useContext } from "react"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"

export const AutomationContextProvider = ({
  value,
  children
}: {
  readonly value: AutomationRpcApi | null
  readonly children: ReactNode
}) => <AutomationContext.Provider value={value}>{children}</AutomationContext.Provider>

export const useAutomationRpc = (): AutomationRpcApi | null => useContext(AutomationContext)

const AutomationContext = createContext<AutomationRpcApi | null>(null)
