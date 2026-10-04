import { Schema } from "effect"

export const ServiceHost = Schema.Literals(["127.0.0.1", "0.0.0.0"])
export type ServiceHost = typeof ServiceHost.Type

export const ServicePort = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65535))
export type ServicePort = typeof ServicePort.Type

export const DEFAULT_SERVICE_HOST = "127.0.0.1" as const
export const DEFAULT_SERVICE_PORT = 0 as const
export const SERVICE_CONTAINER_PORT = 3210 as const
export const SERVICE_HEALTH_PATH = "/healthz" as const

export const hostFromArgs = (args: ReadonlyArray<string>): string | undefined => {
  const index = args.indexOf("--host")
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined
}

export const portFromArgs = (args: ReadonlyArray<string>): number | undefined => {
  const index = args.indexOf("--port")
  if (index === -1 || index + 1 >= args.length) return undefined
  const raw = args[index + 1]!
  if (raw.trim() === "") return Number.NaN
  return Number(raw)
}

export const resolveServiceHost = (
  flag: string | undefined,
  env: string | undefined
): ServiceHost =>
  Schema.decodeUnknownSync(ServiceHost)(flag ?? env ?? DEFAULT_SERVICE_HOST)

export const resolveServicePort = (
  flag: number | undefined,
  envRaw: string | undefined
): ServicePort => {
  const fromEnv = envRaw === undefined ? undefined : envRaw.trim() === "" ? Number.NaN : Number(envRaw)
  return Schema.decodeUnknownSync(ServicePort)(flag ?? fromEnv ?? DEFAULT_SERVICE_PORT)
}

export const advertisedHostFor = (host: ServiceHost): string =>
  host === "0.0.0.0" ? "127.0.0.1" : host
