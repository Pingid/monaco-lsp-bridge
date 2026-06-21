import { describe, it, expect } from 'vitest'

import { makeMonaco, makeModel, makeEditor, makePort } from './test-utils.js'
import { LspMonacoClient } from './client.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

const capabilities = {
  textDocumentSync: { openClose: true, change: 1 },
  completionProvider: { resolveProvider: true, triggerCharacters: ['.'] },
  hoverProvider: true,
  documentFormattingProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  documentHighlightProvider: true,
  signatureHelpProvider: { triggerCharacters: ['('] },
  documentSymbolProvider: true,
  foldingRangeProvider: true,
  renameProvider: { prepareProvider: true },
  codeActionProvider: { resolveProvider: true },
}

const setup = () => {
  const m = makeMonaco()
  const model = makeModel(m, 'file:///main.txt', 'hello')
  const editor = makeEditor(model)
  const { port, onClientMessage, toClient } = makePort()

  const toServer: any[] = []
  onClientMessage((msg) => {
    toServer.push(msg)
    if (msg.method === 'initialize') {
      // Respond asynchronously so the request's waiter is registered first
      queueMicrotask(() => toClient({ jsonrpc: '2.0', id: msg.id, result: { capabilities } }))
    }
  })

  const client = new LspMonacoClient(port as any, { languageSelector: { language: 'plaintext' } })
  const initialized = new Promise<void>((res) => {
    const off = client.onEvent((e) => {
      if (e.type === 'initialized') {
        off()
        res()
      }
    })
  })

  return { m, model, editor, client, toServer, toClient, initialized }
}

describe('LspMonacoClient', () => {
  it('registers providers based on server capabilities', async () => {
    const { m, editor, client, initialized } = setup()
    client.connect(m as any, editor as any)
    await initialized

    expect(m.registrations).toEqual(
      expect.arrayContaining([
        'completion',
        'hover',
        'formatting',
        'definition',
        'references',
        'documentHighlight',
        'signatureHelp',
        'documentSymbol',
        'foldingRange',
        'rename',
        'codeAction',
      ]),
    )
    // Capabilities the server did not advertise are not wired
    expect(m.registrations).not.toContain('typeDefinition')
    expect(m.registrations).not.toContain('rangeFormatting')
  })

  it('opens the document and streams changes', async () => {
    const { m, model, editor, client, toServer, initialized } = setup()
    client.connect(m as any, editor as any)
    await initialized

    const didOpen = toServer.find((msg) => msg.method === 'textDocument/didOpen')
    expect(didOpen?.params.textDocument).toMatchObject({ uri: 'file:///main.txt', text: 'hello' })

    model.setContent('world')
    const didChange = toServer.find((msg) => msg.method === 'textDocument/didChange')
    expect(didChange?.params.contentChanges).toEqual([{ text: 'world' }])
  })

  it('turns published diagnostics into markers', async () => {
    const { m, client, editor, toClient, initialized } = setup()
    client.connect(m as any, editor as any)
    await initialized

    toClient({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///main.txt',
        diagnostics: [
          {
            message: 'bad',
            severity: 1,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
        ],
      },
    })
    await tick()

    const owners = m.markers.get('file:///main.txt')
    const markers = owners?.get('lsp-diagnostics')
    expect(markers).toHaveLength(1)
    expect(markers?.[0]).toMatchObject({ message: 'bad', severity: m.MarkerSeverity.Error })
  })
})
