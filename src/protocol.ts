import type {
  DidChangeTextDocumentNotification,
  DidChangeTextDocumentParams,
  DidCloseTextDocumentParams,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidOpenTextDocumentParams,
  CompletionRequest,
  CompletionParams,
  InitializeRequest,
  InitializeParams,
  InitializeResult,
  CompletionList,
  CompletionItem,
  CompletionResolveRequest,
  ProgressToken,
  PublishDiagnosticsNotification,
  PublishDiagnosticsParams,
  LogMessageNotification,
  LogMessageParams,
  DocumentFormattingRequest,
  DocumentFormattingParams,
  DocumentRangeFormattingRequest,
  DocumentRangeFormattingParams,
  DocumentOnTypeFormattingRequest,
  DocumentOnTypeFormattingParams,
  TextEdit,
  HoverRequest,
  HoverParams,
  Hover,
  DefinitionRequest,
  DefinitionParams,
  TypeDefinitionRequest,
  TypeDefinitionParams,
  ImplementationRequest,
  ImplementationParams,
  DeclarationRequest,
  DeclarationParams,
  ReferencesRequest,
  ReferenceParams,
  DocumentHighlightRequest,
  DocumentHighlightParams,
  DocumentHighlight,
  SignatureHelpRequest,
  SignatureHelpParams,
  SignatureHelp,
  DocumentSymbolRequest,
  DocumentSymbolParams,
  DocumentSymbol,
  SymbolInformation,
  FoldingRangeRequest,
  FoldingRangeParams,
  FoldingRange,
  PrepareRenameRequest,
  PrepareRenameParams,
  PrepareRenameResult,
  RenameRequest,
  RenameParams,
  WorkspaceEdit,
  CodeActionRequest,
  CodeActionParams,
  CodeActionResolveRequest,
  CodeAction,
  Command,
  Definition,
  Location,
  LocationLink,
} from 'vscode-languageserver-protocol'

import { LspErrorShape } from './error.js'

/** JSON-RPC protocol version this bridge speaks. */
export const JSONRPC_VERSION = '2.0'
/** Literal type of the JSON-RPC version string. */
export type JSONRPC = typeof JSONRPC_VERSION

/** A JSON-RPC request/response id. */
export type Id = number | string
/** Type guard for a JSON-RPC {@link Id} (number or string). */
export const isId = (id: unknown): id is Id => typeof id === 'number' || typeof id === 'string'

/** Pairs a method's request params with its response type. */
type RequestMapValue<P, R> = { fields: { params: P }; response: R }

/** Maps each supported request method to its params and response types. */
export interface RequestMap {
  /** Handshake: negotiate capabilities with the server. */
  [InitializeRequest.method]: RequestMapValue<InitializeParams, InitializeResult>
  /** Fill in lazy fields (docs, edits) for a completion item. */
  [CompletionResolveRequest.method]: RequestMapValue<CompletionItem, CompletionItem>
  /** Request completion suggestions at a position. */
  [CompletionRequest.method]: RequestMapValue<CompletionParams, CompletionList | CompletionItem[] | null>
  /** Format an entire document. */
  [DocumentFormattingRequest.method]: RequestMapValue<DocumentFormattingParams, TextEdit[] | null>
  /** Format a range of a document. */
  [DocumentRangeFormattingRequest.method]: RequestMapValue<DocumentRangeFormattingParams, TextEdit[] | null>
  /** Format while typing a trigger character. */
  [DocumentOnTypeFormattingRequest.method]: RequestMapValue<DocumentOnTypeFormattingParams, TextEdit[] | null>
  /** Hover information at a position. */
  [HoverRequest.method]: RequestMapValue<HoverParams, Hover | null>
  /** Go to definition. */
  [DefinitionRequest.method]: RequestMapValue<DefinitionParams, Definition | LocationLink[] | null>
  /** Go to type definition. */
  [TypeDefinitionRequest.method]: RequestMapValue<TypeDefinitionParams, Definition | LocationLink[] | null>
  /** Go to implementation. */
  [ImplementationRequest.method]: RequestMapValue<ImplementationParams, Definition | LocationLink[] | null>
  /** Go to declaration. */
  [DeclarationRequest.method]: RequestMapValue<DeclarationParams, Definition | LocationLink[] | null>
  /** Find all references to a symbol. */
  [ReferencesRequest.method]: RequestMapValue<ReferenceParams, Location[] | null>
  /** Highlight occurrences of a symbol in a document. */
  [DocumentHighlightRequest.method]: RequestMapValue<DocumentHighlightParams, DocumentHighlight[] | null>
  /** Signature/parameter hints at a position. */
  [SignatureHelpRequest.method]: RequestMapValue<SignatureHelpParams, SignatureHelp | null>
  /** List symbols in a document (hierarchical or flat). */
  [DocumentSymbolRequest.method]: RequestMapValue<DocumentSymbolParams, DocumentSymbol[] | SymbolInformation[] | null>
  /** Compute foldable ranges for a document. */
  [FoldingRangeRequest.method]: RequestMapValue<FoldingRangeParams, FoldingRange[] | null>
  /** Validate a rename and return its target range. */
  [PrepareRenameRequest.method]: RequestMapValue<PrepareRenameParams, PrepareRenameResult | null>
  /** Compute edits for renaming a symbol. */
  [RenameRequest.method]: RequestMapValue<RenameParams, WorkspaceEdit | null>
  /** Provide code actions (quick fixes, refactors) for a range. */
  [CodeActionRequest.method]: RequestMapValue<CodeActionParams, (Command | CodeAction)[] | null>
  /** Fill in lazy fields (edits) for a code action. */
  [CodeActionResolveRequest.method]: RequestMapValue<CodeAction, CodeAction>
  /** Ask the server to shut down gracefully. */
  shutdown: RequestMapValue<null, null>
}

/** Maps each client-to-server notification method to its params (no response). */
export interface ClientNotifMap {
  /** Notify the server a document was opened. */
  [DidOpenTextDocumentNotification.method]: RequestMapValue<DidOpenTextDocumentParams, void>
  /** Notify the server a document changed. */
  [DidChangeTextDocumentNotification.method]: RequestMapValue<DidChangeTextDocumentParams, void>
  /** Notify the server a document was closed. */
  [DidCloseTextDocumentNotification.method]: RequestMapValue<DidCloseTextDocumentParams, void>
  /** Cancel an in-flight request by id. */
  '$/cancelRequest': RequestMapValue<{ id: Id }, void>
  /** Tell the server to exit after shutdown. */
  exit: RequestMapValue<null, void>
}

/** Maps each server-to-client notification method to its params (no response). */
export interface ServerNotifMap {
  /** Work-done or partial-result progress keyed by token. */
  '$/progress': RequestMapValue<{ token: ProgressToken; value: any }, void>
  /** Diagnostics published for a document. */
  [PublishDiagnosticsNotification.method]: RequestMapValue<PublishDiagnosticsParams, void>
  /** Log message emitted by the server. */
  [LogMessageNotification.method]: RequestMapValue<LogMessageParams, void>
}

/** Base for every JSON-RPC frame. */
export interface JsonRpcMessage {
  /** Always the JSON-RPC version string. */
  jsonrpc: JSONRPC
}

/** A JSON-RPC request: a method call awaiting a response. */
export interface JsonRpcRequest<K, T> extends JsonRpcMessage {
  /** Correlates the request with its response. */
  id: Id
  /** Method parameters. */
  params: T
  /** Method name. */
  method: K
}

/** A JSON-RPC response: either a `result` or an `error`, keyed by `id`. */
export type JsonRpcResponse<T> =
  | (JsonRpcMessage & { id: Id; result: T; error?: undefined })
  | (JsonRpcMessage & { id: Id; result?: undefined; error: LspErrorShape })

/** A JSON-RPC notification: a fire-and-forget message with no response. */
export interface JsonRpcNotification<K, T> extends JsonRpcMessage {
  /** Method name. */
  method: K
  /** Method parameters. */
  params: T
}

/** Build a typed JSON-RPC request frame. */
export const makeRequest = <K extends keyof RequestMap>(
  id: Id,
  method: K,
  params: RequestMap[K]['fields']['params'],
): JsonRpcRequest<K, RequestMap[K]['fields']['params']> => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  method,
  params,
})

/** Build a typed JSON-RPC notification frame. */
export const makeNotification = <K extends keyof ClientNotifMap>(
  method: K,
  params: ClientNotifMap[K]['fields']['params'],
): JsonRpcNotification<K, ClientNotifMap[K]['fields']['params']> => ({
  jsonrpc: JSONRPC_VERSION,
  method,
  params,
})

/** Payload of a `$/progress` notification: a token plus its progress value. */
export type ProgressPayload<T = any> = {
  /** Token identifying the operation this progress belongs to. */
  token: ProgressToken
  /** Progress value (often a {@link WorkDoneProgressBegin}/`Report`/`End`). */
  value: T
}

/** Start of a work-done progress sequence. */
export type WorkDoneProgressBegin = {
  /** Discriminant marking the begin event. */
  kind: 'begin'
  /** Short title shown to the user. */
  title: string
  /** Whether the operation can be cancelled. */
  cancellable?: boolean
  /** Optional detail message. */
  message?: string
  /** Optional completion percentage (0-100). */
  percentage?: number
}

/** Intermediate update within a work-done progress sequence. */
export type WorkDoneProgressReport = {
  /** Discriminant marking a report event. */
  kind: 'report'
  /** Whether the operation can be cancelled. */
  cancellable?: boolean
  /** Optional detail message. */
  message?: string
  /** Optional completion percentage (0-100). */
  percentage?: number
}

/** End of a work-done progress sequence. */
export type WorkDoneProgressEnd = {
  /** Discriminant marking the end event. */
  kind: 'end'
  /** Optional final message. */
  message?: string
}

/** Type guard for a well-formed JSON-RPC 2.0 message. */
export const isRpcMessage = (msg: unknown): msg is JsonRpcMessage => {
  if (typeof msg !== 'object' || msg === null) return false
  if (!('jsonrpc' in msg) || msg.jsonrpc !== JSONRPC_VERSION) return false
  return true
}

/** Union of all known request and notification method maps. */
type RequestMapType = RequestMap & ClientNotifMap & ServerNotifMap
/** Type guard narrowing a message to a specific request/notification method. */
export const isRpcRequestType = <K extends keyof RequestMapType>(
  method: K,
  msg: unknown,
): msg is JsonRpcRequest<K, RequestMapType[K]['fields']['params']> => {
  if (!isRpcMessage(msg)) return false
  if ((msg as any).method !== method) return false
  return true
}

/** Type guard for a response frame, optionally matching a specific method. */
export const isRpcResponseType = <K extends keyof RequestMapType = keyof RequestMapType>(
  msg: unknown,
  method?: K,
): msg is JsonRpcResponse<RequestMapType[K]['response']> => {
  if (!isRpcMessage(msg)) return false
  if (!Object.prototype.hasOwnProperty.call(msg, 'id') || !isId((msg as any).id)) return false
  if (method && (msg as any).method !== method) return false
  return true
}
