import { SampleWriteFileInput } from "@expand/contracts/automation/skills"
import type { SkillDefinition } from "./skill-registry.js"

export const sampleWriteFileSkill: SkillDefinition = {
  id: "sample-write-file",
  version: 1,
  title: "Sample write file",
  description: "Writes OUTPUT.md with the given content through the coding agent",
  inputSchema: SampleWriteFileInput,
  requiredCapabilities: ["execute"],
  allowedPaths: ["OUTPUT.md"],
  buildPrompt: (inputs) => {
    const record = inputs as { readonly content?: unknown }
    const raw = typeof record.content === "string" ? record.content : ""
    const content = singleLine(raw)
    if (content.length === 0) {
      return ""
    }
    return [
      "You are a file writing skill. Make exactly one change.",
      "write:OUTPUT.md:" + content,
      "Only modify OUTPUT.md. Do not touch any other file.",
      "Do not print secrets or tokens in the transcript.",
      "When done, report wrote OUTPUT.md."
    ].join("\n")
  }
}

export const sampleSkills: ReadonlyArray<SkillDefinition> = [sampleWriteFileSkill]

const singleLine = (value: string): string => {
  const parts = value.split(/[\n\r\u2028\u2029\v\f\0\u0085]/)
  for (const part of parts) {
    const cleaned = part.replace(/[\x00-\x08\x0B-\x1F\x7F\u0080-\u009F]/g, "").trim()
    if (cleaned.length > 0) {
      return cleaned.slice(0, 200)
    }
  }
  return ""
}
