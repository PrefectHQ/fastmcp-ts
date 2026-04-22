import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import yaml from 'yaml'

export type ConfigFormat = 'json' | 'yaml'

export interface ConfigTarget {
  name: string
  path: string
  format: ConfigFormat
}

export function getConfigPaths(): Record<string, ConfigTarget> {
  const home = homedir()
  const platform = process.platform

  const claudeDesktop =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : platform === 'win32'
        ? join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
        : join(home, '.config', 'Claude', 'claude_desktop_config.json')

  return {
    'claude-code': {
      name: 'claude-code',
      path: join(home, '.claude.json'),
      format: 'json',
    },
    'claude-desktop': {
      name: 'claude-desktop',
      path: claudeDesktop,
      format: 'json',
    },
    cursor: {
      name: 'cursor',
      path: join(home, '.cursor', 'mcp.json'),
      format: 'json',
    },
    gemini: {
      name: 'gemini',
      path: join(home, '.gemini', 'settings.json'),
      format: 'json',
    },
    goose: {
      name: 'goose',
      path: join(home, '.config', 'goose', 'config.yaml'),
      format: 'yaml',
    },
    'mcp-json': {
      name: 'mcp-json',
      path: resolve(process.cwd(), 'mcp.json'),
      format: 'json',
    },
  }
}

export function readConfig(path: string, format: ConfigFormat): unknown {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  return format === 'yaml' ? yaml.parse(raw) : JSON.parse(raw)
}

export function writeConfig(path: string, data: unknown, format: ConfigFormat): void {
  const content =
    format === 'yaml' ? yaml.stringify(data) : JSON.stringify(data, null, 2) + '\n'
  writeFileSync(path, content, 'utf8')
}
