import type { ProgressToken } from 'vscode-languageserver-protocol'
import type * as monaco from 'monaco-editor'

import {
  JSONRPC_VERSION,
  makeRequest,
  makeNotification,
  JsonRpcRequest,
  RequestMap,
  ClientNotifMap,
  ServerNotifMap,
  JsonRpcResponse,
  JsonRpcNotification,
  ProgressPayload,
  Id,
  isId,
} from './protocol.js'
import { LspError, LspErrorCode, toLspError, isCancellationError } from './error.js'

export type Transport = PostMessagePort | LspTransport

export interface PostMessagePort {
  postMessage(message: any): void
  addEventListener(type: 'message', listener: (event: { data: any }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: any }) => void): void
}

type Disposable = () => void

export type Cancelled = {
  cancelled: true
  code: LspErrorCode.RequestCancelled | LspErrorCode.ServerCancelled
}

export type MaybeCancelled<T> = { cancelled: false; result: T } | Cancelled

export type ProgressHandler<T = any> = (value: T) => void
export type PartialResultHandler<T = any> = (partialResult: T) => void

export class LspTransport {
  private nextId = 1
  private nextTokenId = 1
  private disposables: Set<Disposable> = new Set()

  // Fire-and-forget requests handled by withHandlers()
  private pending = new Map<Id, JsonRpcRequest<keyof RequestMap, any>>()

  // Async bookkeeping
  private timeouts = new Map<Id, ReturnType<typeof setTimeout>>()
  private rejectors = new Map<Id, (err: LspError) => void>()

  // Central dispatcher: subscribers + per-id waiters (for sendAsync)
  private subs = new Set<(message: any) => void>()
  private waiters = new Map<Id, (res: JsonRpcResponse<any>) => void>()

  // Progress tracking (both work done progress and partial results use $/progress)
  private progressCallbacks = new Map<ProgressToken, ProgressHandler>()

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
  static fromWorker(worker: PostMessagePort): LspTransport {
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
    return endpoint instanceof LspTransport ? endpoint : LspTransport.fromWorker(endpoint)
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
      if (res?.jsonrpc !== JSONRPC_VERSION) return
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
      if (msg?.jsonrpc !== JSONRPC_VERSION || msg?.method !== '$/progress') return
      if (msg.params) callback(msg.params)
    }
    this.disposables.add(this.subscribe(onMessage))
    return this
  }

  /** Listen for a specific server notification method */
  onServerNotification<K extends keyof ServerNotifMap>(method: K, cb: (params: ServerNotifMap[K][0]) => void) {
    const onMessage = (msg: any) => {
      if (msg?.jsonrpc !== JSONRPC_VERSION || msg?.method !== method) return
      cb(msg.params as ServerNotifMap[K][0])
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
  }

  // -------- Core API

  /** Send a client-to-server notification (no response expected) */
  sendNotification<K extends keyof ClientNotifMap>(method: K, params: ClientNotifMap[K][0]) {
    this.sender(makeNotification(method, params))
    return this
  }

  /** Send an async request with timeout, cancellation and progress support */
  sendRequest<K extends keyof RequestMap>(
    method: K,
    params: RequestMap[K][0],
    opts?: {
      timeoutMs?: number
      signal?: AbortSignal
      workDoneToken?: ProgressToken
      partialResultToken?: ProgressToken
      onProgress?: ProgressHandler
      onPartialResult?: PartialResultHandler
    },
  ): Promise<MaybeCancelled<RequestMap[K][1]>> {
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

    return new Promise<MaybeCancelled<RequestMap[K][1]>>((resolve, reject) => {
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

  /** Ingest an incoming frame and dispatch to listeners/waiters */
  private ingest = (raw: any) => {
    // Batch: process each frame independently
    if (Array.isArray(raw)) {
      for (const frame of raw) this.ingest(frame)
      return
    }

    // Early drop anything that isn't a proper JSON-RPC 2.0 message
    if (!raw || typeof raw !== 'object' || raw.jsonrpc !== JSONRPC_VERSION) return

    // Handle $/progress notifications
    if (raw.method === '$/progress' && raw.params) {
      const params = raw.params as ProgressPayload
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
    if (Object.prototype.hasOwnProperty.call(raw, 'id')) {
      const id = raw.id as Id
      if (isId(id)) {
        const waiter = this.waiters.get(id)
        if (waiter) {
          // Claim and stop propagation to generic handlers
          this.waiters.delete(id)
          try {
            waiter(raw)
          } catch {}
          return
        }
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
