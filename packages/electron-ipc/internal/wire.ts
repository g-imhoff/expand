export const utf8Bytes = (value: unknown): number => {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength
  if (value === undefined || value === null) return 0
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength } catch { return Number.MAX_SAFE_INTEGER }
}
export const exactUrl = (input: string, kind: "origin" | "url"): string => {
  const parsed = new URL(input)
  if (kind === "url" && parsed.protocol !== "file:") throw new Error("rendererUrl must be file URL")
  if (parsed.username || parsed.password || parsed.pathname !== (kind === "url" ? parsed.pathname : "/") || parsed.search || parsed.hash) throw new Error("invalid renderer location")
  if (kind === "origin" && parsed.origin === "null") throw new Error("invalid renderer origin")
  if (kind === "url" && parsed.protocol !== "file:" && parsed.origin === "null") throw new Error("invalid renderer url")
  const canonical = kind === "origin" ? parsed.origin : parsed.href
  if (input !== canonical) throw new Error("renderer location must be canonical")
  return canonical
}
