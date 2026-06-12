// TypeDoc plugin adapting typedoc-plugin-markdown output for Mintlify:
// - prepends frontmatter (Mintlify renders the title as the page heading)
// - strips the duplicate leading H1
// - rewrites internal .mdx links to root-relative slugs (the only link form
//   Mintlify resolves and its broken-links checker understands)
import { posix } from 'node:path'
import { MarkdownPageEvent } from 'typedoc-plugin-markdown'

export function load(app) {
  app.renderer.on(MarkdownPageEvent.END, (page) => {
    const title = String(page.model?.name ?? 'API').replace(/"/g, '\\"')
    const pageDir = posix.dirname(page.url)
    const body = page.contents
      .replace(/^# .*\n+/, '')
      .replace(/\]\(([^)\s]+)\.mdx(#[^)]*)?\)/g, (match, target, anchor = '') => {
        if (/^[a-z]+:\/\//i.test(target)) return match
        const resolved = posix.normalize(posix.join(pageDir, target))
        return `](/api/${resolved}${anchor})`
      })
    page.contents = `---\ntitle: "${title}"\n---\n\n${body}`
  })
}
