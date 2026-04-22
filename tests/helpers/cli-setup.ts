import { execa } from 'execa'
import { getBinPath } from 'get-bin-path'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

export async function setup(): Promise<void> {
  // DTS generation has pre-existing errors in test files and multi-server.ts.
  // Build may exit non-zero but JS outputs are still produced — verify they exist.
  await execa('npm', ['run', 'build'], { stdio: 'inherit', reject: false })

  if (!existsSync(resolve('dist/cli/index.cjs'))) {
    throw new Error('CLI build failed — dist/cli/index.cjs not produced')
  }
  if (!existsSync(resolve('dist/server.js'))) {
    throw new Error('Server build failed — dist/server.js not produced')
  }

  const raw = await getBinPath()
  if (!raw) throw new Error('Could not resolve fastmcp binary from package.json bin field')
  process.env['FASTMCP_BIN'] = resolve(raw)
}
