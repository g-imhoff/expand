export const parseProcStatStarttime = (statText: string): string | undefined => {
  const closeParen = statText.lastIndexOf(")")
  if (closeParen === -1) return undefined
  const fields = statText.slice(closeParen + 1).trim().split(/\s+/)
  if (fields.length < 20) return undefined
  const starttime = fields[19]
  return starttime !== undefined && /^\d+$/.test(starttime) ? starttime : undefined
}

export const formatIncarnation = (
  starttime: string | undefined,
  bootId: string | undefined
): string | undefined => {
  if (starttime === undefined) return undefined
  const boot = bootId === undefined || bootId === "" ? "nobootid" : bootId.trim()
  return `${boot}:${starttime}`
}

export const incarnationsMatch = (
  recorded: string | undefined,
  observed: string | undefined
): boolean => recorded !== undefined && observed !== undefined && recorded === observed
