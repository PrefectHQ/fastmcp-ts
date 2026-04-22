import { execa, type Options as ExecaOptions } from 'execa'
import { getBinPath } from 'get-bin-path'
import { resolve } from 'node:path'

let _binPath: string | undefined

async function resolveBin(): Promise<string> {
  if (_binPath) return _binPath
  const fromEnv = process.env['FASTMCP_BIN']
  if (fromEnv) {
    _binPath = fromEnv
    return _binPath
  }
  const raw = await getBinPath()
  if (!raw) throw new Error('Could not resolve fastmcp binary')
  _binPath = resolve(raw)
  return _binPath
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runCli(args: string[], opts: ExecaOptions = {}): Promise<RunResult> {
  const bin = await resolveBin()
  const result = await execa('node', [bin, ...args], {
    timeout: 15_000,
    reject: false,
    ...opts,
  })
  return {
    stdout: result.stdout as string,
    stderr: result.stderr as string,
    exitCode: result.exitCode ?? 1,
  }
}

export function fixtureCommand(name: string): string {
  const fixturePath = resolve(import.meta.dirname, '../fixtures', name)
  return `node ${fixturePath}`
}
