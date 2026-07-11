import { LABEL, analyzeModule } from "./module-order-analysis.mjs"

export const moduleOrder = {
  meta: {
    type: "layout",
    docs: { description: "Enforce Expand's top-level module declaration order" },
    fixable: "code",
    schema: [],
    messages: {
      outOfOrder: "Expected {{actual}} before {{previous}}.",
      unsafeOrder: "Expected {{actual}} before {{previous}}, but moving it may change runtime behavior; refactor this ordering manually."
    }
  },
  create(context) {
    return {
      Program(program) {
        const analysis = analyzeModule(context.sourceCode, program)
        if (analysis === null) return
        const report = {
          node: analysis.violation.statement,
          messageId: analysis.fix === null ? "unsafeOrder" : "outOfOrder",
          data: {
            actual: LABEL[analysis.violation.group],
            previous: LABEL[analysis.violation.previousGroup]
          }
        }
        if (analysis.fix !== null) {
          report.fix = (fixer) => fixer.replaceTextRange(analysis.fix.range, analysis.fix.text)
        }
        context.report(report)
      }
    }
  }
}
