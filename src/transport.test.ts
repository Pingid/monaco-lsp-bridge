import { describe, it, expect } from 'vitest'

import { LspTransport } from './transport.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

const make = () => {
  let recv: (m: any) => void = () => {}
  const sent: any[] = []
  const t = new LspTransport(
    (m) => sent.push(m),
    (cb) => {
      recv = cb
      return () => {}
    },
  )
  return { t, sent, inject: (m: any) => recv(m), lastId: () => sent.at(-1)?.id }
}

describe('request/response', () => {
  it('resolves with the result', async () => {
    const { t, sent, inject } = make()
    const p = t.sendRequest('shutdown', null)
    inject({ jsonrpc: '2.0', id: sent.at(-1).id, result: null })
    expect(await p).toEqual({ cancelled: false, result: null })
  })

  it('rejects on an error response', async () => {
    const { t, sent, inject } = make()
    const p = t.sendRequest('shutdown', null)
    inject({ jsonrpc: '2.0', id: sent.at(-1).id, error: { code: -32603, message: 'boom' } })
    await expect(p).rejects.toThrow('boom')
  })

  it('resolves cancelled on cancellation errors', async () => {
    const { t, sent, inject } = make()
    const p = t.sendRequest('shutdown', null)
    inject({ jsonrpc: '2.0', id: sent.at(-1).id, error: { code: -32800, message: 'cancelled' } })
    expect(await p).toMatchObject({ cancelled: true })
  })

  it('dispatches batched frames independently', async () => {
    const { t, sent, inject } = make()
    const p1 = t.sendRequest('shutdown', null)
    const id1 = sent.at(-1).id
    const p2 = t.sendRequest('shutdown', null)
    const id2 = sent.at(-1).id
    inject([
      { jsonrpc: '2.0', id: id1, result: 1 },
      { jsonrpc: '2.0', id: id2, result: 2 },
    ])
    expect(await p1).toEqual({ cancelled: false, result: 1 })
    expect(await p2).toEqual({ cancelled: false, result: 2 })
  })
})

describe('cancellation and timeout', () => {
  it('sends $/cancelRequest and resolves cancelled on abort', async () => {
    const { t, sent } = make()
    const ac = new AbortController()
    const p = t.sendRequest('shutdown', null, { signal: ac.signal })
    ac.abort()
    expect(await p).toMatchObject({ cancelled: true })
    expect(sent.some((m) => m.method === '$/cancelRequest')).toBe(true)
  })

  it('rejects when the request times out', async () => {
    const { t } = make()
    await expect(t.sendRequest('shutdown', null, { timeoutMs: 5 })).rejects.toThrow(/timed out/)
  })
})

describe('progress', () => {
  it('routes $/progress to the callback and stops after end', async () => {
    const { t, sent, inject } = make()
    const values: any[] = []
    const p = t.sendRequest('shutdown', null, { onProgress: (v) => values.push(v) })
    const req = sent.at(-1)
    const token = req.params.workDoneToken
    inject({ jsonrpc: '2.0', method: '$/progress', params: { token, value: { kind: 'begin', title: 'x' } } })
    inject({ jsonrpc: '2.0', method: '$/progress', params: { token, value: { kind: 'end' } } })
    inject({ jsonrpc: '2.0', method: '$/progress', params: { token, value: { kind: 'report' } } })
    inject({ jsonrpc: '2.0', id: req.id, result: null })
    await p
    expect(values.map((v) => v.kind)).toEqual(['begin', 'end'])
  })
})

describe('server-to-client requests', () => {
  it('replies to workspace/configuration with nulls by default', async () => {
    const { sent, inject } = make()
    inject({ jsonrpc: '2.0', id: 's1', method: 'workspace/configuration', params: { items: [{}, {}] } })
    await tick()
    expect(sent.find((m) => m.id === 's1')?.result).toEqual([null, null])
  })

  it('uses a registered handler when present', async () => {
    const { t, sent, inject } = make()
    t.onServerRequest('window/showMessageRequest', () => ({ title: 'OK' }))
    inject({ jsonrpc: '2.0', id: 's2', method: 'window/showMessageRequest', params: {} })
    await tick()
    expect(sent.find((m) => m.id === 's2')?.result).toEqual({ title: 'OK' })
  })

  it('returns MethodNotFound for unknown requests', async () => {
    const { sent, inject } = make()
    inject({ jsonrpc: '2.0', id: 's3', method: 'unknown/thing', params: {} })
    await tick()
    expect(sent.find((m) => m.id === 's3')?.error?.code).toBe(-32601)
  })
})

describe('notifications', () => {
  it('delivers server notifications to subscribers', () => {
    const { t, inject } = make()
    const got: any[] = []
    t.onServerNotification('textDocument/publishDiagnostics', (p) => got.push(p))
    inject({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a', diagnostics: [] } })
    expect(got).toHaveLength(1)
  })
})
