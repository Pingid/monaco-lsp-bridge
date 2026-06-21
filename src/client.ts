import type {
  InitializeResult,
  CompletionOptions,
  ClientCapabilities,
  InitializeParams,
  TextEdit,
  Range,
  CompletionItem,
  CompletionContext,
} from 'vscode-languageserver-protocol'

import type * as monaco from 'monaco-editor'

import {
  toMonacoCompletionItem,
  toLspPosition,
  toLspRange,
  toLspCompletionItem,
  mergeResolvedCompletionItem,
  toMonacoMarkers,
  toMonacoTextEdits,
  lspHoverToMonaco,
  toMonacoLocations,
  toMonacoLocation,
  toMonacoHighlights,
  toMonacoSignatureHelp,
  toMonacoSymbols,
  toMonacoFoldingRanges,
  toMonacoWorkspaceEdit,
  toMonacoRenameLocation,
  toMonacoCodeActions,
  toMonacoCodeAction,
  getLspCodeAction,
  toLspDiagnostics,
} from './transform.js'
import { LspTransport, Transport } from './transport.js'
import type { MaybeCancelled } from './transport.js'
import { ProgressPayload } from './protocol.js'
import type { RequestMap } from './protocol.js'
import type { LspError } from './error.js'

type Monaco = typeof monaco

// Event types
export type ClientEvent =
  | { type: 'initialized'; capabilities: InitializeResult['capabilities'] }
  | { type: 'error'; error: LspError }
  | { type: 'workDoneProgress'; params: ProgressPayload }
  | { type: 'logMessage'; method: string; params: any }
  | { type: 'shutdownError'; error: unknown }

export type ClientEventHandler = (event: ClientEvent) => void

export type MonacoLspClientOptions = {
  languageSelector: monaco.languages.LanguageSelector
  /** Send shutdown/exit on dispose when server is dedicated */
  dedicatedServer?: boolean
  initialParams?: InitializeParams
}

export class LspMonacoClient {
  static CLIENT_NAME = 'monaco-lsp-bridge'
  static CLIENT_VERSION = '0.0.1'

  private editor: monaco.editor.ICodeEditor | null = null
  private monaco: Monaco | null = null
  private binding: LspTransport
  private endpoint: Transport
  private openDocuments = new Set<string>() // Track opened document URIs
  private initialized = false
  private eventHandlers = new Set<ClientEventHandler>()
  private syncKind: number = 0 // 0=None, 1=Full, 2=Incremental
  private syncChange = false // whether the server wants didChange notifications
  private readonly MARKER_OWNER = 'lsp-diagnostics'

  /** Construct a Monaco LSP client bound to an endpoint */
  constructor(
    endpoint: Transport,
    private options: MonacoLspClientOptions,
  ) {
    this.endpoint = endpoint
    this.binding = LspTransport.infer(endpoint)
  }

  /** Register an event handler for client events */
  onEvent(handler: ClientEventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /** Emit an event to all registered handlers */
  private emit(event: ClientEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        // Prevent handler errors from breaking the client
        console.error('Event handler error:', error)
      }
    }
  }

  /** Register Monaco editor instance and initialize LSP wiring */
  connect(monaco: Monaco, editor: monaco.editor.ICodeEditor) {
    if (this.editor === editor) return

    this.dispose()

    // Recreate binding after dispose
    this.binding = LspTransport.infer(this.endpoint)
    this.editor = editor
    this.monaco = monaco

    // Wire error/progress events
    this.binding
      .onError((error) => this.emit({ type: 'error', error }))
      .onProgressNotification((params) => this.emit({ type: 'workDoneProgress', params }))
      .onServerNotification('window/logMessage', (params) =>
        this.emit({ type: 'logMessage', method: 'window/logMessage', params }),
      )

    // Initialize server
    this.initialize()
  }

  /** Initialize the LSP server connection and capabilities */
  private async initialize() {
    try {
      const params: InitializeParams = this.options.initialParams ?? {
        processId: (globalThis as { process?: { pid?: number } }).process?.pid ?? null,
        rootUri: null,
        clientInfo: { name: LspMonacoClient.CLIENT_NAME, version: LspMonacoClient.CLIENT_VERSION },
        locale: typeof navigator !== 'undefined' ? navigator.language : 'en-US',
        capabilities: LspMonacoClient.CAPABILITIES,
        // Omit workspaceFolders (we advertise false)
      }
      const init = await this.binding.sendRequest('initialize', params)

      if (!init.cancelled && init.result?.capabilities) {
        this.initialized = true
        this.emit({ type: 'initialized', capabilities: init.result.capabilities })
        this.applyServerCapabilities(init.result.capabilities)
      }
    } catch (error) {
      // Error already emitted; keep uninitialized
      this.initialized = false
    }
  }

  /** Dispose the client, closing docs and optionally shutting down server */
  async dispose() {
    // Close all open documents
    for (const uri of this.openDocuments) {
      this.binding.sendNotification('textDocument/didClose', { textDocument: { uri } })
      // Clear diagnostics markers for each open document
      const monacoApi = this.monaco
      if (monacoApi) {
        const model = monacoApi.editor.getModel(monacoApi.Uri.parse(uri))
        if (model) monacoApi.editor.setModelMarkers(model, this.MARKER_OWNER, [])
      }
    }
    this.openDocuments.clear()

    // Graceful shutdown for dedicated servers
    if (this.options.dedicatedServer && this.initialized) {
      try {
        // Request shutdown with timeout
        await this.binding.sendRequest(
          'shutdown',
          null,
          { timeoutMs: 5000 }, // 5 second timeout
        )
      } catch (error) {
        this.emit({ type: 'shutdownError', error })
        // Continue with exit anyway
      } finally {
        // Always send exit (fire-and-forget)
        this.binding.sendNotification('exit', null)
      }
    }

    // Tear down binding
    this.binding.dispose()
    this.editor = null
    this.initialized = false
  }

  /** Register Monaco features based on server-reported capabilities */
  private applyServerCapabilities(caps: InitializeResult['capabilities']) {
    if (!this.editor) return
    const sync = caps.textDocumentSync

    // TextDocumentSyncKind: 0=None, 1=Full, 2=Incremental
    if (typeof sync === 'number') {
      this.syncKind = sync
    } else if (typeof sync === 'object' && sync !== null) {
      this.syncKind = sync.change ?? 0
    } else {
      this.syncKind = 0
    }

    // Open/close supported
    const enableOpenClose = typeof sync === 'object' ? !!sync.openClose : sync !== undefined && sync !== 0

    // Change supported for Full/Incremental
    const enableChange = this.syncKind === 1 || this.syncKind === 2

    this.syncChange = enableChange
    if (enableOpenClose) {
      this.handleModelChange({ oldModelUrl: null, newModelUrl: this.editor.getModel()?.uri ?? null } as any)
      this.binding.addDisposable(this.editor.onDidChangeModel((e) => this.handleModelChange(e)))
    }
    if (caps.completionProvider) this.registerCompletionProvider(caps.completionProvider)
    if (caps.hoverProvider) this.registerHoverProvider()
    if (caps.documentFormattingProvider) this.registerFormattingProvider()
    if (caps.documentRangeFormattingProvider) this.registerRangeFormattingProvider()
    if (caps.documentOnTypeFormattingProvider)
      this.registerOnTypeFormattingProvider(caps.documentOnTypeFormattingProvider)
    this.registerLanguageFeatures(caps)
    // Listen for diagnostics
    this.wireDiagnostics()
  }

  // ---------------- Provider helpers ----------------
  /** textDocument + position params for the current model/position */
  private posParams(model: monaco.editor.ITextModel, position: monaco.IPosition) {
    return { textDocument: { uri: model.uri.toString() }, position: toLspPosition(position) }
  }

  /** Send a cancellable LSP request, returning `fallback` on cancellation/error */
  private ask<K extends keyof RequestMap, E>(
    token: monaco.CancellationToken,
    method: K,
    params: RequestMap[K]['fields']['params'],
    fallback: E,
  ) {
    return withCancellation(token, (p) => this.binding.sendRequest(method, params, p), fallback)
  }

  /** Register a Monaco provider built from the active monaco instance */
  private register(fn: (m: Monaco) => monaco.IDisposable) {
    if (this.monaco) this.binding.addDisposable(fn(this.monaco))
  }

  /** Build a position-based location resolver for definition-like providers */
  private location(
    method:
      | 'textDocument/definition'
      | 'textDocument/typeDefinition'
      | 'textDocument/implementation'
      | 'textDocument/declaration',
  ) {
    return (model: monaco.editor.ITextModel, position: monaco.Position, token: monaco.CancellationToken) =>
      this.ask(token, method, this.posParams(model, position), null).then((r) => toMonacoLocations(this.monaco!, r))
  }

  /** Wire navigation, signature, symbol, folding, rename and code-action providers */
  private registerLanguageFeatures(caps: InitializeResult['capabilities']) {
    const sel = this.options.languageSelector

    if (caps.definitionProvider)
      this.register((m) =>
        m.languages.registerDefinitionProvider(sel, { provideDefinition: this.location('textDocument/definition') }),
      )
    if (caps.typeDefinitionProvider)
      this.register((m) =>
        m.languages.registerTypeDefinitionProvider(sel, {
          provideTypeDefinition: this.location('textDocument/typeDefinition'),
        }),
      )
    if (caps.implementationProvider)
      this.register((m) =>
        m.languages.registerImplementationProvider(sel, {
          provideImplementation: this.location('textDocument/implementation'),
        }),
      )
    if (caps.declarationProvider)
      this.register((m) =>
        m.languages.registerDeclarationProvider(sel, { provideDeclaration: this.location('textDocument/declaration') }),
      )

    if (caps.referencesProvider)
      this.register((m) =>
        m.languages.registerReferenceProvider(sel, {
          provideReferences: (model, position, context, token) =>
            this.ask(
              token,
              'textDocument/references',
              { ...this.posParams(model, position), context: { includeDeclaration: context.includeDeclaration } },
              null,
            ).then((r) => (r ?? []).map((loc) => toMonacoLocation(m, loc))),
        }),
      )

    if (caps.documentHighlightProvider)
      this.register((m) =>
        m.languages.registerDocumentHighlightProvider(sel, {
          provideDocumentHighlights: (model, position, token) =>
            this.ask(token, 'textDocument/documentHighlight', this.posParams(model, position), null).then((r) =>
              r ? toMonacoHighlights(m, r) : [],
            ),
        }),
      )

    if (caps.signatureHelpProvider) {
      const sig = caps.signatureHelpProvider
      this.register((m) =>
        m.languages.registerSignatureHelpProvider(sel, {
          signatureHelpTriggerCharacters: sig.triggerCharacters,
          signatureHelpRetriggerCharacters: sig.retriggerCharacters,
          provideSignatureHelp: (model, position, token) =>
            this.ask(token, 'textDocument/signatureHelp', this.posParams(model, position), null).then((r) =>
              r ? { value: toMonacoSignatureHelp(r), dispose() {} } : null,
            ),
        }),
      )
    }

    if (caps.documentSymbolProvider)
      this.register((m) =>
        m.languages.registerDocumentSymbolProvider(sel, {
          provideDocumentSymbols: (model, token) =>
            this.ask(token, 'textDocument/documentSymbol', { textDocument: { uri: model.uri.toString() } }, null).then(
              (r) => (r ? toMonacoSymbols(r) : []),
            ),
        }),
      )

    if (caps.foldingRangeProvider)
      this.register((m) =>
        m.languages.registerFoldingRangeProvider(sel, {
          provideFoldingRanges: (model, _ctx, token) =>
            this.ask(token, 'textDocument/foldingRange', { textDocument: { uri: model.uri.toString() } }, null).then(
              (r) => (r ? toMonacoFoldingRanges(m, r) : []),
            ),
        }),
      )

    if (caps.renameProvider) {
      const prepare = typeof caps.renameProvider === 'object' && !!caps.renameProvider.prepareProvider
      this.register((m) =>
        m.languages.registerRenameProvider(sel, {
          provideRenameEdits: (model, position, newName, token) =>
            this.ask(token, 'textDocument/rename', { ...this.posParams(model, position), newName }, null).then((r) =>
              r ? toMonacoWorkspaceEdit(m, r) : { edits: [], rejectReason: 'The element cannot be renamed.' },
            ),
          resolveRenameLocation: prepare
            ? (model, position, token) =>
                this.ask(token, 'textDocument/prepareRename', this.posParams(model, position), null).then((r) =>
                  toMonacoRenameLocation(m, model, position, r),
                )
            : undefined,
        }),
      )
    }

    if (caps.codeActionProvider) {
      const resolve = typeof caps.codeActionProvider === 'object' && !!caps.codeActionProvider.resolveProvider
      this.register((m) =>
        m.languages.registerCodeActionProvider(sel, {
          provideCodeActions: (model, range, context, token) =>
            this.ask(
              token,
              'textDocument/codeAction',
              {
                textDocument: { uri: model.uri.toString() },
                range: toLspRange(range),
                context: {
                  diagnostics: toLspDiagnostics(m, context.markers),
                  ...(context.only ? { only: [context.only] } : {}),
                },
              },
              null,
            ).then((r) => ({ actions: r ? toMonacoCodeActions(m, r) : [], dispose() {} })),
          resolveCodeAction: resolve
            ? (action, token) =>
                this.ask(token, 'codeAction/resolve', getLspCodeAction(action) ?? { title: action.title }, null).then(
                  (r) => (r ? toMonacoCodeAction(m, r) : action),
                )
            : undefined,
        }),
      )
    }
  }

  /** Register hover provider backed by the LSP server */
  private registerHoverProvider() {
    const monaco = this.monaco
    if (!monaco) return
    this.binding.addDisposable(
      monaco.languages.registerHoverProvider(this.options.languageSelector, {
        provideHover: (model, position, token) =>
          withCancellation<any | null, null>(
            token,
            (p) =>
              this.binding.sendRequest(
                'textDocument/hover',
                {
                  textDocument: { uri: model.uri.toString() },
                  position: toLspPosition(position),
                },
                p,
              ),
            null,
          ).then((h) => (h ? lspHoverToMonaco(h) : null)),
      }),
    )
  }

  /** Register Monaco completion provider backed by the LSP server */
  private registerCompletionProvider(opts: CompletionOptions) {
    const monaco = this.monaco
    if (!monaco) return

    const resolveCompletionItem = opts.resolveProvider
      ? async (item: monaco.languages.CompletionItem, token: monaco.CancellationToken) =>
          withCancellation(token, async (p) =>
            this.binding.sendRequest('completionItem/resolve', toLspCompletionItem(item), p),
          ).then((r) => (r ? mergeResolvedCompletionItem(item, r) : item))
      : undefined

    const provideCompletionItems = (
      model: monaco.editor.ITextModel,
      position: monaco.Position,
      context: monaco.languages.CompletionContext,
      token: monaco.CancellationToken,
    ) =>
      withCancellation(token, async (p) => {
        const lspContext: CompletionContext = {
          // Monaco trigger kind is 0-based, LSP is 1-based
          triggerKind: (context.triggerKind + 1) as CompletionContext['triggerKind'],
          ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
        }
        return this.binding.sendRequest(
          'textDocument/completion',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
            context: lspContext,
          },
          p,
        )
      }).then((r) => {
        if (!r) return { suggestions: [] }
        const items: CompletionItem[] = Array.isArray(r) ? r : (r?.items ?? [])
        return { suggestions: items.map((x) => toMonacoCompletionItem(monaco, model, position, x)) }
      })

    this.binding.addDisposable(
      monaco.languages.registerCompletionItemProvider(this.options.languageSelector, {
        triggerCharacters: opts.triggerCharacters,
        provideCompletionItems,
        resolveCompletionItem,
      }),
    )
  }

  /** Register document formatting provider backed by the LSP server */
  private registerFormattingProvider() {
    const monaco = this.monaco
    if (!monaco) return
    this.binding.addDisposable(
      monaco.languages.registerDocumentFormattingEditProvider(this.options.languageSelector, {
        provideDocumentFormattingEdits: (model, options, token) =>
          withCancellation<TextEdit[] | null, []>(
            token,
            (p) =>
              this.binding.sendRequest(
                'textDocument/formatting',
                {
                  textDocument: { uri: model.uri.toString() },
                  options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
                },
                p,
              ),
            [],
          ).then((r) => (r ? toMonacoTextEdits(r) : [])),
      }),
    )
  }

  /** Register range formatting provider backed by the LSP server */
  private registerRangeFormattingProvider() {
    const monaco = this.monaco
    if (!monaco) return
    this.binding.addDisposable(
      monaco.languages.registerDocumentRangeFormattingEditProvider(this.options.languageSelector, {
        provideDocumentRangeFormattingEdits: (model, range, options, token) =>
          withCancellation<TextEdit[] | null, []>(
            token,
            (p) =>
              this.binding.sendRequest(
                'textDocument/rangeFormatting',
                {
                  textDocument: { uri: model.uri.toString() },
                  range: toLspRange(range),
                  options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
                },
                p,
              ),
            [],
          ).then((r) => (r ? toMonacoTextEdits(r) : [])),
      }),
    )
  }

  /** Register on-type formatting provider backed by the LSP server */
  private registerOnTypeFormattingProvider(opts: { firstTriggerCharacter: string; moreTriggerCharacter?: string[] }) {
    const monaco = this.monaco
    if (!monaco) return
    const triggers = [opts.firstTriggerCharacter, ...(opts.moreTriggerCharacter ?? [])]
    this.binding.addDisposable(
      monaco.languages.registerOnTypeFormattingEditProvider(this.options.languageSelector, {
        autoFormatTriggerCharacters: triggers,
        provideOnTypeFormattingEdits: (model, position, ch, options, token) =>
          withCancellation<TextEdit[] | null, []>(
            token,
            (p) =>
              this.binding.sendRequest(
                'textDocument/onTypeFormatting',
                {
                  textDocument: { uri: model.uri.toString() },
                  position: toLspPosition(position),
                  ch,
                  options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
                },
                p,
              ),
            [],
          ).then((r) => (r ? toMonacoTextEdits(r) : [])),
      }),
    )
  }

  // ---------------- Editor event handlers ----------------
  /** Send textDocument/didChange for the changed model according to server sync kind */
  private handleContentChange(model: monaco.editor.ITextModel, e: monaco.editor.IModelContentChangedEvent) {
    // Read uri/version from the model that actually changed (avoids editor-model races)
    const uri = model.uri.toString()
    const version = model.getVersionId()

    let contentChanges: Array<{ text: string; range?: Range }>
    if (this.syncKind === 1) {
      // Full: send entire text
      contentChanges = [{ text: model.getValue() }]
    } else if (this.syncKind === 2) {
      // Incremental: send ranged changes
      contentChanges = e.changes.map((c) => ({ range: toLspRange(c.range), text: c.text }))
    } else {
      // None/unknown: no-op
      return
    }

    this.binding.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges,
    })
  }

  /** Handle model open/close and send didOpen/didClose notifications */
  private handleModelChange(event: monaco.editor.IModelChangedEvent) {
    // Close old model if open
    if (event.oldModelUrl) {
      const oldUri = event.oldModelUrl.toString()
      if (this.openDocuments.has(oldUri)) {
        this.binding.sendNotification('textDocument/didClose', { textDocument: { uri: oldUri } })
        this.openDocuments.delete(oldUri)
        // Clear old model markers
        const monacoApi = this.monaco
        if (monacoApi) {
          const oldModel = monacoApi.editor.getModel(event.oldModelUrl)
          if (oldModel) monacoApi.editor.setModelMarkers(oldModel, this.MARKER_OWNER, [])
        }
      }
    }

    // Open new model
    const newModel = this.editor?.getModel()
    if (!newModel) return

    const newUri = newModel.uri.toString()

    // Avoid reopening same URI
    if (this.openDocuments.has(newUri)) return

    // Cleanup on model dispose
    this.binding.addDisposable(
      newModel.onWillDispose(() => {
        const uri = newModel.uri.toString()
        if (this.openDocuments.has(uri)) {
          this.binding.sendNotification('textDocument/didClose', { textDocument: { uri } })
          this.openDocuments.delete(uri)
        }
        // Clear markers on dispose
        const monacoApi = this.monaco
        if (monacoApi) monacoApi.editor.setModelMarkers(newModel, this.MARKER_OWNER, [])
      }),
    )

    // Send didOpen and track
    this.binding.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: newUri,
        languageId: newModel.getLanguageId(),
        version: newModel.getVersionId(),
        text: newModel.getValue(),
      },
    })
    this.openDocuments.add(newUri)

    // Stream changes for this specific model when the server requests sync
    if (this.syncChange) {
      this.binding.addDisposable(newModel.onDidChangeContent((e) => this.handleContentChange(newModel, e)))
    }
  }

  /** Listen for publishDiagnostics and update Monaco markers */
  private wireDiagnostics() {
    const monacoApi = this.monaco
    if (!monacoApi) return

    this.binding.onServerNotification('textDocument/publishDiagnostics', (params: any) => {
      try {
        const { uri, diagnostics, version } = params as {
          uri: string
          diagnostics: any[]
          version?: number
        }
        const model = monacoApi.editor.getModel(monacoApi.Uri.parse(uri))
        if (!model) return
        if (typeof version === 'number' && model.getVersionId() !== version) return
        const markers = toMonacoMarkers(monacoApi, diagnostics)
        monacoApi.editor.setModelMarkers(model, this.MARKER_OWNER, markers)
      } catch (e) {
        // Swallow diagnostics errors
      }
    })
  }

  private static CAPABILITIES: ClientCapabilities = {
    textDocument: {
      synchronization: {
        dynamicRegistration: false,
        willSave: false,
        willSaveWaitUntil: false,
        didSave: false,
      },
      completion: {
        dynamicRegistration: false,
        completionItem: {
          snippetSupport: true,
          commitCharactersSupport: true,
          documentationFormat: ['markdown', 'plaintext'],
          deprecatedSupport: true,
          preselectSupport: true,
          tagSupport: {
            valueSet: [1], // 1 = Deprecated
          },
          insertReplaceSupport: true,
          resolveSupport: {
            properties: ['documentation', 'detail', 'additionalTextEdits'],
          },
          insertTextModeSupport: {
            valueSet: [1, 2], // 1 = asIs, 2 = adjustIndentation
          },
          labelDetailsSupport: true,
        },
        completionItemKind: {
          valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
        },
        contextSupport: true,
      },
      hover: {
        dynamicRegistration: false,
        contentFormat: ['markdown', 'plaintext'],
      },
      signatureHelp: {
        dynamicRegistration: false,
        signatureInformation: {
          documentationFormat: ['markdown', 'plaintext'],
          parameterInformation: {
            labelOffsetSupport: true,
          },
          activeParameterSupport: true,
        },
        contextSupport: true,
      },
      declaration: {
        dynamicRegistration: false,
        linkSupport: true,
      },
      definition: {
        dynamicRegistration: false,
        linkSupport: true,
      },
      typeDefinition: {
        dynamicRegistration: false,
        linkSupport: true,
      },
      implementation: {
        dynamicRegistration: false,
        linkSupport: true,
      },
      references: {
        dynamicRegistration: false,
      },
      documentHighlight: {
        dynamicRegistration: false,
      },
      documentSymbol: {
        dynamicRegistration: false,
        symbolKind: {
          valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
        },
        hierarchicalDocumentSymbolSupport: true,
        tagSupport: {
          valueSet: [1], // 1 = Deprecated
        },
        labelSupport: true,
      },
      codeAction: {
        dynamicRegistration: false,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              '',
              'quickfix',
              'refactor',
              'refactor.extract',
              'refactor.inline',
              'refactor.rewrite',
              'source',
              'source.organizeImports',
            ],
          },
        },
        isPreferredSupport: true,
        disabledSupport: true,
        dataSupport: true,
        resolveSupport: {
          properties: ['edit'],
        },
        honorsChangeAnnotations: false,
      },
      codeLens: {
        dynamicRegistration: false,
      },
      formatting: {
        dynamicRegistration: false,
      },
      rangeFormatting: {
        dynamicRegistration: false,
      },
      onTypeFormatting: {
        dynamicRegistration: false,
      },
      rename: {
        dynamicRegistration: false,
        prepareSupport: true,
        prepareSupportDefaultBehavior: 1,
        honorsChangeAnnotations: false,
      },
      documentLink: {
        dynamicRegistration: false,
        tooltipSupport: true,
      },
      foldingRange: {
        dynamicRegistration: false,
        rangeLimit: 5000,
        lineFoldingOnly: true,
      },
      selectionRange: {
        dynamicRegistration: false,
      },
      publishDiagnostics: {
        relatedInformation: true,
        tagSupport: {
          valueSet: [1, 2], // 1 = Unnecessary, 2 = Deprecated
        },
        versionSupport: true,
        codeDescriptionSupport: true,
        dataSupport: true,
      },
    },
    workspace: {
      applyEdit: false,
      workspaceEdit: {
        documentChanges: false,
        resourceOperations: [],
        failureHandling: 'abort',
        normalizesLineEndings: false,
        changeAnnotationSupport: {
          groupsOnLabel: false,
        },
      },
      didChangeConfiguration: {
        dynamicRegistration: false,
      },
      didChangeWatchedFiles: {
        dynamicRegistration: false,
      },
      symbol: {
        dynamicRegistration: false,
        symbolKind: {
          valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
        },
        tagSupport: {
          valueSet: [1], // 1 = Deprecated
        },
      },
      executeCommand: {
        dynamicRegistration: false,
      },
      workspaceFolders: false,
      configuration: false,
      semanticTokens: {
        refreshSupport: false,
      },
      codeLens: {
        refreshSupport: false,
      },
      fileOperations: {
        dynamicRegistration: false,
        didCreate: false,
        didRename: false,
        didDelete: false,
        willCreate: false,
        willRename: false,
        willDelete: false,
      },
      inlineValue: {
        refreshSupport: false,
      },
      inlayHint: {
        refreshSupport: false,
      },
      diagnostics: {
        refreshSupport: false,
      },
    },
    window: {
      workDoneProgress: true,
      showMessage: {
        messageActionItem: {
          additionalPropertiesSupport: true,
        },
      },
      showDocument: {
        support: false,
      },
    },
    general: {
      regularExpressions: {
        engine: 'ECMAScript',
        version: 'ES2020',
      },
      markdown: {
        parser: 'marked',
        version: '1.0.0',
      },
    },
  }
}

const withCancellation = async <R, E = null>(
  token: monaco.CancellationToken,
  f: (p: { signal: AbortSignal }) => Promise<MaybeCancelled<R>>,
  cancelled: E = null as E,
) => {
  if (token.isCancellationRequested) return cancelled
  const controller = new AbortController()
  const off = token.onCancellationRequested(() => controller.abort())
  try {
    const result = await f({ signal: controller.signal })
    if (result.cancelled) return cancelled
    return result.result
  } catch (e) {
    return cancelled
  } finally {
    off.dispose()
  }
}
