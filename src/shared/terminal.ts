// Shared terminal presentation: one visual language for CLI output and
// framework logs. Imported by src/cli/ui/* (re-export) and src/server/logger.ts.

import chalk from 'chalk'

export const theme = {
  primary: chalk.bold.cyan,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  muted: chalk.dim.gray,
  value: chalk.white,
  label: chalk.bold,
  url: chalk.cyan.underline,
  code: chalk.dim.white,
} as const

const isUnicode = process.env['TERM'] !== 'dumb' && !process.env['CI']

export const symbols = {
  success: isUnicode ? '✓' : '√',
  failure: isUnicode ? '✗' : 'x',
  info: isUnicode ? '◆' : '*',
  pointer: isUnicode ? '→' : '>',
  warning: isUnicode ? '⚠' : '!',
  pending: isUnicode ? '○' : '-',
  active: isUnicode ? '●' : '*',
  ellipsis: isUnicode ? '…' : '...',
  reload: isUnicode ? '↺' : '~',
  separator: isUnicode ? '──────────────────────────────────' : '----------------------------------',
} as const
