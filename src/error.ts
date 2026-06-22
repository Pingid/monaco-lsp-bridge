/** JSON-RPC, LSP, and client-local error codes used across the bridge. */
export enum LspErrorCode {
  // JSON-RPC predefined errors (-32700 to -32600)
  /** Invalid JSON was received. */
  ParseError = -32700,
  /** The JSON sent is not a valid request object. */
  InvalidRequest = -32600,
  /** The requested method does not exist or is unavailable. */
  MethodNotFound = -32601,
  /** Invalid method parameters. */
  InvalidParams = -32602,
  /** Internal JSON-RPC error. */
  InternalError = -32603,

  // JSON-RPC reserved server error range (-32000 to -32099)
  /** Start of the reserved implementation-defined server error range. */
  ServerErrorBase = -32000,

  // LSP-specific errors (-32900 to -32800)
  /** The request was cancelled by the client. */
  RequestCancelled = -32800,
  /** Content changed and the result is no longer valid. */
  ContentModified = -32801,
  /** The request was cancelled by the server. */
  ServerCancelled = -32802,

  // Client-local errors (positive codes to avoid reserved range conflicts)
  /** No response arrived before the request timeout (client-local). */
  Timeout = 1001,
  /** The transport was disposed before a response arrived (client-local). */
  Disposed = 1002,
}

/** Plain serializable shape of a JSON-RPC error object. */
export type LspErrorShape = {
  /** Numeric error code; see {@link LspErrorCode}. */
  code: number
  /** Human-readable error message. */
  message: string
  /** Optional structured payload attached by the server. */
  data?: unknown
}

/** Error class wrapping a JSON-RPC/LSP failure with its code and data. */
export class LspError extends Error {
  /** Numeric error code; see {@link LspErrorCode}. */
  code: number
  /** Optional structured payload attached by the server. */
  data?: unknown
  constructor(shape: LspErrorShape) {
    super(shape.message)
    this.code = shape.code
    this.data = shape.data
    this.name = 'LspError'
  }
}

/** True when an error is a client- or server-initiated cancellation. */
export const isCancellationError = (e: unknown) =>
  typeof e === 'object' &&
  e !== null &&
  'code' in (e as any) &&
  ((e as any).code === LspErrorCode.RequestCancelled || (e as any).code === LspErrorCode.ServerCancelled)

/** Normalize any thrown value or error-response object into an {@link LspError}. */
export const toLspError = (e: any): LspError => {
  if (e instanceof LspError) return e
  if (typeof e === 'string') return new LspError({ code: LspErrorCode.InternalError, message: e })
  return new LspError({
    code: Number(e?.code ?? LspErrorCode.InternalError),
    message: String(e?.message ?? 'Error'),
    data: e?.data,
  })
}
