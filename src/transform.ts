import type {
  CompletionItem,
  TextEdit,
  InsertReplaceEdit,
  Range,
  Position,
  Diagnostic,
  DiagnosticRelatedInformation,
  Hover,
  MarkupContent,
  MarkedString,
} from 'vscode-languageserver-protocol'
import type * as monaco from 'monaco-editor'

/** Store original LSP item on Monaco completion item */
const LSP_ITEM_KEY = Symbol.for('__lsp_completion_item__')

/** Convert LSP CompletionItem to Monaco and stash original */
export const toMonacoCompletionItem = (
  monacoApi: typeof monaco,
  item: CompletionItem,
): monaco.languages.CompletionItem => {
  const insertText = getInsertText(item)
  const range = toMonacoRange(item.textEdit)

  // Determine insert text format (snippet vs plain)
  const insertTextFormat = item.insertTextFormat ?? 1 // 1 = PlainText, 2 = Snippet
  const isSnippet = insertTextFormat === 2

  const result: any = {
    label: item.label,
    insertText,
    kind: item.kind ?? 0,
    detail: item.detail,
    documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
    sortText: item.sortText,
    filterText: item.filterText,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits?.map(toMonacoTextEdit),
    // Insert as snippet when requested
    insertTextRules: isSnippet ? monacoApi.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined, // 4 = InsertAsSnippet
  }

  // Set explicit range only when provided by LSP
  if (range !== undefined) {
    result.range = range
  }

  // Keep original for resolve
  result[LSP_ITEM_KEY] = item

  return result as monaco.languages.CompletionItem
}

/** Convert Monaco CompletionItem to LSP, preferring original */
export const toLspCompletionItem = (item: monaco.languages.CompletionItem): CompletionItem => {
  // Try to retrieve the original LSP item
  const originalItem = (item as any)[LSP_ITEM_KEY] as CompletionItem | undefined

  if (originalItem) {
    // Use original to preserve LSP fields
    return originalItem
  }

  // Fallback: convert Monaco item to LSP format
  const result: CompletionItem = {
    label: typeof item.label === 'string' ? item.label : item.label.label,
    kind: item.kind as any,
    detail: item.detail,
    documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
    sortText: item.sortText,
    filterText: item.filterText,
    insertText: typeof item.insertText === 'string' ? item.insertText : undefined,
    commitCharacters: item.commitCharacters,
  }

  return result
}

/** Merge resolved LSP fields into Monaco item */
export const mergeResolvedCompletionItem = (
  monacoItem: monaco.languages.CompletionItem,
  resolvedLspItem: CompletionItem,
): monaco.languages.CompletionItem => {
  // Merge fields that may be resolved
  const merged: monaco.languages.CompletionItem = {
    ...monacoItem,
    detail: resolvedLspItem.detail ?? monacoItem.detail,
    documentation:
      resolvedLspItem.documentation !== undefined
        ? typeof resolvedLspItem.documentation === 'string'
          ? resolvedLspItem.documentation
          : resolvedLspItem.documentation?.value
        : monacoItem.documentation,
    additionalTextEdits: resolvedLspItem.additionalTextEdits?.map(toMonacoTextEdit) ?? monacoItem.additionalTextEdits,
    command: resolvedLspItem.command
      ? {
          id: resolvedLspItem.command.command,
          title: resolvedLspItem.command.title,
          arguments: resolvedLspItem.command.arguments,
        }
      : monacoItem.command,
  }

  // Update insert text/range when textEdit provided
  if (resolvedLspItem.textEdit) {
    const insertText = getInsertText(resolvedLspItem)
    const range = toMonacoRange(resolvedLspItem.textEdit)
    merged.insertText = insertText
    if (range !== undefined) {
      merged.range = range
    }
  } else if (resolvedLspItem.insertText !== undefined) {
    // Handle resolve without textEdit
    merged.insertText = resolvedLspItem.insertText
  }

  // Update snippet rule if format changed
  if (resolvedLspItem.insertTextFormat !== undefined) {
    const isSnippet = resolvedLspItem.insertTextFormat === 2
    merged.insertTextRules = isSnippet ? 4 : undefined // 4 = InsertAsSnippet
  }

  // Store updated LSP item
  ;(merged as any)[LSP_ITEM_KEY] = resolvedLspItem

  return merged
}

/** Extract insert text: textEdit.newText → insertText → label */
const getInsertText = (item: CompletionItem): string => {
  if (item.textEdit && 'newText' in item.textEdit) {
    return item.textEdit.newText
  }
  return item.insertText ?? item.label
}

/** Convert LSP TextEdit to Monaco */
const toMonacoTextEdit = (edit: TextEdit): monaco.languages.TextEdit => {
  return {
    range: toMonacoIRange(edit.range),
    text: edit.newText,
  }
}

/** Convert LSP TextEdit/InsertReplaceEdit to Monaco range */
const toMonacoRange = (
  edit: TextEdit | InsertReplaceEdit | undefined,
): monaco.IRange | { insert: monaco.IRange; replace: monaco.IRange } | undefined => {
  if (!edit) return undefined

  if ('range' in edit) {
    return toMonacoIRange(edit.range)
  }

  return {
    insert: toMonacoIRange(edit.insert),
    replace: toMonacoIRange(edit.replace),
  }
}

/** Convert LSP Range to Monaco IRange (0-based → 1-based) */
const toMonacoIRange = (range: Range): monaco.IRange => {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

/** Convert Monaco IRange to LSP Range (1-based → 0-based) */
export const toLspRange = (range: monaco.IRange): Range => {
  return {
    start: {
      line: range.startLineNumber - 1,
      character: range.startColumn - 1,
    },
    end: {
      line: range.endLineNumber - 1,
      character: range.endColumn - 1,
    },
  }
}

/** Convert LSP Position to Monaco IPosition */
export const toMonacoPosition = (position: Position): monaco.IPosition => {
  return {
    lineNumber: position.line + 1,
    column: position.character + 1,
  }
}

/** Convert Monaco IPosition to LSP Position */
export const toLspPosition = (position: monaco.IPosition): Position => {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  }
}

/** Map LSP diagnostics to Monaco markers */
export const toMonacoMarkers = (monacoApi: typeof monaco, diagnostics: Diagnostic[]): monaco.editor.IMarkerData[] => {
  const toSeverity = (s: number | undefined): monaco.MarkerSeverity => {
    switch (s) {
      case 1:
        return monacoApi.MarkerSeverity.Error
      case 2:
        return monacoApi.MarkerSeverity.Warning
      case 3:
        return monacoApi.MarkerSeverity.Info
      case 4:
        return monacoApi.MarkerSeverity.Hint
      default:
        return monacoApi.MarkerSeverity.Info
    }
  }

  const toTags = (tags: readonly number[] | undefined): monaco.MarkerTag[] | undefined => {
    if (!tags || tags.length === 0) return undefined
    const mapped: monaco.MarkerTag[] = []
    for (const t of tags) {
      if (t === 1) mapped.push(monacoApi.MarkerTag.Unnecessary)
      if (t === 2) mapped.push(monacoApi.MarkerTag.Deprecated)
    }
    return mapped.length ? mapped : undefined
  }

  const toRelated = (
    infos: readonly DiagnosticRelatedInformation[] | undefined,
  ): monaco.editor.IRelatedInformation[] | undefined => {
    if (!infos || infos.length === 0) return undefined
    return infos.map((ri) => ({
      resource: monacoApi.Uri.parse(ri.location.uri),
      message: ri.message,
      startLineNumber: ri.location.range.start.line + 1,
      startColumn: ri.location.range.start.character + 1,
      endLineNumber: ri.location.range.end.line + 1,
      endColumn: ri.location.range.end.character + 1,
    }))
  }

  return diagnostics.map((d) => ({
    severity: toSeverity(d.severity),
    message: d.message,
    code: typeof d.code === 'string' ? d.code : typeof d.code === 'number' ? String(d.code) : undefined,
    source: d.source,
    tags: toTags(d.tags),
    relatedInformation: toRelated(d.relatedInformation),
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  }))
}

/** Map LSP TextEdits to Monaco edits */
export const toMonacoTextEdits = (edits: TextEdit[]): monaco.languages.TextEdit[] => {
  return edits.map((e) => ({
    range: toMonacoIRange(e.range),
    text: e.newText,
  }))
}

/** Convert LSP Hover to Monaco Hover */
export const lspHoverToMonaco = (hover: Hover): monaco.languages.Hover => {
  const contents: monaco.IMarkdownString[] = []

  const pushString = (value: string) => contents.push({ value })

  const pushMarked = (m: MarkedString): void => {
    if (typeof m === 'string') {
      pushString(m)
      return
    }
    // { language, value } → markdown code block
    const fenced = '```' + (m.language || '') + '\n' + m.value + '\n```'
    pushString(fenced)
  }

  const pushMarkup = (mc: MarkupContent) => {
    // kind: 'markdown' | 'plaintext'. For plaintext, keep as-is.
    pushString(mc.value)
  }

  const c = hover.contents as any
  if (Array.isArray(c)) {
    for (const item of c) pushMarked(item as MarkedString)
  } else if (typeof c === 'string' || (c && typeof c === 'object' && 'language' in c)) {
    pushMarked(c as MarkedString)
  } else if (c && typeof c === 'object' && 'kind' in c) {
    pushMarkup(c as MarkupContent)
  }

  const result: monaco.languages.Hover = {
    contents,
  }
  if (hover.range) result.range = toMonacoIRange(hover.range)
  return result
}
