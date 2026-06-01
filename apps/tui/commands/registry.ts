import type { CommandContext, SlashCommand } from "@yodea/tui/commands/types"

export const commands: ReadonlyArray<SlashCommand> = [
  {
    id: "new",
    name: "new",
    description: "Create a project: /new <name>",
    run: (ctx, args) => {
      const name = args.join(" ").trim()
      if (name.length === 0) {
        ctx.setError("Usage: /new <name>")
        return
      }
      ctx.projects.create(name)
    },
  },
  {
    id: "open",
    name: "open",
    description: "Open a project: /open <name|id>",
    run: (ctx, args) => {
      const query = args.join(" ").trim()
      if (query.length === 0) {
        ctx.setError("Usage: /open <name|id>")
        return
      }
      const match = ctx.projects.list.find((p) => p.id === query || p.name === query)
      if (!match) {
        ctx.setError(`No project matching "${query}"`)
        return
      }
      ctx.navigate({ kind: "projectWorkspace", projectId: match.id })
    },
  },
  {
    id: "projects",
    name: "projects",
    description: "Show the project list",
    run: (ctx) => ctx.navigate({ kind: "projectList" }),
  },
  {
    id: "help",
    name: "help",
    description: "List commands",
    run: (ctx) => ctx.setNotice(commands.map((c) => `/${c.name}`).join("  ")),
  },
  {
    id: "quit",
    name: "quit",
    description: "Exit Yodea",
    run: (ctx) => ctx.exit(),
  },
]

export const dispatch = (name: string, args: ReadonlyArray<string>, ctx: CommandContext): void => {
  const command = commands.find((c) => c.name === name)
  if (!command) {
    ctx.setError(`Unknown command: /${name}`)
    return
  }
  command.run(ctx, args)
}

export const suggestionsFor = (buffer: string): ReadonlyArray<SlashCommand> => {
  if (!buffer.startsWith("/")) return []
  const prefix = buffer.slice(1).split(/\s+/)[0] ?? ""
  return commands.filter((c) => c.name.startsWith(prefix))
}
