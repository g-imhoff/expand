// Deterministic event-script generator + (in Task 3) batched seeding into cached
// SQLite files. Bump GENERATOR_VERSION whenever generated output changes — it is
// part of the cache filename.
import { Schema } from "effect"
import type { ProjectEvent } from "@yodea/contracts/events/project"
import {
  ProjectArchived,
  ProjectCreated,
  ProjectDeleted,
  ProjectDirectoryChanged,
  ProjectMetadataChanged,
  ProjectRenamed,
  ProjectRestored
} from "@yodea/contracts/events/project"
import { Project } from "@yodea/contracts/project"

export const GENERATOR_VERSION = 1
export const PRNG_SEED = 42
export const LIVE_PROJECT_CAP = 200

export const SCALES: Readonly<Record<string, number>> = {
  smoke: 1_000,
  "100k": 100_000,
  "1m": 1_000_000,
  "10m": 10_000_000
}

// Mirrors the private codec in apps/server/application/projections.ts:13 — the
// planted checkpoint must be decodable by the production boot path.
export const ProjectsFromJson = Schema.fromJsonString(Schema.Array(Project))

// mulberry32 — tiny deterministic PRNG. Same seed → same script, every run.
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Simulated project lifecycles against a capped live population (~LIVE_PROJECT_CAP).
// Cap rationale: tail-fold cost is O(P) per event (Project.foldList maps the whole
// array), so P must stay realistic while the event count explodes.
// IDs are UUID-v4-shaped and names/tags match the Project brand patterns — the
// planted checkpoint is decoded WITH checks at boot (see selfcheck).
export function* generateEvents(count: number, seed: number = PRNG_SEED): Generator<ProjectEvent, void, void> {
  const rand = mulberry32(seed)
  const live: Array<string> = []
  const archived = new Set<string>()
  let nextId = 1
  const pick = (arr: ReadonlyArray<string>): string => arr[Math.floor(rand() * arr.length)]!
  for (let i = 0; i < count; i++) {
    const at = new Date(BASE_MS + i * 1000).toISOString()
    const r = rand()
    if (live.length === 0 || (r < 0.05 && live.length < LIVE_PROJECT_CAP)) {
      const n = nextId++
      const id = uuidOf(n)
      live.push(id)
      yield ProjectCreated.make({ projectId: id, name: `bench-p${n}`, directory: `/bench/p${n}`, occurredAt: at })
    } else {
      const id = pick(live)
      if (r < 0.4) {
        yield ProjectRenamed.make({ projectId: id, name: `bench-r${i % 1000}`, occurredAt: at })
      } else if (r < 0.7) {
        yield ProjectMetadataChanged.make({
          projectId: id,
          description: `bench project description ${i}`,
          tags: ["bench", `t${i % 10}`],
          occurredAt: at
        })
      } else if (r < 0.85) {
        yield ProjectDirectoryChanged.make({ projectId: id, directory: `/bench/dir-${i % 100}`, occurredAt: at })
      } else if (r < 0.92) {
        if (archived.has(id)) {
          archived.delete(id)
          yield ProjectRestored.make({ projectId: id, occurredAt: at })
        } else {
          archived.add(id)
          yield ProjectArchived.make({ projectId: id, occurredAt: at })
        }
      } else if (r < 0.97) {
        if (archived.size > 0) {
          const aid = pick([...archived])
          archived.delete(aid)
          yield ProjectRestored.make({ projectId: aid, occurredAt: at })
        } else {
          yield ProjectMetadataChanged.make({ projectId: id, tags: ["bench"], occurredAt: at })
        }
      } else {
        live.splice(live.indexOf(id), 1)
        archived.delete(id)
        yield ProjectDeleted.make({ projectId: id, occurredAt: at })
      }
    }
  }
}

// UUID-v4-shaped (version nibble 4, variant nibble 8) — passes Schema.isUUID(4).
const uuidOf = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

// Deterministic timestamps: index-derived, never wall-clock.
const BASE_MS = Date.UTC(2026, 0, 1)
