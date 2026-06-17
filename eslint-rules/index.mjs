import { exportsOnTop } from "./exports-on-top.mjs"
import { noExportStar } from "./no-export-star.mjs"

/** Local ESLint plugin holding Yodea-specific layout/architecture rules. */
export default {
  meta: { name: "local" },
  rules: {
    "exports-on-top": exportsOnTop,
    "no-export-star": noExportStar
  }
}
