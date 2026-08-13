/**
 * `@expand/client-ts/server` — the server domain of the Expand client SDK: a
 * typed facade for backend health/presence.
 *
 * @remarks
 * {@link ServerClient} is a stateless facade over the shared connection provided
 * by `ClientLayer` (package root `@expand/client-ts`).
 *
 * @packageDocumentation
 */
export { ServerClient, ServerClientLayer, type ServerClientApi } from "./client"
