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
} from 'vscode-languageserver-protocol'

import { LspErrorShape } from './error.js'

export const JSONRPC_VERSION = '2.0'
export type JSONRPC = typeof JSONRPC_VERSION

export type Id = number | string
export const isId = (id: unknown): id is Id => typeof id === 'number' || typeof id === 'string'

type RequestMapValue<P, R> = { fields: { params: P }; response: R }

// Requests (bidirectional, have responses)
export interface RequestMap {
  [InitializeRequest.method]: RequestMapValue<InitializeParams, InitializeResult>
  [CompletionResolveRequest.method]: RequestMapValue<CompletionItem, CompletionItem>
  [CompletionRequest.method]: RequestMapValue<CompletionParams, CompletionList | CompletionItem[] | null>
  [DocumentFormattingRequest.method]: RequestMapValue<DocumentFormattingParams, TextEdit[] | null>
  [DocumentRangeFormattingRequest.method]: RequestMapValue<DocumentRangeFormattingParams, TextEdit[] | null>
  [DocumentOnTypeFormattingRequest.method]: RequestMapValue<DocumentOnTypeFormattingParams, TextEdit[] | null>
  [HoverRequest.method]: RequestMapValue<HoverParams, Hover | null>
  shutdown: RequestMapValue<null, null>
}

// Client-to-server notifications (no response expected)
export interface ClientNotifMap {
  [DidOpenTextDocumentNotification.method]: RequestMapValue<DidOpenTextDocumentParams, void>
  [DidChangeTextDocumentNotification.method]: RequestMapValue<DidChangeTextDocumentParams, void>
  [DidCloseTextDocumentNotification.method]: RequestMapValue<DidCloseTextDocumentParams, void>
  '$/cancelRequest': RequestMapValue<{ id: Id }, void>
  exit: RequestMapValue<null, void>
}

// Server-to-client notifications (no response expected)
export interface ServerNotifMap {
  '$/progress': RequestMapValue<{ token: ProgressToken; value: any }, void>
  [PublishDiagnosticsNotification.method]: RequestMapValue<PublishDiagnosticsParams, void>
  [LogMessageNotification.method]: RequestMapValue<LogMessageParams, void>
}

export interface JsonRpcMessage {
  jsonrpc: JSONRPC
}

export interface JsonRpcRequest<K, T> extends JsonRpcMessage {
  id: Id
  params: T
  method: K
}

export type JsonRpcResponse<T> =
  | (JsonRpcMessage & { id: Id; result: T; error?: undefined })
  | (JsonRpcMessage & { id: Id; result?: undefined; error: LspErrorShape })

export interface JsonRpcNotification<K, T> extends JsonRpcMessage {
  method: K
  params: T
}

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

export const makeNotification = <K extends keyof ClientNotifMap>(
  method: K,
  params: ClientNotifMap[K]['fields']['params'],
): JsonRpcNotification<K, ClientNotifMap[K]['fields']['params']> => ({
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

export const isRpcMessage = (msg: unknown): msg is JsonRpcMessage => {
  if (typeof msg !== 'object' || msg === null) return false
  if (!('jsonrpc' in msg) || msg.jsonrpc !== JSONRPC_VERSION) return false
  return true
}

type RequestMapType = RequestMap & ClientNotifMap & ServerNotifMap
export const isRpcRequestType = <K extends keyof RequestMapType>(
  method: K,
  msg: unknown,
): msg is JsonRpcRequest<K, RequestMapType[K]['fields']['params']> => {
  if (!isRpcMessage(msg)) return false
  if ((msg as any).method !== method) return false
  return true
}

export const isRpcResponseType = <K extends keyof RequestMapType = keyof RequestMapType>(
  msg: unknown,
  method?: K,
): msg is JsonRpcResponse<RequestMapType[K]['response']> => {
  if (!isRpcMessage(msg)) return false
  if (!Object.prototype.hasOwnProperty.call(msg, 'id') || !isId((msg as any).id)) return false
  if (method && (msg as any).method !== method) return false
  return true
}
