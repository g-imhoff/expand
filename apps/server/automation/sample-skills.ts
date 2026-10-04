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
  const line = value.split("\n")[0] ?? ""
  const clean = line.split("\r")[0] ?? line
  return clean.slice(0, 200)
}
