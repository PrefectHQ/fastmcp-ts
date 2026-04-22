import { execa } from 'execa'
import { getBinPath } from 'get-bin-path'
import { resolve } from 'node:path'

export async function setup(): Promise<void> {
  await execa('npm', ['run', 'build'], { stdio: 'inherit' })

  const raw = await getBinPath()
  if (!raw) throw new Error('Could not resolve fastmcp binary from package.json bin field')
  process.env['FASTMCP_BIN'] = resolve(raw)
}
