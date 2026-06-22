import type { ProgressToken } from 'vscode-languageserver-protocol'
import type * as monaco from 'monaco-editor'

import {
  makeRequest,
  makeNotification,
  JsonRpcRequest,
  RequestMap,
  ClientNotifMap,
  ServerNotifMap,
  JsonRpcResponse,
  JsonRpcNotification,
  ProgressPayload,
  isRpcMessage,
  isRpcRequestType,
  isRpcResponseType,
  isId,
  Id,
  JSONRPC_VERSION,
} from './protocol.js'
import { LspError, LspErrorCode, toLspError, isCancellationError } from './error.js'

/** Default replies for common server-to-client requests, to avoid stalling the server */
const SERVER_REQUEST_DEFAULTS: Record<string, (params: any) => unknown> = {
  'workspace/configuration': (params) => (params?.items ?? []).map(() => null),
  'client/registerCapability': () => null,
  'client/unregisterCapability': () => null,
  'window/workDoneProgress/create': () => null,
  'window/showMessageRequest': () => null,
  'workspace/applyEdit': () => ({ applied: false }),
}

/** Either a raw message port (e.g. a Worker) or an already-built transport. */
export type Transport = PostMessagePort | LspTransport

/** Minimal Worker/MessagePort-like surface the transport can drive. */
export interface PostMessagePort {
  /** Send a message to the other end. */
  postMessage(message: any): void
  /** Subscribe to incoming messages. */
  addEventListener(type: 'message', listener: (event: { data: any }) => void): void
  /** Unsubscribe a previously added listener. */
  removeEventListener(type: 'message', listener: (event: { data: any }) => void): void
}

/** A teardown function returned by subscriptions. */
type Disposable = () => void

/** Result marker for a request that was cancelled rather than completed. */
export type Cancelled = {
  /** Always true; discriminates from a successful result. */
  cancelled: true
  /** Which side initiated the cancellation. */
  code: LspErrorCode.RequestCancelled | LspErrorCode.ServerCancelled
}

/** A request outcome: either a result or a {@link Cancelled} marker. */
export type MaybeCancelled<T> = { cancelled: false; result: T } | Cancelled

/** Callback receiving work-done progress values. */
export type ProgressHandler<T = any> = (value: T) => void
/** Callback receiving streamed partial results. */
export type PartialResultHandler<T = any> = (partialResult: T) => void

/**
 * JSON-RPC transport over a message port (Web Worker, MessagePort, etc.).
 *
 * Handles request/response correlation, timeouts, cancellation via
 * `AbortSignal`, `$/progress` routing, and replies to server-to-client
 * requests. Notifications and responses fan out to subscribers.
 *
 * @example
 * ```ts
 * const worker = new Worker(new URL('./server.worker.js', import.meta.url), { type: 'module' })
 * const transport = LspTransport.fromPort(worker)
 *
 * const res = await transport.sendRequest('initialize', { capabilities: {} } as any)
 * if (!res.cancelled) console.log(res.result.capabilities)
 *
 * transport.onServerNotification('textDocument/publishDiagnostics', (p) => console.log(p))
 * // later: transport.dispose()
 * ```
 */
export class LspTransport {
  /** Monotonic counter for request ids. */
  private nextId = 1
  /** Monotonic counter for generated progress tokens. */
  private nextTokenId = 1
  /** Teardown functions run on {@link dispose}. */
  private disposables: Set<Disposable> = new Set()

  /** In-flight requests awaiting handling. */
  private pending = new Map<Id, JsonRpcRequest<keyof RequestMap, any>>()

  /** Pending timeout timers keyed by request id. */
  private timeouts = new Map<Id, ReturnType<typeof setTimeout>>()
  /** Reject callbacks so {@link dispose} can fail in-flight requests. */
  private rejectors = new Map<Id, (err: LspError) => void>()

  /** Generic subscribers fed every inbound frame. */
  private subs = new Set<(message: any) => void>()
  /** Per-id response resolvers for {@link sendRequest}. */
  private waiters = new Map<Id, (res: JsonRpcResponse<any>) => void>()

  /** Progress callbacks keyed by token (work-done and partial results). */
  private progressCallbacks = new Map<ProgressToken, ProgressHandler>()

  /** Handlers for server-to-client requests (override {@link SERVER_REQUEST_DEFAULTS}). */
  private serverRequestHandlers = new Map<string, (params: any) => unknown | Promise<unknown>>()

  /** Construct a binding over a sender/receiver transport */
  constructor(
    private readonly sender: (
      message: JsonRpcRequest<keyof RequestMap, any> | JsonRpcNotification<any, any> | Array<any>,
    ) => void,
    private readonly receiver: (cb: (message: any) => void) => Disposable,
    private readonly defaultTimeoutMs: number = 15_000,
  ) {
    // One receiver to rule them all — handles single or batch frames.
    const unbind = this.receiver((raw) => this.ingest(raw))
    this.disposables.add(unbind)
  }

  // ---------------- Constructors ----------------
  /** Create a binding from a Worker-like endpoint */
  static fromPort(worker: PostMessagePort): LspTransport {
    const sender = (message: any) => worker.postMessage(message)
    const receiver = (cb: (message: any) => void) => {
      const handler = (e: { data: any }) => cb(e.data)
      worker.addEventListener('message', handler)
      return () => worker.removeEventListener('message', handler)
    }
    return new LspTransport(sender, receiver)
  }

  /** Infer a binding from either a worker or an existing binding */
  static infer(endpoint: Transport): LspTransport {
    return endpoint instanceof LspTransport ? endpoint : LspTransport.fromPort(endpoint)
  }

  // -------- Helpers
  /** Track a Monaco disposable for cleanup */
  addDisposable(d: monaco.IDisposable) {
    this.disposables.add(() => d.dispose())
    return this
  }

  /** Listen for error responses and forward normalized errors */
  onError(cb: (error: LspError) => void) {
    const onMessage = (res: JsonRpcResponse<any>) => {
      if (res?.error) cb(toLspError(res.error))
    }
    this.disposables.add(this.subscribe(onMessage))
    return this
  }

  /** Register a progress callback for a specific token */
  onProgress(token: ProgressToken, callback: ProgressHandler): Disposable {
    this.progressCallbacks.set(token, callback)
    return () => this.progressCallbacks.delete(token)
  }

  /** Register a callback for all $/progress notifications */
  onProgressNotification(callback: (params: ProgressPayload) => void) {
    const onMessage = (msg: any) => {
      if (msg?.method !== '$/progress') return
      if (msg.params) callback(msg.params)
    }
    this.disposables.add(this.subscribe(onMessage))
    return this
  }

  /** Register a handler that replies to a server-to-client request method */
  onServerRequest(method: string, handler: (params: any) => unknown | Promise<unknown>): Disposable {
    this.serverRequestHandlers.set(method, handler)
    return () => this.serverRequestHandlers.delete(method)
  }

  /** Listen for a specific server notification method */
  onServerNotification<K extends keyof ServerNotifMap>(
    method: K,
    cb: (params: ServerNotifMap[K]['fields']['params']) => void,
  ) {
    const onMessage = (msg: any) => {
      if (msg?.method !== method) return
      cb(msg.params as ServerNotifMap[K]['fields']['params'])
    }
    this.disposables.add(this.subscribe(onMessage))
    return this
  }

  /** Dispose all resources and reject in-flight requests */
  dispose() {
    for (const rej of this.rejectors.values()) {
      try {
        rej(new LspError({ code: LspErrorCode.Disposed, message: 'Binding disposed before response' }))
      } catch {}
    }
    this.rejectors.clear()

    for (const t of this.timeouts.values()) clearTimeout(t)
    this.timeouts.clear()

    this.disposables.forEach((d) => d())
    this.disposables.clear()
    this.pending.clear()
    this.waiters.clear()
    this.subs.clear()
    this.progressCallbacks.clear()
    this.serverRequestHandlers.clear()
  }

  // -------- Core API

  /** Send a client-to-server notification (no response expected) */
  sendNotification<K extends keyof ClientNotifMap>(method: K, params: ClientNotifMap[K]['fields']['params']) {
    this.sender(makeNotification(method, params))
    return this
  }

  /** Send an async request with timeout, cancellation and progress support */
  sendRequest<K extends keyof RequestMap>(
    method: K,
    params: RequestMap[K]['fields']['params'],
    opts?: {
      timeoutMs?: number
      signal?: AbortSignal
      workDoneToken?: ProgressToken
      partialResultToken?: ProgressToken
      onProgress?: ProgressHandler
      onPartialResult?: PartialResultHandler
    },
  ): Promise<MaybeCancelled<RequestMap[K]['response']>> {
    const id = this.nextId++

    // Generate tokens if callbacks provided but tokens not specified
    const workDoneToken = opts?.workDoneToken ?? (opts?.onProgress ? `work-${this.nextTokenId++}` : undefined)
    const partialResultToken =
      opts?.partialResultToken ?? (opts?.onPartialResult ? `partial-${this.nextTokenId++}` : undefined)

    // Augment params with tokens if provided
    const augmentedParams: any = { ...params }
    if (workDoneToken !== undefined) {
      augmentedParams.workDoneToken = workDoneToken
    }
    if (partialResultToken !== undefined) {
      augmentedParams.partialResultToken = partialResultToken
    }

    const m = makeRequest(id, method, augmentedParams)

    if (opts?.signal?.aborted) {
      return Promise.resolve({ cancelled: true as const, code: LspErrorCode.RequestCancelled })
    }

    // Register progress callbacks if provided
    // Both work done progress and partial results use $/progress notifications
    if (workDoneToken !== undefined && opts?.onProgress) {
      this.progressCallbacks.set(workDoneToken, opts.onProgress)
    }
    if (partialResultToken !== undefined && opts?.onPartialResult) {
      this.progressCallbacks.set(partialResultToken, opts.onPartialResult)
    }

    this.sender(m)

    return new Promise<MaybeCancelled<RequestMap[K]['response']>>((resolve, reject) => {
      const resolveCancelled = (code: LspErrorCode.RequestCancelled | LspErrorCode.ServerCancelled) => {
        cleanup()
        resolve({ cancelled: true, code })
      }
      const rejectAs = (err: LspError) => {
        cleanup()
        reject(err)
      }

      const onResponse = (res: JsonRpcResponse<any>) => {
        if (res?.id !== id) return
        if (res.error) {
          const err = toLspError(res.error)
          if (isCancellationError(err)) return resolveCancelled(err.code as any)
          return rejectAs(err)
        }
        cleanup()
        resolve({ cancelled: false, result: res.result })
      }

      // route by id via central dispatcher
      this.waiters.set(id, onResponse)

      const cleanup = () => {
        this.waiters.delete(id)
        const t = this.timeouts.get(id)
        if (t) clearTimeout(t)
        this.timeouts.delete(id)
        this.rejectors.delete(id)
        // Clean up progress callbacks (on completion, cancellation, or error)
        // Per LSP spec: workDoneToken is only valid until response/cancellation
        if (workDoneToken !== undefined) {
          this.progressCallbacks.delete(workDoneToken)
        }
        if (partialResultToken !== undefined) {
          this.progressCallbacks.delete(partialResultToken)
        }
        if (abortCleanup) opts?.signal?.removeEventListener('abort', abortCleanup)
      }

      // Timeout
      const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        const t = setTimeout(() => {
          rejectAs(
            new LspError({
              code: LspErrorCode.Timeout,
              message: `Request timed out: ${String(method)} (${id}) after ${timeoutMs}ms`,
            }),
          )
        }, timeoutMs)
        this.timeouts.set(id, t)
      }

      // Allow dispose() to reject in-flight requests
      this.rejectors.set(id, rejectAs)

      // AbortSignal → send $/cancelRequest and resolve immediately (eager cancel)
      // Don't wait for server response - some servers don't echo promptly
      let abortCleanup: (() => void) | undefined
      if (opts?.signal) {
        const onAbort = () => {
          // Notify server of cancellation (best effort)
          this.sendNotification('$/cancelRequest', { id })
          // Resolve immediately for better UX (don't wait for server acknowledgement)
          resolveCancelled(LspErrorCode.RequestCancelled)
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
        abortCleanup = () => opts.signal?.removeEventListener('abort', onAbort)
      }
    })
  }

  /** Subscribe to all inbound JSON-RPC messages */
  private subscribe(cb: (message: any) => void): Disposable {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  /** Send a JSON-RPC response frame for a server-to-client request */
  private sendResponse(id: Id, body: { result: unknown } | { error: LspError }) {
    const frame =
      'error' in body
        ? {
            jsonrpc: JSONRPC_VERSION,
            id,
            error: { code: body.error.code, message: body.error.message, data: body.error.data },
          }
        : { jsonrpc: JSONRPC_VERSION, id, result: body.result }
    this.sender(frame as any)
  }

  /** Reply to a server-to-client request using a registered handler or a safe default */
  private handleServerRequest = async (req: { id: Id; method: string; params: any }) => {
    const handler = this.serverRequestHandlers.get(req.method) ?? SERVER_REQUEST_DEFAULTS[req.method]
    if (!handler) {
      return this.sendResponse(req.id, {
        error: new LspError({ code: LspErrorCode.MethodNotFound, message: `Unhandled server request: ${req.method}` }),
      })
    }
    try {
      this.sendResponse(req.id, { result: await handler(req.params) })
    } catch (e) {
      this.sendResponse(req.id, { error: toLspError(e) })
    }
  }

  /** Ingest an incoming frame and dispatch to listeners/waiters */
  private ingest = (raw: any) => {
    // Batch: process each frame independently
    if (Array.isArray(raw)) {
      for (const frame of raw) this.ingest(frame)
      return
    }

    // Early drop anything that isn't a proper JSON-RPC 2.0 message
    if (!isRpcMessage(raw)) return

    // Server-to-client request: has both an id and a method. Reply so the server doesn't stall.
    if (isId((raw as any).id) && typeof (raw as any).method === 'string') {
      this.handleServerRequest(raw as any)
      return
    }

    // Handle $/progress notifications
    if (isRpcRequestType('$/progress', raw)) {
      const params = raw.params
      const callback = this.progressCallbacks.get(params.token)
      if (callback) {
        try {
          callback(params.value)
        } catch {}

        // Auto-remove workDoneToken callbacks when receiving WorkDoneProgressEnd
        if (params.value && typeof params.value === 'object' && params.value.kind === 'end') {
          this.progressCallbacks.delete(params.token)
        }
      }
      // Still fan out to subscribers for withProgress handlers
    }

    // If it's a response with an id and a waiting promise, resolve that first
    if (isRpcResponseType(raw)) {
      const waiter = this.waiters.get(raw.id)
      if (waiter) {
        // Claim and stop propagation to generic handlers
        this.waiters.delete(raw.id)
        try {
          waiter(raw)
        } catch {}
      }
    }

    // Fan-out to generic subscribers (e.g. withHandlers / withError / withProgress)
    for (const cb of Array.from(this.subs)) {
      try {
        cb(raw)
      } catch {}
    }
  }
}
