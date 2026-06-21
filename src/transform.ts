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
  Definition,
  Location,
  LocationLink,
  DocumentHighlight,
  SignatureHelp,
  DocumentSymbol,
  SymbolInformation,
  FoldingRange,
  WorkspaceEdit,
  PrepareRenameResult,
  CodeAction,
  Command,
} from 'vscode-languageserver-protocol'
import type * as monaco from 'monaco-editor'

/** Store original LSP item on Monaco completion item */
const LSP_ITEM_KEY = Symbol.for('__lsp_completion_item__')

/** Convert LSP CompletionItem to Monaco and stash original */
export const toMonacoCompletionItem = (
  monacoApi: typeof monaco,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  item: CompletionItem,
): monaco.languages.CompletionItem => {
  const insertText = getInsertText(item)
  const isSnippet = (item.insertTextFormat ?? 1) === 2

  // If LSP provided a textEdit range, convert it (support insert/replace if you have both)
  const lspRange = toMonacoRange(item.textEdit) // return IRange or {insert, replace} | undefined

  // Fallback range must contain `position`
  const word = model.getWordUntilPosition(position)
  const fallbackRange = new monacoApi.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column)

  const result: monaco.languages.CompletionItem = {
    label: item.label,
    insertText,
    kind: item.kind ?? 0,
    detail: item.detail,
    documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
    sortText: item.sortText,
    filterText: item.filterText,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits?.map(toMonacoTextEdit),
    insertTextRules: isSnippet ? monacoApi.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range: lspRange ?? fallbackRange,
  }

  ;(result as any)[LSP_ITEM_KEY] = item
  return result
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

  // LSP >=3.18 allows MarkupContent messages; Monaco markers only take strings
  const toMessage = (msg: string | { value: string }): string => (typeof msg === 'string' ? msg : msg.value)

  return diagnostics.map((d) => ({
    severity: toSeverity(d.severity),
    message: toMessage(d.message),
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

/** Convert LSP markup/string to a Monaco markdown string */
const toMonacoMarkup = (doc: string | MarkupContent | undefined): string | monaco.IMarkdownString | undefined =>
  doc === undefined ? undefined : typeof doc === 'string' ? doc : { value: doc.value }

// ---------------- Navigation ----------------

const isLocationLink = (l: Location | LocationLink): l is LocationLink => 'targetUri' in l

/** Convert a single LSP Location to Monaco */
export const toMonacoLocation = (monacoApi: typeof monaco, loc: Location): monaco.languages.Location => ({
  uri: monacoApi.Uri.parse(loc.uri),
  range: toMonacoIRange(loc.range),
})

const toMonacoLocationLink = (monacoApi: typeof monaco, l: LocationLink): monaco.languages.LocationLink => ({
  uri: monacoApi.Uri.parse(l.targetUri),
  range: toMonacoIRange(l.targetRange),
  targetSelectionRange: toMonacoIRange(l.targetSelectionRange),
  ...(l.originSelectionRange ? { originSelectionRange: toMonacoIRange(l.originSelectionRange) } : {}),
})

/** Convert an LSP definition result (Location, Location[] or LocationLink[]) to Monaco */
export const toMonacoLocations = (
  monacoApi: typeof monaco,
  result: Definition | LocationLink[] | null,
): monaco.languages.Location[] | monaco.languages.LocationLink[] => {
  if (!result) return []
  const items = Array.isArray(result) ? result : [result]
  const [first] = items
  if (!first) return []
  // LSP guarantees homogeneous arrays of either Location or LocationLink
  return isLocationLink(first)
    ? (items as LocationLink[]).map((l) => toMonacoLocationLink(monacoApi, l))
    : (items as Location[]).map((l) => toMonacoLocation(monacoApi, l))
}

/** Convert LSP document highlights to Monaco (kind is 1-based -> 0-based) */
export const toMonacoHighlights = (
  monacoApi: typeof monaco,
  highlights: DocumentHighlight[],
): monaco.languages.DocumentHighlight[] =>
  highlights.map((h) => ({
    range: toMonacoIRange(h.range),
    kind: h.kind ? ((h.kind - 1) as monaco.languages.DocumentHighlightKind) : monacoApi.languages.DocumentHighlightKind.Text,
  }))

/** Convert LSP signature help to Monaco */
export const toMonacoSignatureHelp = (help: SignatureHelp): monaco.languages.SignatureHelp => ({
  signatures: (help.signatures ?? []).map((s) => ({
    label: s.label,
    documentation: toMonacoMarkup(s.documentation),
    parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: toMonacoMarkup(p.documentation) })),
    ...(s.activeParameter != null ? { activeParameter: s.activeParameter } : {}),
  })),
  activeSignature: help.activeSignature ?? 0,
  activeParameter: help.activeParameter ?? 0,
})

// ---------------- Symbols / folding ----------------

const isSymbolInformation = (s: DocumentSymbol | SymbolInformation): s is SymbolInformation => 'location' in s

/** Convert LSP document symbols (hierarchical or flat) to Monaco (kind 1-based -> 0-based) */
export const toMonacoSymbols = (symbols: (DocumentSymbol | SymbolInformation)[]): monaco.languages.DocumentSymbol[] =>
  symbols.map(toMonacoSymbol)

const toMonacoSymbol = (s: DocumentSymbol | SymbolInformation): monaco.languages.DocumentSymbol => {
  const range = toMonacoIRange(isSymbolInformation(s) ? s.location.range : s.range)
  return {
    name: s.name,
    detail: isSymbolInformation(s) ? '' : (s.detail ?? ''),
    kind: (s.kind - 1) as monaco.languages.SymbolKind,
    tags: (s.tags ?? []) as monaco.languages.SymbolTag[],
    containerName: isSymbolInformation(s) ? s.containerName : undefined,
    range,
    selectionRange: isSymbolInformation(s) ? range : toMonacoIRange(s.selectionRange),
    children: !isSymbolInformation(s) && s.children ? s.children.map(toMonacoSymbol) : undefined,
  }
}

/** Convert LSP folding ranges to Monaco (lines 0-based -> 1-based) */
export const toMonacoFoldingRanges = (monacoApi: typeof monaco, ranges: FoldingRange[]): monaco.languages.FoldingRange[] =>
  ranges.map((r) => ({
    start: r.startLine + 1,
    end: r.endLine + 1,
    kind: foldingKind(monacoApi, r.kind),
  }))

const foldingKind = (monacoApi: typeof monaco, kind: string | undefined): monaco.languages.FoldingRangeKind | undefined => {
  switch (kind) {
    case 'comment':
      return monacoApi.languages.FoldingRangeKind.Comment
    case 'imports':
      return monacoApi.languages.FoldingRangeKind.Imports
    case 'region':
      return monacoApi.languages.FoldingRangeKind.Region
    default:
      return undefined
  }
}

// ---------------- Workspace edits / rename / code actions ----------------

/** Convert an LSP WorkspaceEdit to Monaco (text edits only; file operations are skipped) */
export const toMonacoWorkspaceEdit = (monacoApi: typeof monaco, edit: WorkspaceEdit): monaco.languages.WorkspaceEdit => {
  const edits: monaco.languages.IWorkspaceTextEdit[] = []
  const push = (uri: string, textEdits: TextEdit[], versionId: number | undefined) => {
    const resource = monacoApi.Uri.parse(uri)
    for (const te of textEdits) edits.push({ resource, textEdit: toMonacoTextEdit(te), versionId })
  }

  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) push(uri, textEdits, undefined)
  }
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if ('textDocument' in dc && 'edits' in dc) push(dc.textDocument.uri, dc.edits as TextEdit[], dc.textDocument.version ?? undefined)
    }
  }
  return { edits }
}

/** Convert an LSP prepareRename result to a Monaco rename location (or rejection) */
export const toMonacoRenameLocation = (
  monacoApi: typeof monaco,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  result: PrepareRenameResult | null,
): monaco.languages.RenameLocation & monaco.languages.Rejection => {
  const wordRange = () => {
    const word = model.getWordAtPosition(position)
    const range = word
      ? new monacoApi.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      : new monacoApi.Range(position.lineNumber, position.column, position.lineNumber, position.column)
    return { range, text: word?.word ?? '' }
  }

  if (!result) return { ...wordRange(), rejectReason: 'You cannot rename this element.' }
  if ('placeholder' in result) return { range: toMonacoIRange(result.range), text: result.placeholder }
  if ('defaultBehavior' in result) return wordRange()
  const range = toMonacoIRange(result)
  return { range, text: model.getValueInRange(range) }
}

/** Store the original LSP code action for codeAction/resolve */
const LSP_CODE_ACTION_KEY = Symbol.for('__lsp_code_action__')
export const getLspCodeAction = (a: monaco.languages.CodeAction): CodeAction | undefined =>
  (a as any)[LSP_CODE_ACTION_KEY]

const isCommandResult = (a: Command | CodeAction): a is Command => typeof (a as Command).command === 'string'

const toMonacoCommand = (c: Command): monaco.languages.Command => ({
  id: c.command,
  title: c.title,
  arguments: c.arguments,
})

/** Convert a single LSP code action or command to Monaco */
export const toMonacoCodeAction = (monacoApi: typeof monaco, a: Command | CodeAction): monaco.languages.CodeAction => {
  if (isCommandResult(a)) return { title: a.title, command: toMonacoCommand(a) }
  const result: monaco.languages.CodeAction = {
    title: a.title,
    kind: a.kind,
    isPreferred: a.isPreferred,
    disabled: a.disabled?.reason,
    edit: a.edit ? toMonacoWorkspaceEdit(monacoApi, a.edit) : undefined,
    command: a.command ? toMonacoCommand(a.command) : undefined,
  }
  ;(result as any)[LSP_CODE_ACTION_KEY] = a
  return result
}

/** Convert LSP code action results to Monaco */
export const toMonacoCodeActions = (
  monacoApi: typeof monaco,
  actions: (Command | CodeAction)[],
): monaco.languages.CodeAction[] => actions.map((a) => toMonacoCodeAction(monacoApi, a))

/** Map Monaco markers back to LSP diagnostics (lossy; used for codeAction context) */
export const toLspDiagnostics = (monacoApi: typeof monaco, markers: monaco.editor.IMarkerData[]): Diagnostic[] =>
  markers.map((m) => ({
    range: toLspRange(m),
    message: m.message,
    severity: fromMarkerSeverity(monacoApi, m.severity) as Diagnostic['severity'],
    code: typeof m.code === 'object' ? m.code.value : m.code,
    source: m.source,
    tags: m.tags ? m.tags.map((t) => (t === monacoApi.MarkerTag.Unnecessary ? 1 : 2)) : undefined,
  }))

const fromMarkerSeverity = (monacoApi: typeof monaco, s: monaco.MarkerSeverity): number => {
  switch (s) {
    case monacoApi.MarkerSeverity.Error:
      return 1
    case monacoApi.MarkerSeverity.Warning:
      return 2
    case monacoApi.MarkerSeverity.Info:
      return 3
    default:
      return 4
  }
}
