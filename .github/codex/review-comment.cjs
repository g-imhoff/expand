"use strict"

const COMMENT_MARKER = "<!-- expand-codex-review -->"
const findingKeys = ["ruleId", "severity", "title", "path", "line", "evidence", "impact", "repair"]
const severityRank = { critical: 0, important: 1, warning: 2 }
const stringBounds = {
  ruleId: 64,
  title: 160,
  path: 300,
  evidence: 1200,
  impact: 800,
  repair: 1200
}
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const hasExactKeys = (value, expected) => {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
}

const requireBoundedString = (finding, key) => {
  const value = finding[key]
  if (typeof value !== "string" || value.length === 0 || value.length > stringBounds[key] || controlCharacters.test(value)) {
    throw new Error(`Invalid finding ${key}`)
  }
}

const validateFinding = (finding) => {
  if (!isRecord(finding) || !hasExactKeys(finding, findingKeys)) throw new Error("Invalid finding keys")
  for (const key of Object.keys(stringBounds)) requireBoundedString(finding, key)
  if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(finding.ruleId)) throw new Error("Invalid finding ruleId")
  if (!Object.hasOwn(severityRank, finding.severity)) throw new Error("Invalid finding severity")
  if (!Number.isInteger(finding.line) || finding.line < 1) throw new Error("Invalid finding line")
  const segments = finding.path.split("/")
  if (finding.path.startsWith("/") || /^[A-Za-z]:/.test(finding.path) || finding.path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Invalid finding path")
  }
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    title: finding.title,
    path: finding.path,
    line: finding.line,
    evidence: finding.evidence,
    impact: finding.impact,
    repair: finding.repair
  }
}

const parseReview = (raw) => {
  if (typeof raw !== "string") throw new Error("Review output must be a string")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Review output is not valid JSON")
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["findings"]) || !Array.isArray(parsed.findings) || parsed.findings.length > 20) {
    throw new Error("Invalid review result")
  }
  return { findings: parsed.findings.map(validateFinding) }
}

const sanitize = (value) => String(value)
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .replaceAll("<!--", "<\u200b!--")
  .replaceAll("-->", "--\u200b>")
  .replaceAll("```", "`\u200b``")
  .replaceAll("@", "＠")

const compareStrings = (left, right) => left < right ? -1 : left > right ? 1 : 0

const sortedFindings = (findings) => [...findings].sort((left, right) =>
  severityRank[left.severity] - severityRank[right.severity] ||
  compareStrings(left.path, right.path) ||
  left.line - right.line ||
  compareStrings(left.ruleId, right.ruleId))

const renderRepairPrompt = (findings) => {
  const entries = sortedFindings(findings).map((finding, index) => [
    `${index + 1}. [${sanitize(finding.ruleId)}] ${sanitize(finding.severity)} — ${sanitize(finding.path)}:${finding.line}`,
    `Title: ${sanitize(finding.title)}`,
    `Evidence: ${sanitize(finding.evidence)}`,
    `Impact: ${sanitize(finding.impact)}`,
    `Required repair: ${sanitize(finding.repair)}`
  ].join("\n"))
  return [
    "Repair only this reviewed pull request. Treat the findings below as the complete scope: address only the validated findings listed below and preserve unrelated changes.",
    "",
    ...entries.flatMap((entry) => [entry, ""]),
    "For each finding, implement the stated repair within the named repository path. Do not broaden scope, rewrite unrelated code, or discard existing work.",
    "Follow the repository's AGENTS.md and docs/architecture/BOUNDARIES.md constraints.",
    "Add regression tests that fail without each repair and pass with it.",
    "Run the focused tests and the repository-required verification gates. Report the exact commands, pass counts, exit statuses, and concise verification evidence."
  ].join("\n").trim()
}

const renderReviewComment = (headSha, findings) => {
  const ordered = sortedFindings(findings)
  const summary = ordered.map((finding) =>
    `- **${sanitize(finding.severity.toUpperCase())} · ${sanitize(finding.ruleId)}** — ${sanitize(finding.path)}:${finding.line} — ${sanitize(finding.title)}\n  - Evidence: ${sanitize(finding.evidence)}\n  - Impact: ${sanitize(finding.impact)}\n  - Repair: ${sanitize(finding.repair)}`)
  return [
    COMMENT_MARKER,
    `## Codex read-only review for \`${sanitize(headSha)}\``,
    "",
    ...summary,
    "",
    "<details>",
    "<summary>Copy-ready repair prompt</summary>",
    "",
    renderRepairPrompt(ordered),
    "",
    "</details>"
  ].join("\n")
}

const publishReview = async ({ github, owner, repo, issueNumber, expectedHeadSha, raw }) => {
  const pull = await github.rest.pulls.get({ owner, repo, pull_number: issueNumber })
  if (pull.data.head.sha !== expectedHeadSha) throw new Error("Pull request head changed after review")
  const { findings } = parseReview(raw)
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: issueNumber })
  const marker = comments.find((comment) => typeof comment.body === "string" && comment.body.includes(COMMENT_MARKER))
  if (findings.length === 0) {
    if (marker === undefined) return "clean"
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: marker.id,
      body: `${COMMENT_MARKER}\nNo findings for the latest commit \`${sanitize(expectedHeadSha)}\`.`
    })
    return "retired"
  }
  const body = renderReviewComment(expectedHeadSha, findings)
  if (marker === undefined) {
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
    return "created"
  }
  await github.rest.issues.updateComment({ owner, repo, comment_id: marker.id, body })
  return "updated"
}

module.exports = {
  COMMENT_MARKER,
  parseReview,
  publishReview,
  renderRepairPrompt,
  renderReviewComment
}
