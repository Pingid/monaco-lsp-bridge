# monaco-lsp-bridge

A small, typed bridge that wires a Language Server Protocol (LSP) server to the Monaco editor.  
It handles JSON-RPC transport, progress/cancellation, diagnostics → markers, and completion/hover/formatting adapters.

[![Build Status](https://img.shields.io/github/actions/workflow/status/Pingid/monaco-lsp-bridge/test.yml?branch=main&style=flat&colorA=000000&colorB=000000)](https://github.com/Pingid/monaco-lsp-bridge/actions?query=workflow:Test)
[![Build Size](https://img.shields.io/bundlephobia/minzip/monaco-lsp-bridge?label=bundle%20size&style=flat&colorA=000000&colorB=000000)](https://bundlephobia.com/result?p=monaco-lsp-bridge)
[![Version](https://img.shields.io/npm/v/monaco-lsp-bridge?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/monaco-lsp-bridge)
[![Downloads](https://img.shields.io/npm/dt/monaco-lsp-bridge.svg?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/monaco-lsp-bridge)

## Install

Install the `monaco-lsp-bridge` library using your preferred package manager:

```bash
npm install monaco-lsp-bridge
```

## 🚀 Quick Start

```ts
import * as monaco from 'monaco-editor'
import { LspMonacoClient, LspTransport } from 'monaco-lsp-bridge'

// 1) Create your Monaco editor
const editor = monaco.editor.create(document.getElementById('root')!, {
  value: 'function main() {}',
  language: 'javascript',
})

// 2) Create a transport to your LSP server (e.g. Web Worker)
const worker = new Worker(new URL('./server.worker.js', import.meta.url), { type: 'module' })
const transport = LspTransport.fromPort(worker)

// 3) Start the client
const client = new LspMonacoClient(transport, {
  languageSelector: { language: 'javascript' }, // or a selector array
  dedicatedServer: true, // sends shutdown/exit on dispose
})
client.connect(monaco, editor)

// (optional) listen to client events
const off = client.onEvent((e) => {
  if (e.type === 'error') console.error(e.error)
})

// Later: dispose
// await client.dispose()
```

## What it does

- Initializes the LSP server and applies reported capabilities.
- Sends `didOpen`/`didChange`/`didClose` matching server sync mode.
- Maps diagnostics → Monaco markers.
- Adapts completion, resolve, hover, and formatting requests.
- Handles progress (`$/progress`) and cancellation via `AbortSignal`.

## 📄 License

MIT © [Dan Beaven](https://github.com/Pingid)
