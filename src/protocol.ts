import {
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
} from 'vscode-languageserver-protocol'

import { LspErrorShape } from './error.js'

export type Id = number | string
export const isId = (id: unknown): id is Id => typeof id === 'number' || typeof id === 'string'

// Requests (bidirectional, have responses)
export interface RequestMap {
  [InitializeRequest.method]: [InitializeParams, InitializeResult]
  [CompletionResolveRequest.method]: [CompletionItem, CompletionItem]
  [CompletionRequest.method]: [CompletionParams, CompletionList | CompletionItem[] | null]
  [DocumentFormattingRequest.method]: [DocumentFormattingParams, TextEdit[] | null]
  [DocumentRangeFormattingRequest.method]: [DocumentRangeFormattingParams, TextEdit[] | null]
  [DocumentOnTypeFormattingRequest.method]: [DocumentOnTypeFormattingParams, TextEdit[] | null]
  [HoverRequest.method]: [HoverParams, Hover | null]
  shutdown: [null, null]
}

// Client-to-server notifications (no response expected)
export interface ClientNotifMap {
  [DidOpenTextDocumentNotification.method]: [DidOpenTextDocumentParams, void]
  [DidChangeTextDocumentNotification.method]: [DidChangeTextDocumentParams, void]
  [DidCloseTextDocumentNotification.method]: [DidCloseTextDocumentParams, void]
  '$/cancelRequest': [{ id: Id }, void]
  exit: [null, void]
}

// Server-to-client notifications (no response expected)
export interface ServerNotifMap {
  '$/progress': [{ token: ProgressToken; value: any }, void]
  [PublishDiagnosticsNotification.method]: [PublishDiagnosticsParams, void]
  [LogMessageNotification.method]: [LogMessageParams, void]
}

export const JSONRPC_VERSION = '2.0'
type JSONRPC = typeof JSONRPC_VERSION

export type JsonRpcRequest<K, T> = {
  jsonrpc: JSONRPC
  id: Id
  params: T
  method: K
}

export type JsonRpcResponse<T> =
  | { jsonrpc: JSONRPC; id: Id; result: T; error?: undefined }
  | { jsonrpc: JSONRPC; id: Id; result?: undefined; error: LspErrorShape }

export type JsonRpcNotification<K, T> = {
  jsonrpc: JSONRPC
  method: K
  params: T
}

export const makeRequest = <K extends keyof RequestMap>(
  id: Id,
  method: K,
  params: RequestMap[K][0],
): JsonRpcRequest<K, RequestMap[K][0]> => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  method,
  params,
})

export const makeNotification = <K extends keyof ClientNotifMap>(
  method: K,
  params: ClientNotifMap[K][0],
): JsonRpcNotification<K, ClientNotifMap[K][0]> => ({
  jsonrpc: JSONRPC_VERSION,
  method,
  params,
})

export type ProgressPayload<T = any> = {
  token: ProgressToken
  value: T
}

export type WorkDoneProgressBegin = {
  kind: 'begin'
  title: string
  cancellable?: boolean
  message?: string
  percentage?: number
}

export type WorkDoneProgressReport = {
  kind: 'report'
  cancellable?: boolean
  message?: string
  percentage?: number
}

export type WorkDoneProgressEnd = {
  kind: 'end'
  message?: string
}
