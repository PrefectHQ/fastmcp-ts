// Rewrites the "SDK Reference" tab in docs/docs.json from the navigation tree
// emitted by typedoc (`navigationJson` option). Run via `npm run docs:api`.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const navPath = resolve(root, 'docs/api/navigation.json')
const docsJsonPath = resolve(root, 'docs/docs.json')

const nav = JSON.parse(readFileSync(navPath, 'utf8'))
const docs = JSON.parse(readFileSync(docsJsonPath, 'utf8'))

const GROUP_LABELS = { server: 'Server', client: 'Client' }

const toSlug = (path) => 'api/' + path.replace(/\\/g, '/').replace(/\.mdx$/, '')

function toPages(nodes) {
  const pages = []
  for (const node of nodes ?? []) {
    if (node.children?.length) {
      pages.push({ group: node.title, pages: toPages(node.children) })
    } else if (node.path) {
      pages.push(toSlug(node.path))
    }
  }
  return pages
}

const MODULE_ORDER = ['server', 'client']
const groups = nav
  .toSorted((a, b) => MODULE_ORDER.indexOf(a.title) - MODULE_ORDER.indexOf(b.title))
  .map((mod) => ({
    group: GROUP_LABELS[mod.title] ?? mod.title,
    pages: [toSlug(mod.path ?? `${mod.title}/index.mdx`), ...toPages(mod.children)],
  }))

const sdkTab = docs.navigation.tabs.find((t) => t.tab === 'SDK Reference')
if (!sdkTab) throw new Error('No "SDK Reference" tab found in docs/docs.json')
sdkTab.groups = groups

writeFileSync(docsJsonPath, JSON.stringify(docs, null, 2) + '\n')
console.log(`SDK Reference tab updated: ${groups.map((g) => g.group).join(', ')}`)
