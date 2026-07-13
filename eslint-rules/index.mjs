import { moduleOrder } from "./module-order.mjs"
import { noExportStar } from "./no-export-star.mjs"
import { effectBoundary } from "./effect-boundary.mjs"

export default {
  meta: { name: "local" },
  rules: {
    "effect-boundary": effectBoundary,
    "module-order": moduleOrder,
    "no-export-star": noExportStar
  }
}
