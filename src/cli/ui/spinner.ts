import { spinner as clackSpinner } from '@clack/prompts'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import { isQuiet } from './output.js'

export async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (isQuiet() || !process.stdout.isTTY) {
    return fn()
  }
  const s = clackSpinner()
  s.start(theme.muted(`${symbols.info} ${label}`))
  try {
    const result = await fn()
    s.stop(theme.success(`${symbols.success} ${label.replace(/…$/, '')} done`))
    return result
  } catch (err) {
    s.stop(theme.error(`${symbols.failure} ${label.replace(/…$/, '')} failed`))
    throw err
  }
}
