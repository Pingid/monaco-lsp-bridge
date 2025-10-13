export enum LspErrorCode {
  // JSON-RPC predefined errors (-32700 to -32600)
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,

  // JSON-RPC reserved server error range (-32000 to -32099)
  ServerErrorBase = -32000,

  // LSP-specific errors (-32900 to -32800)
  RequestCancelled = -32800,
  ContentModified = -32801,
  ServerCancelled = -32802,

  // Client-local errors (positive codes to avoid reserved range conflicts)
  Timeout = 1001,
  Disposed = 1002,
}

export type LspErrorShape = { code: number; message: string; data?: unknown }

export class LspError extends Error {
  code: number
  data?: unknown
  constructor(shape: LspErrorShape) {
    super(shape.message)
    this.code = shape.code
    this.data = shape.data
    this.name = 'LspError'
  }
}

export const isCancellationError = (e: unknown) =>
  typeof e === 'object' &&
  e !== null &&
  'code' in (e as any) &&
  ((e as any).code === LspErrorCode.RequestCancelled || (e as any).code === LspErrorCode.ServerCancelled)

export const toLspError = (e: any): LspError => {
  if (e instanceof LspError) return e
  if (typeof e === 'string') return new LspError({ code: LspErrorCode.InternalError, message: e })
  return new LspError({
    code: Number(e?.code ?? LspErrorCode.InternalError),
    message: String(e?.message ?? 'Error'),
    data: e?.data,
  })
}
