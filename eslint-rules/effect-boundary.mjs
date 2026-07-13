import { analyzeEffectBoundaryProgram } from "./effect-boundary-analysis.mjs"

const recordKey = (record) =>
  [record.file, record.declaration, record.construct, String(record.occurrence)].join("\u0000")

const identityKey = (identity) =>
  [identity.file, identity.declaration, identity.construct, String(identity.occurrence)].join("\u0000")

const isExactText = (value) =>
  typeof value === "string"
  && value.trim().length > 0
  && !/[*?[\]{}]/u.test(value)

const isExactFile = (file) =>
  isExactText(file)
  && !file.startsWith("/")
  && !file.endsWith("/")
  && /\.(?:[cm]?[jt]sx?)$/u.test(file)

const isBoundaryRecord = (record) =>
  record !== null
  && typeof record === "object"
  && isExactFile(record.file)
  && isExactText(record.declaration)
  && isExactText(record.host)
  && isExactText(record.construct)
  && Number.isInteger(record.occurrence)
  && record.occurrence >= 0

export const effectBoundary = {
  meta: {
    type: "problem",
    docs: { description: "Enforce Effect-only asynchronous and platform boundaries" },
    schema: [
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            declaration: { type: "string" },
            host: { type: "string" },
            construct: { type: "string" },
            occurrence: { type: "integer", minimum: 0 }
          },
          required: ["file", "declaration", "host", "construct", "occurrence"],
          additionalProperties: false
        }
      }
    ],
    messages: {
      nativeAsync: "Use Effect composition instead of a native async function.",
      nativeAwait: "Use Effect composition instead of native await.",
      nativePromise: "Use Effect instead of constructing or combining native Promises.",
      promiseSignature: "Use an Effect return type instead of a PromiseLike signature or flow.",
      promiseChain: "Use Effect operators instead of Promise then, catch, or finally chains.",
      platformEffect: "Access platform capabilities through an Effect service or an exact host boundary.",
      runnerOutsideBoundary: "Run Effects only at an exact registered host boundary.",
      effectFunctionBoundary: "Wrap exported Effect-returning operations with Effect.fn or Effect.fnUntraced.",
      syncSchemaInEffect: "Use effectful Schema decoding or encoding inside Effect code.",
      staleBoundary: "Remove or correct this unused, broad, duplicate, or invalid Effect host boundary."
    }
  },
  create(context) {
    let exit
    return {
      Program(program) {
        const analysis = analyzeEffectBoundaryProgram({
          filename: context.filename,
          sourceCode: context.sourceCode,
          parserServices: context.sourceCode.parserServices
        })
        const configured = Array.isArray(context.options[0]) ? context.options[0] : []
        const invalid = new Set()
        const keyCounts = new Map()

        for (const record of configured) {
          if (!isBoundaryRecord(record)) invalid.add(record)
          if (record !== null && typeof record === "object") {
            const key = recordKey(record)
            keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
          }
        }
        for (const record of configured) {
          if ((keyCounts.get(recordKey(record)) ?? 0) > 1) invalid.add(record)
        }

        const relevant = configured.filter((record) => record?.file === analysis.identityOf(program).file)

        const matches = new Map(relevant.map((record) => [record, 0]))
        for (const occurrence of analysis.occurrences) {
          const matching = relevant.filter((record) => !invalid.has(record)
            && recordKey(record) === identityKey(occurrence.identity))
          if (matching.length === 1) {
            matches.set(matching[0], (matches.get(matching[0]) ?? 0) + 1)
          } else {
            context.report({ node: occurrence.node, messageId: occurrence.messageId })
          }
        }

        exit = () => {
          for (const record of configured) {
            if (invalid.has(record)) context.report({ node: program, messageId: "staleBoundary" })
          }
          for (const record of relevant) {
            if (!invalid.has(record) && matches.get(record) !== 1) {
              context.report({ node: program, messageId: "staleBoundary" })
            }
          }
        }
      },
      "Program:exit"() {
        exit?.()
      }
    }
  }
}
