import type { Project } from "@yodea/contracts/project"
import type { Screen } from "@yodea/tui/app-state"

export interface CommandContext {
  readonly navigate: (screen: Screen) => void
  readonly projects: {
    readonly list: ReadonlyArray<Project>
    readonly create: (name: string) => void
  }
  readonly setError: (message: string) => void
  readonly setNotice: (message: string) => void
  readonly exit: () => void
  readonly submitMessage: (text: string) => void // the chat seam
}

export interface SlashCommand {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly run: (ctx: CommandContext, args: ReadonlyArray<string>) => void
}
