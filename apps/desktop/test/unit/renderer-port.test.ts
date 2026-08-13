import { describe, expect, it } from "vitest"
import { makeRendererPort } from "@expand/desktop/renderer/rpc/renderer-port"

const makeFakeMessagePort = () => {
  const sent: Array<unknown> = []
  let started = false
  let closes = 0
  const port = {
    postMessage: (m: unknown) => { sent.push(m) },
    onmessage: null as ((event: MessageEvent) => void) | null,
    start: () => { started = true },
    close: () => { closes += 1 }
  }
  return {
    port: port as unknown as MessagePort,
    sent,
    isStarted: () => started,
    closes: () => closes,
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

  it("forwards each close call to the underlying MessagePort once", () => {
    const fake = makeFakeMessagePort()
    const adapter = makeRendererPort(fake.port)
    adapter.close?.()
    adapter.close?.()
    expect(fake.closes()).toBe(2)
  })
})
