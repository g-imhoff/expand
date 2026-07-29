import { analyzeEffectBoundaryProgram } from "./effect-boundary-analysis.mjs"

const messages = {
  nativeAsync: "Use Effect control flow instead of a native async function.",
  nativeAwait: "Use Effect composition instead of native await.",
  nativePromise: "Construct and combine asynchronous work with Effect instead of Promise.",
  promiseSignature: "Expose asynchronous work as Effect instead of PromiseLike.",
  promiseChain: "Consume Promise results through Effect.tryPromise instead of chaining them directly.",
  platformEffect: "Access platform capabilities through an Effect service or an exact host boundary.",
  runnerOutsideBoundary: "Run Effects only at an exact registered host boundary.",
  effectFunctionBoundary: "Wrap exported named Effect operations with Effect.fn or Effect.fnUntraced.",
  syncSchemaInEffect: "Use Effectful Schema decoding or encoding inside Effect callbacks.",
  staleBoundary: "Remove or correct the stale Effect host-boundary record."
}

const recordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "declaration", "host", "construct", "occurrence"],
  properties: {
    file: { type: "string" },
    declaration: { type: "string" },
    host: { type: "string" },
    construct: { type: "string" },
    occurrence: { type: "integer", minimum: 0 }
  }
}

const validRecord = (record) => {
  if (!record || typeof record !== "object") return false
  if (typeof record.file !== "string" || record.file.length === 0) return false
  if (record.file.startsWith("/") || record.file.endsWith("/") || record.file.includes("\\")) return false
  if (record.file.split("/").includes("..") || /[*?\[\]{}]/.test(record.file)) return false
  if (!/\.(?:[cm]?[jt]sx?)$/.test(record.file)) return false
  if (typeof record.declaration !== "string" || record.declaration.length === 0) return false
  if (typeof record.host !== "string" || record.host.trim().length === 0) return false
  if (typeof record.construct !== "string" || record.construct.length === 0) return false
  return Number.isInteger(record.occurrence) && record.occurrence >= 0
}

const identityKey = (value) => [value.file, value.declaration, value.construct, value.occurrence].join("\u0000")
const matches = (record, identity) => record.file === identity.file
  && record.declaration === identity.declaration
  && record.construct === identity.construct
  && record.occurrence === identity.occurrence

export const effectBoundary = {
  meta: {
    type: "problem",
    docs: { description: "Enforce Effect-only asynchronous and platform boundaries" },
    schema: [{ type: "array", items: recordSchema }],
    messages
  },
  create(context) {
    let analysis
    let staleRecords = []
    return {
      Program(node) {
        analysis = analyzeEffectBoundaryProgram({
          filename: context.filename,
          sourceCode: context.sourceCode,
          parserServices: context.sourceCode.parserServices
        })
        const currentFile = analysis.identityOf(node).file
        const configured = Array.isArray(context.options[0]) ? context.options[0] : []
        const malformed = configured.filter((record) => !validRecord(record))
        const relevant = configured.filter((record) => validRecord(record) && record.file === currentFile)
        const recordsByIdentity = new Map()
        for (const record of relevant) {
          const key = identityKey(record)
          const records = recordsByIdentity.get(key) ?? []
          records.push(record)
          recordsByIdentity.set(key, records)
        }
        const rejected = new Set()
        for (const records of recordsByIdentity.values()) if (records.length > 1) for (const record of records) rejected.add(record)
        const consumed = new Set()
        for (const occurrence of analysis.occurrences) {
          const matching = relevant.filter((record) => !rejected.has(record) && matches(record, occurrence.identity))
          if (matching.length === 1) {
            consumed.add(matching[0])
          } else {
            context.report({ node: occurrence.node, messageId: occurrence.messageId })
          }
          if (matching.length > 1) for (const record of matching) rejected.add(record)
        }
        staleRecords = [
          ...malformed,
          ...relevant.filter((record) => rejected.has(record) || !consumed.has(record))
        ]
      },
      "Program:exit"(node) {
        if (!analysis) return
        for (const record of staleRecords) context.report({ node, messageId: "staleBoundary", data: { record } })
      }
    }
  }
}
