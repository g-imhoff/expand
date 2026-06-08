import { describe, expect, it } from "vitest"
import { makeRendererPort } from "@yodea/desktop/renderer/rpc/renderer-port"

const makeFakeMessagePort = () => {
  const sent: Array<unknown> = []
  let started = false
  const port = {
    postMessage: (m: unknown) => { sent.push(m) },
    onmessage: null as ((event: MessageEvent) => void) | null,
    start: () => { started = true }
  }
  return {
    port: port as unknown as MessagePort,
    sent,
    isStarted: () => started,
    fire: (data: unknown) => port.onmessage?.({ data } as MessageEvent)
  }
}

describe("makeRendererPort", () => {
  it("forwards postMessage and start to the underlying MessagePort", () => {
    const fake = makeFakeMessagePort()
    const adapter = makeRendererPort(fake.port)
    adapter.postMessage("hello")
    adapter.start()
    expect(fake.sent).toEqual(["hello"])
    expect(fake.isStarted()).toBe(true)
  })

  it("routes MessagePort onmessage data to the assigned handler", () => {
    const fake = makeFakeMessagePort()
    const adapter = makeRendererPort(fake.port)
    const received: Array<unknown> = []
    adapter.onmessage = (event) => { received.push(event.data) }
    fake.fire("payload")
    expect(received).toEqual(["payload"])
    expect(adapter.onmessage).not.toBeNull()
  })
})
