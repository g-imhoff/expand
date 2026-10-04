import { Context } from "effect"
import type { AutomationRegistry } from "./registry.js"

export class AutomationRegistryService extends Context.Service<AutomationRegistryService, AutomationRegistry>()(
  "expand/AutomationRegistry"
) {}
