import { describe, it, expect } from 'vitest'

import {
  toLspRange,
  toLspPosition,
  toMonacoPosition,
  toMonacoCompletionItem,
  toMonacoMarkers,
  lspHoverToMonaco,
  toMonacoLocations,
  toMonacoLocation,
  toMonacoHighlights,
  toMonacoSignatureHelp,
  toMonacoSymbols,
  toMonacoFoldingRanges,
  toMonacoWorkspaceEdit,
  toMonacoCodeAction,
  getLspCodeAction,
  toMonacoRenameLocation,
  toLspDiagnostics,
} from './transform.js'
import { makeMonaco, makeModel } from './test-utils.js'

const m = makeMonaco()
const position = { lineNumber: 3, column: 5 } as any

describe('coordinate conversion', () => {
  it('converts ranges 1-based <-> 0-based', () => {
    expect(toLspRange({ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 8 })).toEqual({
      start: { line: 1, character: 3 },
      end: { line: 1, character: 7 },
    })
  })

  it('converts positions both directions', () => {
    expect(toLspPosition({ lineNumber: 1, column: 1 })).toEqual({ line: 0, character: 0 })
    expect(toMonacoPosition({ line: 4, character: 2 })).toEqual({ lineNumber: 5, column: 3 })
  })
})

describe('toMonacoCompletionItem', () => {
  const model = makeModel(m, 'file:///a.ts', 'x')

  it('marks snippets and keeps the original LSP item', () => {
    const item = toMonacoCompletionItem(m, model as any, position, {
      label: 'foo',
      insertText: 'foo()',
      insertTextFormat: 2,
    })
    expect(item.insertText).toBe('foo()')
    expect(item.insertTextRules).toBe(m.languages.CompletionItemInsertTextRule.InsertAsSnippet)
  })

  it('uses a textEdit range when provided and falls back otherwise', () => {
    const withEdit = toMonacoCompletionItem(m, model as any, position, {
      label: 'bar',
      textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'bar' },
    })
    expect(withEdit.range).toMatchObject({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 })

    const fallback = toMonacoCompletionItem(m, model as any, position, { label: 'baz' })
    expect(fallback.insertText).toBe('baz')
    expect(fallback.range).toMatchObject({ startLineNumber: position.lineNumber })
  })
})

describe('toMonacoMarkers', () => {
  it('maps severity, tags, related info and markup messages', () => {
    const marker = toMonacoMarkers(m, [
      {
        message: { kind: 'markdown', value: 'oops' } as any,
        severity: 1,
        code: 42,
        source: 'tsc',
        tags: [1, 2],
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        relatedInformation: [
          {
            message: 'see here',
            location: { uri: 'file:///b.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
          },
        ],
      },
    ])[0]!
    expect(marker.message).toBe('oops')
    expect(marker.severity).toBe(m.MarkerSeverity.Error)
    expect(marker.code).toBe('42')
    expect(marker.tags).toEqual([m.MarkerTag.Unnecessary, m.MarkerTag.Deprecated])
    expect(marker.relatedInformation?.[0]?.message).toBe('see here')
    expect(marker).toMatchObject({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 })
  })
})

describe('lspHoverToMonaco', () => {
  it('handles strings, code blocks, markup and arrays', () => {
    expect(lspHoverToMonaco({ contents: 'hi' }).contents).toEqual([{ value: 'hi' }])
    expect(lspHoverToMonaco({ contents: { language: 'ts', value: 'const x = 1' } }).contents).toEqual([
      { value: '```ts\nconst x = 1\n```' },
    ])
    expect(lspHoverToMonaco({ contents: { kind: 'markdown', value: '**b**' } }).contents).toEqual([{ value: '**b**' }])
    expect(lspHoverToMonaco({ contents: ['a', 'b'] }).contents).toEqual([{ value: 'a' }, { value: 'b' }])
  })
})

describe('navigation converters', () => {
  it('converts a single Location, an array and LocationLinks', () => {
    const loc = { uri: 'file:///a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
    expect(toMonacoLocations(m, loc)).toHaveLength(1)
    expect(toMonacoLocations(m, [loc, loc])).toHaveLength(2)
    expect(toMonacoLocations(m, null)).toEqual([])

    const [link] = toMonacoLocations(m, [
      {
        targetUri: 'file:///a.ts',
        targetRange: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
        targetSelectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
      },
    ]) as any[]
    expect(link.uri.toString()).toBe('file:///a.ts')
    expect(link.targetSelectionRange).toMatchObject({ startLineNumber: 2 })
  })

  it('converts references via toMonacoLocation', () => {
    const r = toMonacoLocation(m, {
      uri: 'file:///c.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    })
    expect(r.uri.toString()).toBe('file:///c.ts')
    expect(r.range).toMatchObject({ startLineNumber: 1, endColumn: 4 })
  })

  it('maps highlight kinds 1-based -> 0-based', () => {
    const hs = toMonacoHighlights(m, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, kind: 2 },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ])
    expect(hs[0]?.kind).toBe(m.languages.DocumentHighlightKind.Read)
    expect(hs[1]?.kind).toBe(m.languages.DocumentHighlightKind.Text)
  })
})

describe('signature help', () => {
  it('maps signatures, parameters and active indices', () => {
    const help = toMonacoSignatureHelp({
      signatures: [{ label: 'f(a)', documentation: { kind: 'markdown', value: 'doc' }, parameters: [{ label: 'a' }] }],
      activeSignature: 0,
      activeParameter: 0,
    })
    expect(help.signatures[0]?.label).toBe('f(a)')
    expect(help.signatures[0]?.documentation).toEqual({ value: 'doc' })
    expect(help.signatures[0]?.parameters[0]?.label).toBe('a')
  })
})

describe('symbols and folding', () => {
  it('maps hierarchical and flat symbols with kind offset', () => {
    const hierarchical = toMonacoSymbols([
      {
        name: 'A',
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        children: [
          {
            name: 'b',
            kind: 13,
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
            selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          },
        ],
      } as any,
    ])
    expect(hierarchical[0]?.kind).toBe(4)
    expect(hierarchical[0]?.children?.[0]?.kind).toBe(12)

    const flat = toMonacoSymbols([
      {
        name: 'C',
        kind: 1,
        location: { uri: 'file:///x', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      } as any,
    ])
    expect(flat[0]?.range).toEqual(flat[0]?.selectionRange)
  })

  it('maps folding ranges to 1-based lines with kinds', () => {
    const ranges = toMonacoFoldingRanges(m, [
      { startLine: 0, endLine: 2, kind: 'imports' },
      { startLine: 5, endLine: 8 },
    ])
    expect(ranges[0]).toMatchObject({ start: 1, end: 3, kind: m.languages.FoldingRangeKind.Imports })
    expect(ranges[1]?.kind).toBeUndefined()
  })
})

describe('workspace edits and code actions', () => {
  it('converts changes and documentChanges', () => {
    const edit = toMonacoWorkspaceEdit(m, {
      changes: {
        'file:///a': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }],
      },
      documentChanges: [
        {
          textDocument: { uri: 'file:///b', version: 7 },
          edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: 'y' }],
        } as any,
      ],
    })
    expect(edit.edits).toHaveLength(2)
    expect((edit.edits[1] as any).versionId).toBe(7)
  })

  it('converts code actions and stashes the original for resolve', () => {
    const action = toMonacoCodeAction(m, {
      title: 'Fix',
      kind: 'quickfix',
      edit: { changes: {} },
    })
    expect(action.title).toBe('Fix')
    expect(getLspCodeAction(action)?.title).toBe('Fix')

    const command = toMonacoCodeAction(m, { title: 'Run', command: 'do.it', arguments: [1] })
    expect(command.command).toEqual({ id: 'do.it', title: 'Run', arguments: [1] })
  })
})

describe('rename and reverse diagnostics', () => {
  const model = makeModel(m, 'file:///r.ts', 'name')

  it('handles prepareRename variants', () => {
    expect(toMonacoRenameLocation(m, model as any, position, { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, placeholder: 'name' })).toMatchObject({ text: 'name' })
    expect(toMonacoRenameLocation(m, model as any, position, null).rejectReason).toBeTruthy()
    expect(toMonacoRenameLocation(m, model as any, position, { defaultBehavior: true }).text).toBe('')
  })

  it('maps Monaco markers back to LSP diagnostics', () => {
    const [d] = toLspDiagnostics(m, [
      {
        message: 'err',
        severity: m.MarkerSeverity.Warning,
        code: { value: 'E1', target: m.Uri.parse('file:///x') as any },
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 4,
      } as any,
    ])
    expect(d?.severity).toBe(2)
    expect(d?.code).toBe('E1')
    expect(d?.range).toEqual({ start: { line: 1, character: 0 }, end: { line: 1, character: 3 } })
  })
})
