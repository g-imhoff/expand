import { moduleOrder } from "./module-order.mjs"
import { noExportStar } from "./no-export-star.mjs"

export default {
  meta: { name: "local" },
  rules: {
    "module-order": moduleOrder,
    "no-export-star": noExportStar
  }
}
