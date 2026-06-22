import { defineConfig, Place, Match, Select } from '@lickle/docs/config'

export default defineConfig({
  name: 'monaco-lsp-bridge',
  layout: Place.compose(
    Place.filter(Match.all(Match.exposed(), Match.not(Match.tag('@internal')))),
    Place.bucket(Select.kind),
    Place.bucketOrder('classes', /.*/),
    Place.visibility(Match.all(Match.not(Match.kinds('class', 'module'))), { nav: false }),
    (s, p) => {
      const d = p.default()
      if (s.kind === 'markdown' && d.page) return { ...d, page: { ...d.page, group: { name: '', order: 0 } } }
      if (d.page?.name === 'monaco-lsp-bridge') return { ...d, nav: [] }
      if (d.nav?.some((n) => !('root' in n.parent))) {
        return {
          ...d,
          nav: d.nav.map((n) => ({ ...n, parent: { root: true } })),
          page: d.page ? { ...d.page, parent: { root: true } } : null,
        }
      }
    },
  ),
})
