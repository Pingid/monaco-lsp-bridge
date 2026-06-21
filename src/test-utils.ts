import type * as monaco from 'monaco-editor'

/**
 * Minimal fake Monaco API for tests. Records provider registrations and model
 * markers so behaviour can be asserted without a real editor. Excluded from the
 * published build (see tsconfig.{esm,cjs}.json).
 */
export type FakeMonaco = typeof monaco & {
  registrations: string[]
  models: Map<string, any>
  markers: Map<string, Map<string, any[]>>
}

const uri = (s: string) => ({ toString: () => s, path: s, scheme: 'file' })

const disposable = (registrations: string[], name: string) => {
  registrations.push(name)
  return { dispose() {} }
}

export const makeMonaco = (): FakeMonaco => {
  const registrations: string[] = []
  const models = new Map<string, any>()
  const markers = new Map<string, Map<string, any[]>>()

  const reg =
    (name: string) =>
    (..._args: any[]) =>
      disposable(registrations, name)

  const fake = {
    registrations,
    models,
    markers,
    Uri: { parse: uri },
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    editor: {
      getModel: (u: { toString(): string }) => models.get(u.toString()) ?? null,
      setModelMarkers: (model: any, owner: string, data: any[]) => {
        const byOwner = markers.get(model.uri.toString()) ?? new Map<string, any[]>()
        byOwner.set(owner, data)
        markers.set(model.uri.toString(), byOwner)
      },
    },
    languages: {
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
      SymbolKind: {},
      SymbolTag: { Deprecated: 1 },
      FoldingRangeKind: {
        Comment: { value: 'comment' },
        Imports: { value: 'imports' },
        Region: { value: 'region' },
      },
      registerCompletionItemProvider: reg('completion'),
      registerHoverProvider: reg('hover'),
      registerDocumentFormattingEditProvider: reg('formatting'),
      registerDocumentRangeFormattingEditProvider: reg('rangeFormatting'),
      registerOnTypeFormattingEditProvider: reg('onTypeFormatting'),
      registerDefinitionProvider: reg('definition'),
      registerTypeDefinitionProvider: reg('typeDefinition'),
      registerImplementationProvider: reg('implementation'),
      registerDeclarationProvider: reg('declaration'),
      registerReferenceProvider: reg('references'),
      registerDocumentHighlightProvider: reg('documentHighlight'),
      registerSignatureHelpProvider: reg('signatureHelp'),
      registerDocumentSymbolProvider: reg('documentSymbol'),
      registerFoldingRangeProvider: reg('foldingRange'),
      registerRenameProvider: reg('rename'),
      registerCodeActionProvider: reg('codeAction'),
    },
  }

  return fake as unknown as FakeMonaco
}

/** Create a fake text model with controllable content changes */
export const makeModel = (m: FakeMonaco, url: string, value: string, languageId = 'plaintext') => {
  let version = 1
  const didChange = new Set<(e: any) => void>()
  const willDispose = new Set<() => void>()
  const model = {
    uri: m.Uri.parse(url),
    getValue: () => value,
    getVersionId: () => version,
    getLanguageId: () => languageId,
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1, word: '' }),
    getWordAtPosition: () => null,
    getValueInRange: () => '',
    onWillDispose: (cb: () => void) => (willDispose.add(cb), { dispose: () => willDispose.delete(cb) }),
    onDidChangeContent: (cb: (e: any) => void) => (didChange.add(cb), { dispose: () => didChange.delete(cb) }),
    setContent(next: string) {
      value = next
      version += 1
      const e = { changes: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: next }] }
      for (const cb of didChange) cb(e)
    },
  }
  m.models.set(url, model)
  return model
}

/** Create a fake editor bound to a single model */
export const makeEditor = (model: any) => {
  const modelChange = new Set<(e: any) => void>()
  return {
    getModel: () => model,
    onDidChangeModel: (cb: (e: any) => void) => (modelChange.add(cb), { dispose: () => modelChange.delete(cb) }),
    onDidChangeModelContent: () => ({ dispose() {} }),
  }
}

/** An in-memory Worker-like port paired with a scripted server */
export const makePort = () => {
  const listeners = new Set<(e: { data: any }) => void>()
  let onSend: ((m: any) => void) | undefined
  return {
    port: {
      postMessage: (m: any) => onSend?.(m),
      addEventListener: (_t: 'message', l: (e: { data: any }) => void) => listeners.add(l),
      removeEventListener: (_t: 'message', l: (e: { data: any }) => void) => listeners.delete(l),
    },
    /** Register the server-side handler for messages the client sends */
    onClientMessage: (fn: (m: any) => void) => {
      onSend = fn
    },
    /** Deliver a message from the server to the client */
    toClient: (m: any) => {
      for (const l of listeners) l({ data: m })
    },
  }
}
