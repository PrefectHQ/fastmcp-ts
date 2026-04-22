import { describe, it, expect } from 'vitest'
import { execa } from 'execa'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import yaml from 'yaml'
import { runCli } from './helpers/cli.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), 'fastmcp-test-'))
  try {
    return await fn(tmp)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

// Path to the built simple-server fixture
const SIMPLE_SERVER = resolve(import.meta.dirname, 'fixtures/simple-server.mjs')
const ERROR_SERVER = resolve(import.meta.dirname, 'fixtures/error-server.mjs')

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

describe.sequential('CLI — version', () => {
  it('prints fastmcp, mcp-sdk, node version, and platform info', async () => {
    const { exitCode, stderr } = await runCli(['version'])
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/fastmcp/)
    expect(stderr).toMatch(/mcp-sdk/)
    expect(stderr).toMatch(/node/)
    expect(stderr).toMatch(/platform/)
  })

  it('--json outputs machine-readable JSON with the same fields', async () => {
    const { exitCode, stdout } = await runCli(['version', '--json'])
    expect(exitCode).toBe(0)
    const data = JSON.parse(stdout)
    expect(data).toHaveProperty('fastmcp')
    expect(data).toHaveProperty('mcp-sdk')
    expect(data).toHaveProperty('node')
    expect(data).toHaveProperty('platform')
  })
})

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

describe.sequential('CLI — inspect', () => {
  it('lists tools with their names and descriptions', async () => {
    const { exitCode, stderr } = await runCli(['inspect', SIMPLE_SERVER])
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/echo/)
    expect(stderr).toMatch(/add/)
    expect(stderr).toMatch(/Tools/)
  })

  it('lists resources with their URIs', async () => {
    const { exitCode, stderr } = await runCli(['inspect', SIMPLE_SERVER])
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/memo:\/\/greeting/)
    expect(stderr).toMatch(/Resources/)
  })

  it('lists prompts with their names', async () => {
    const { exitCode, stderr } = await runCli(['inspect', SIMPLE_SERVER])
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/greet/)
    expect(stderr).toMatch(/Prompts/)
  })

  it('--json outputs tools, resources, and prompts as machine-readable JSON', async () => {
    const { exitCode, stdout } = await runCli(['--quiet', 'inspect', SIMPLE_SERVER, '--json'])
    expect(exitCode).toBe(0)
    const data = JSON.parse(stdout)
    expect(Array.isArray(data.tools)).toBe(true)
    expect(data.tools.map((t: { name: string }) => t.name)).toContain('echo')
    expect(Array.isArray(data.resources)).toBe(true)
    expect(data.resources[0].uri).toBe('memo://greeting')
    expect(Array.isArray(data.prompts)).toBe(true)
    expect(data.prompts[0].name).toBe('greet')
  })

  it('exits non-zero with an error message when the file does not exist', async () => {
    const { exitCode, stderr } = await runCli(['inspect', 'nonexistent-file.ts'])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found|File not found/i)
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe.sequential('CLI — list', () => {
  it('prints tool names and descriptions when connecting via --command', async () => {
    const { exitCode, stderr } = await runCli([
      'list',
      '--command', `node ${SIMPLE_SERVER}`,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/echo/)
    expect(stderr).toMatch(/add/)
  })

  it('--resources includes resource entries in the output', async () => {
    const { exitCode, stderr } = await runCli([
      'list',
      '--command', `node ${SIMPLE_SERVER}`,
      '--resources',
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/memo:\/\/greeting/)
    expect(stderr).toMatch(/Resources/)
  })

  it('--prompts includes prompt entries in the output', async () => {
    const { exitCode, stderr } = await runCli([
      'list',
      '--command', `node ${SIMPLE_SERVER}`,
      '--prompts',
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/greet/)
    expect(stderr).toMatch(/Prompts/)
  })

  it('--json outputs the full tool/resource/prompt list as machine-readable JSON', async () => {
    const { exitCode, stdout } = await runCli([
      '--quiet', 'list',
      '--command', `node ${SIMPLE_SERVER}`,
      '--resources',
      '--prompts',
      '--json',
    ])
    expect(exitCode).toBe(0)
    const data = JSON.parse(stdout)
    expect(Array.isArray(data.tools)).toBe(true)
    expect(data.tools.map((t: { name: string }) => t.name)).toContain('echo')
    expect(Array.isArray(data.resources)).toBe(true)
    expect(Array.isArray(data.prompts)).toBe(true)
  })

  it('--input-schema prints the JSON input schema for each tool', async () => {
    const { exitCode, stderr } = await runCli([
      'list',
      '--command', `node ${SIMPLE_SERVER}`,
      '--input-schema',
    ])
    expect(exitCode).toBe(0)
    // Schema for `echo` includes a `message` string property
    expect(stderr).toMatch(/message/)
    // Schema for `add` includes `a` and `b` number properties
    expect(stderr).toMatch(/\ba\b/)
    expect(stderr).toMatch(/\bb\b/)
  })

  it('exits non-zero with an error when the server is unreachable', async () => {
    const { exitCode, stderr } = await runCli(['list', 'http://127.0.0.1:19999/mcp'])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/refused|unreachable|failed/i)
  })
})

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

describe.sequential('CLI — call', () => {
  it('invokes the named tool and prints a text result', async () => {
    const { exitCode, stdout } = await runCli([
      'call', 'echo',
      '--command', `node ${SIMPLE_SERVER}`,
      'message=hello',
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/hello/)
  })

  it('coerces numeric string values to numbers', async () => {
    const { exitCode, stdout } = await runCli([
      '--quiet', 'call', 'add',
      '--command', `node ${SIMPLE_SERVER}`,
      'a=4', 'b=6',
    ])
    expect(exitCode).toBe(0)
    // The add tool returns { sum: 10 } — rendered as JSON via log.raw
    const data = JSON.parse(stdout)
    expect(data.sum).toBe(10)
  })

  it('--input-json accepts a JSON object as the argument set', async () => {
    const { exitCode, stdout } = await runCli([
      'call', 'echo',
      '--command', `node ${SIMPLE_SERVER}`,
      '--input-json', JSON.stringify({ message: 'from-json' }),
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/from-json/)
  })

  it('--input-json takes precedence when both --input-json and key=value args are present', async () => {
    const { exitCode, stdout } = await runCli([
      '--quiet', 'call', 'echo',
      '--command', `node ${SIMPLE_SERVER}`,
      '--input-json', JSON.stringify({ message: 'from-json' }),
      'message=ignored',
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/from-json/)
  })

  it('reads a resource by URI and prints its content', async () => {
    const { exitCode, stdout } = await runCli([
      'call', 'memo://greeting',
      '--command', `node ${SIMPLE_SERVER}`,
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/Hello from resource/)
  })

  it('gets a prompt by name and prints rendered messages', async () => {
    const { exitCode, stdout } = await runCli([
      'call', 'greet',
      '--command', `node ${SIMPLE_SERVER}`,
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/Hello from prompt/)
  })

  it('suggests the closest match when the tool name is not found', async () => {
    const { exitCode, stderr } = await runCli([
      'call', 'ech',
      '--command', `node ${SIMPLE_SERVER}`,
    ])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Did you mean/)
    expect(stderr).toMatch(/echo/)
  })

  it('--json outputs the raw tool result as machine-readable JSON', async () => {
    const { exitCode, stdout } = await runCli([
      '--quiet', 'call', 'echo',
      '--command', `node ${SIMPLE_SERVER}`,
      '--json',
      'message=test',
    ])
    expect(exitCode).toBe(0)
    const data = JSON.parse(stdout)
    expect(Array.isArray(data.content)).toBe(true)
  })

  it('exits non-zero when the server returns a tool error', async () => {
    const { exitCode, stderr } = await runCli([
      'call', 'always-fails',
      '--command', `node ${ERROR_SERVER}`,
    ])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/error|failed/i)
  })
})

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

describe.sequential('CLI — discover', () => {
  it('finds MCP servers in a local mcp.json file', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({ mcpServers: { 'my-tool': { command: 'node server.js' } } }),
      )
      const { exitCode, stderr } = await runCli(['discover'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
      })
      expect(exitCode).toBe(0)
      expect(stderr).toMatch(/my-tool/)
      expect(stderr).toMatch(/stdio/)
    })
  })

  it('finds MCP servers in a Claude Code config file', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, '.claude.json'),
        JSON.stringify({ mcpServers: { 'claude-tool': { command: 'node c.js' } } }),
      )
      const { exitCode, stderr } = await runCli(['discover'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
      })
      expect(exitCode).toBe(0)
      expect(stderr).toMatch(/claude-tool/)
    })
  })

  it('finds MCP servers in a Cursor config file', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, '.cursor'), { recursive: true })
      await writeFile(
        join(dir, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: { 'cursor-tool': { command: 'node cursor.js' } } }),
      )
      const { exitCode, stderr } = await runCli(['discover'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
      })
      expect(exitCode).toBe(0)
      expect(stderr).toMatch(/cursor-tool/)
    })
  })

  it('finds MCP servers in a Claude Desktop config file', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir, 'Library', 'Application Support', 'Claude')
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'claude_desktop_config.json'),
        JSON.stringify({ mcpServers: { 'desktop-tool': { command: 'node d.js' } } }),
      )
      const { exitCode, stderr } = await runCli(['discover'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
      })
      expect(exitCode).toBe(0)
      expect(stderr).toMatch(/desktop-tool/)
    })
  })

  it('finds MCP servers in a Gemini config file', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, '.gemini'), { recursive: true })
      await writeFile(
        join(dir, '.gemini', 'settings.json'),
        JSON.stringify({ mcpServers: { 'gemini-tool': { command: 'node g.js' } } }),
      )
      const { exitCode, stderr } = await runCli(['discover'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
      })
      expect(exitCode).toBe(0)
      expect(stderr).toMatch(/gemini-tool/)
    })
  })

  it('finds MCP servers in a Goose config file', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, '.config', 'goose'), { recursive: true })
      await writeFile(
        join(dir, '.config', 'goose', 'config.yaml'),
        yaml.stringify({ extensions: { 'goose-tool': { cmd: 'node goose.js', enabled: true, type: 'stdio' } } }),
      )
      const { exitCode, stderr } = await runCli(['discover'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
      })
      expect(exitCode).toBe(0)
      expect(stderr).toMatch(/goose-tool/)
    })
  })

  it('--source filters results to only the specified config source', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, '.claude.json'),
        JSON.stringify({ mcpServers: { 'claude-only': { command: 'node c.js' } } }),
      )
      await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({ mcpServers: { 'local-only': { command: 'node l.js' } } }),
      )
      const { exitCode, stderr } = await runCli(['discover', '--source', 'claude-code'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
      })
      expect(exitCode).toBe(0)
      expect(stderr).toMatch(/claude-only/)
      expect(stderr).not.toMatch(/local-only/)
    })
  })

  it('--json outputs all discovered servers as machine-readable JSON', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({ mcpServers: { 'json-tool': { command: 'node j.js' } } }),
      )
      const { exitCode, stdout } = await runCli(['discover', '--json'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
      })
      expect(exitCode).toBe(0)
      const data = JSON.parse(stdout)
      expect(Array.isArray(data)).toBe(true)
      expect(data.some((s: { name: string }) => s.name === 'json-tool')).toBe(true)
    })
  })

  it('shows an empty state when no known config files exist', async () => {
    await withTempDir(async (dir) => {
      const { exitCode, stderr } = await runCli(['discover'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
      })
      expect(exitCode).toBe(0)
      expect(stderr).toMatch(/No MCP servers/i)
    })
  })
})

// ---------------------------------------------------------------------------
// install mcp-json
// ---------------------------------------------------------------------------

describe.sequential('CLI — install mcp-json', () => {
  it('creates a new mcp.json and writes the server entry', async () => {
    await withTempDir(async (dir) => {
      const { exitCode } = await runCli(
        ['install', 'mcp-json', 'my-server', 'node server.js'],
        { cwd: dir },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
      expect(config.mcpServers['my-server'].command).toBe('node server.js')
    })
  })

  it('adds to an existing mcp.json without removing other entries', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({ mcpServers: { existing: { command: 'node existing.js' } } }),
      )
      const { exitCode } = await runCli(
        ['install', 'mcp-json', 'new-server', 'node new.js', '--force'],
        { cwd: dir },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
      expect(config.mcpServers['existing']).toBeDefined()
      expect(config.mcpServers['new-server'].command).toBe('node new.js')
    })
  })

  it('--force overwrites an existing entry without prompting', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({ mcpServers: { 'my-server': { command: 'node old.js' } } }),
      )
      const { exitCode } = await runCli(
        ['install', 'mcp-json', 'my-server', 'node new.js', '--force'],
        { cwd: dir },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
      expect(config.mcpServers['my-server'].command).toBe('node new.js')
    })
  })

  it('--args are stored correctly in the installed config', async () => {
    await withTempDir(async (dir) => {
      const { exitCode } = await runCli(
        ['install', 'mcp-json', 'my-server', 'node server.js', '--args', '--debug --port 8080'],
        { cwd: dir },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
      expect(config.mcpServers['my-server'].args).toEqual(['--debug', '--port', '8080'])
    })
  })

  it('--env variables are stored correctly in the installed config', async () => {
    await withTempDir(async (dir) => {
      const { exitCode } = await runCli(
        ['install', 'mcp-json', 'my-server', 'node server.js', '--env', 'API_KEY=secret,DEBUG=true'],
        { cwd: dir },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
      expect(config.mcpServers['my-server'].env).toEqual({ API_KEY: 'secret', DEBUG: 'true' })
    })
  })

  it('exits non-zero when entry already exists and --force is not set (non-TTY)', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({ mcpServers: { 'my-server': { command: 'node old.js' } } }),
      )
      const { exitCode, stderr } = await runCli(
        ['install', 'mcp-json', 'my-server', 'node new.js'],
        { cwd: dir, env: { ...process.env, CI: 'true' } },
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/already exists|Use --force/i)
    })
  })
})

// ---------------------------------------------------------------------------
// install claude-code
// ---------------------------------------------------------------------------

describe.sequential('CLI — install claude-code', () => {
  it('writes the server entry to the Claude Code config file', async () => {
    await withTempDir(async (dir) => {
      const { exitCode } = await runCli(
        ['install', 'claude-code', 'my-server', 'node server.js'],
        { env: { ...process.env, HOME: dir } },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8'))
      expect(config.mcpServers['my-server'].command).toBe('node server.js')
    })
  })

  it('--force overwrites a pre-existing entry', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, '.claude.json'),
        JSON.stringify({ mcpServers: { 'my-server': { command: 'node old.js' } } }),
      )
      const { exitCode } = await runCli(
        ['install', 'claude-code', 'my-server', 'node new.js', '--force'],
        { env: { ...process.env, HOME: dir } },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8'))
      expect(config.mcpServers['my-server'].command).toBe('node new.js')
    })
  })
})

// ---------------------------------------------------------------------------
// install claude-desktop
// ---------------------------------------------------------------------------

describe.sequential('CLI — install claude-desktop', () => {
  it('writes the server entry to the Claude Desktop config file', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'Library', 'Application Support', 'Claude'), { recursive: true })
      const { exitCode } = await runCli(
        ['install', 'claude-desktop', 'my-server', 'node server.js'],
        { env: { ...process.env, HOME: dir } },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(
        await readFile(
          join(dir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
          'utf8',
        ),
      )
      expect(config.mcpServers['my-server'].command).toBe('node server.js')
    })
  })

  it('--force overwrites a pre-existing entry', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir, 'Library', 'Application Support', 'Claude')
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'claude_desktop_config.json'),
        JSON.stringify({ mcpServers: { 'my-server': { command: 'node old.js' } } }),
      )
      const { exitCode } = await runCli(
        ['install', 'claude-desktop', 'my-server', 'node new.js', '--force'],
        { env: { ...process.env, HOME: dir } },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(
        await readFile(join(configDir, 'claude_desktop_config.json'), 'utf8'),
      )
      expect(config.mcpServers['my-server'].command).toBe('node new.js')
    })
  })
})

// ---------------------------------------------------------------------------
// install cursor
// ---------------------------------------------------------------------------

describe.sequential('CLI — install cursor', () => {
  it('writes the server entry to the Cursor config file', async () => {
    await withTempDir(async (dir) => {
      const { exitCode } = await runCli(
        ['install', 'cursor', 'my-server', 'node server.js'],
        { env: { ...process.env, HOME: dir } },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(await readFile(join(dir, '.cursor', 'mcp.json'), 'utf8'))
      expect(config.mcpServers['my-server'].command).toBe('node server.js')
    })
  })
})

// ---------------------------------------------------------------------------
// install gemini
// ---------------------------------------------------------------------------

describe.sequential('CLI — install gemini', () => {
  it('writes the server entry to the Gemini config file', async () => {
    await withTempDir(async (dir) => {
      const { exitCode } = await runCli(
        ['install', 'gemini', 'my-server', 'node server.js'],
        { env: { ...process.env, HOME: dir } },
      )
      expect(exitCode).toBe(0)
      const config = JSON.parse(await readFile(join(dir, '.gemini', 'settings.json'), 'utf8'))
      expect(config.mcpServers['my-server'].command).toBe('node server.js')
    })
  })
})

// ---------------------------------------------------------------------------
// install goose
// ---------------------------------------------------------------------------

describe.sequential('CLI — install goose', () => {
  it('writes the entry to Goose YAML config with enabled: true and type: stdio', async () => {
    await withTempDir(async (dir) => {
      const { exitCode } = await runCli(
        ['install', 'goose', 'my-server', 'node server.js'],
        { env: { ...process.env, HOME: dir } },
      )
      expect(exitCode).toBe(0)
      const raw = await readFile(join(dir, '.config', 'goose', 'config.yaml'), 'utf8')
      const config = yaml.parse(raw)
      expect(config.extensions['my-server'].cmd).toBe('node server.js')
      expect(config.extensions['my-server'].enabled).toBe(true)
      expect(config.extensions['my-server'].type).toBe('stdio')
    })
  })

  it('--args become the YAML args array', async () => {
    await withTempDir(async (dir) => {
      const { exitCode } = await runCli(
        ['install', 'goose', 'my-server', 'node server.js', '--args', '--debug --verbose'],
        { env: { ...process.env, HOME: dir } },
      )
      expect(exitCode).toBe(0)
      const raw = await readFile(join(dir, '.config', 'goose', 'config.yaml'), 'utf8')
      const config = yaml.parse(raw)
      expect(config.extensions['my-server'].args).toEqual(['--debug', '--verbose'])
    })
  })
})

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe.sequential('CLI — run', () => {
  it('starts the server process and does not immediately exit', async () => {
    const subprocess = execa('node', [process.env['FASTMCP_BIN']!, 'run', SIMPLE_SERVER], {
      reject: false,
      timeout: 5_000,
    })

    // Give the server a moment to start, then verify it's still running
    const stillRunning = await Promise.race([
      new Promise<boolean>((resolve) => {
        subprocess.stderr!.on('data', () => resolve(true))
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_000)),
      subprocess.then(() => false),
    ])

    subprocess.kill()
    expect(stillRunning).toBe(true)
  })

  it('exits non-zero with an error when the server file does not exist', async () => {
    const { exitCode, stderr } = await runCli(['run', 'nonexistent-server.ts'])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found|File not found/i)
  })
})
