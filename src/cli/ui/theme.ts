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
