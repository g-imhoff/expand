import { effectBoundary } from "./effect-boundary.mjs"
import { moduleOrder } from "./module-order.mjs"
import { noExportStar } from "./no-export-star.mjs"

export default {
  meta: { name: "local" },
  rules: {
    "effect-boundary": effectBoundary,
    "module-order": moduleOrder,
    "no-export-star": noExportStar
  }
}
