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
