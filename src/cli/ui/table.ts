import Table from 'cli-table3'
import { theme } from './theme.js'
import { log } from './output.js'

export function renderTable(
  headers: string[],
  rows: string[][],
  opts?: { emptyMessage?: string },
): void {
  if (rows.length === 0) {
    log.muted(opts?.emptyMessage ?? 'No items found.')
    return
  }

  const table = new Table({
    head: headers.map((h) => theme.label(h)),
    style: { 'padding-left': 1, 'padding-right': 1, border: [], head: [] },
  })

  for (const row of rows) {
    table.push(row)
  }

  process.stderr.write(table.toString() + '\n')
}
