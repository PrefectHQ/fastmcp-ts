# fastmcp-ts

The TypeScript framework for building [Model Context Protocol](https://modelcontextprotocol.io) servers, clients, and apps. The official TypeScript counterpart to [FastMCP for Python](https://github.com/PrefectHQ/fastmcp) - built and maintained with 💙 by the same team at [Prefect](https://prefect.io).

Built on the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

## Installation

```bash
npm install fastmcp-ts
```

---

## Servers

Turn TypeScript functions into MCP tools, resources, and prompts. Input schemas are inferred automatically from any [Standard Schema](https://standardschema.dev)-compatible library: Zod, Valibot, ArkType, and others.

```typescript
import { FastMCP } from 'fastmcp-ts/server'
import { z } from 'zod'

const server = new FastMCP({ name: 'my-server', version: '1.0.0' })

server.tool(
  {
    name: 'add',
    description: 'Add two numbers',
    input: z.object({ a: z.number(), b: z.number() }),
  },
  ({ a, b }) => a + b
)

server.resource(
  { uri: 'config://settings', description: 'App configuration' },
  () => JSON.stringify({ theme: 'dark', lang: 'en' })
)

server.resource(
  { uri: 'user://{id}', description: 'User by ID' },
  ({ id }) => `User #${id}`
)

server.prompt(
  {
    name: 'review_code',
    description: 'Review code for quality and correctness',
    arguments: [
      { name: 'code', required: true },
      { name: 'language', required: false },
    ],
  },
  ({ code, language }) =>
    `Review this ${language ?? 'code'} for quality and correctness:\n\n${code}`
)

await server.run()                              // stdio (default)
// await server.run({ transport: 'http', port: 3000 })
```

### Context

Handlers access logging, progress, LLM sampling, user elicitation, and per-session state through an ambient context with no prop-drilling.

```typescript
import { FastMCP } from 'fastmcp-ts/server'
import { z } from 'zod'

const server = new FastMCP({ name: 'assistant' })

server.tool(
  {
    name: 'summarize',
    description: 'Summarize a document',
    input: z.object({ text: z.string() }),
  },
  async ({ text }) => {
    const ctx = server.getContext()

    await ctx.info('Sending document to LLM')
    await ctx.reportProgress(0, 1, 'Sampling…')

    const { content } = await ctx.sample({
      messages: [{ role: 'user', content: { type: 'text', text: `Summarize:\n${text}` } }],
      maxTokens: 512,
    })

    return content.text
  }
)
```

### Middleware & Auth

```typescript
import { FastMCP, LoggingMiddleware, RateLimitingMiddleware, jwtVerifier } from 'fastmcp-ts/server'

const server = new FastMCP({
  name: 'secure-server',
  auth: jwtVerifier({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: 'my-mcp-server',
  }),
})

server.use(new LoggingMiddleware())
server.use(new RateLimitingMiddleware(100, 60_000))  // 100 requests per minute

await server.run({ transport: 'http', port: 3000 })
```

### Composition

Mount child servers onto a parent with optional name-prefix namespacing.

```typescript
import { FastMCP, createProxy } from 'fastmcp-ts/server'

const weather = new FastMCP({ name: 'weather' })
weather.tool({ name: 'forecast', description: 'Get a forecast', input: z.object({ city: z.string() }) }, ({ city }) => `Forecast for ${city}`)

// Wrap a remote server as a mountable instance
const maps = await createProxy({ transport: 'http', url: 'http://maps-service/mcp' })

const gateway = new FastMCP({ name: 'gateway' })
gateway.mount(weather, 'weather')   // → weather_forecast
gateway.mount(maps, 'maps')         // → maps_<tool_name>

await gateway.run({ transport: 'http', port: 3000 })
```

---

## Clients

```typescript
import { Client } from 'fastmcp-ts/client'

const client = await Client.connect('http://localhost:3000')

const tools     = await client.listTools()
const resources = await client.listResources()
const prompts   = await client.listPrompts()

const result = await client.callTool('add', { a: 1, b: 2 })
const config = await client.readResource('config://settings')
const review = await client.getPrompt('review_code', { code: 'const x = 1' })

await client.close()
```

Use `await using` for automatic cleanup:

```typescript
await using client = await Client.connect('http://localhost:3000')
const result = await client.callTool('add', { a: 1, b: 2 })
// client closed automatically on scope exit
```

### Sampling Adapters

Forward LLM sampling requests from servers to your AI provider with a single line:

```typescript
import { Client, AnthropicSamplingAdapter } from 'fastmcp-ts/client'
import Anthropic from '@anthropic-ai/sdk'

const client = await Client.connect('http://localhost:3000', {
  handlers: {
    sampling: (params) => new AnthropicSamplingAdapter(new Anthropic()).handleSampling(params),
  },
})
```

Also ships with `OpenAISamplingAdapter` and `GoogleSamplingAdapter`.

### Multi-Server

Connect to multiple servers from a single client. Tools, resources, and prompts are namespaced by server name automatically.

```typescript
import { Client } from 'fastmcp-ts/client'

const client = await Client.connect({
  mcpServers: {
    weather: { url: 'http://localhost:3001' },
    maps:    { url: 'http://localhost:3002' },
  },
})

// tool names become weather_forecast, maps_geocode, …
const forecast = await client.callTool('weather_forecast', { city: 'New York' })
```

---

## Apps

FastMCP ships a server-side component library for building interactive UIs rendered directly in MCP host conversations.

```typescript
import { FastMCPApp, Column, Row, Text, Input, Button, Table } from 'fastmcp-ts/server'
import { z } from 'zod'

const app = new FastMCPApp({ name: 'search-app', version: '1.0.0' })

// Entry-point tool: visible to the LLM, auto-linked to a ui:// resource
app.entrypoint(
  { name: 'search', description: 'Search the product catalog' },
  () =>
    Column({}, [
      Text('Product Search'),
      Row({}, [
        Input({ name: 'query', placeholder: 'Search products…' }),
        Button({ label: 'Search', actionRef: 'run_search' }),
      ]),
    ])
)

// Backend tool: hidden from the LLM, callable only from within the rendered UI
app.backendTool(
  {
    name: 'run_search',
    description: 'Execute the search query',
    input: z.object({ query: z.string() }),
  },
  async ({ query }) => {
    const rows = await db.search(query)
    return Table({ columns: ['Name', 'Price', 'Stock'], rows })
  }
)

await app.server.run({ transport: 'http', port: 3000 })
```

### Built-in Providers

Ready-to-mount interactive primitives:

```typescript
import { FastMCP, Approval, Choice, FileUpload, FormInput } from 'fastmcp-ts/server'
import { z } from 'zod'

const server = new FastMCP({ name: 'my-server' })

server.addProvider(new Approval())    // confirm/deny card injected back into the conversation
server.addProvider(new Choice())      // clickable option list
server.addProvider(new FileUpload())  // drag-and-drop file picker; file bytes never pass through the LLM
server.addProvider(new FormInput())   // auto-generated validated form from any Standard Schema
```

### Generative UI

Let the LLM compose component trees at runtime:

```typescript
import { FastMCP, GenerativeUI } from 'fastmcp-ts/server'

const server = new FastMCP({ name: 'my-server' })
server.addProvider(new GenerativeUI())
// registers generate_ui and search_components tools

await server.run()
```

---

## CLI

```bash
# Start a server
fastmcp run server.ts
fastmcp run server.ts --transport http --port 3000

# Inspect a server's tools, resources, and prompts
fastmcp inspect --file server.ts
fastmcp inspect --url http://localhost:3000
fastmcp inspect --file server.ts --json

# Call a tool, read a resource, or get a prompt
fastmcp call add --file server.ts a=1 b=2
fastmcp call config://settings --url http://localhost:3000

# Connect to a running server and list its components
fastmcp list --url http://localhost:3000
fastmcp list --url http://localhost:3000 --resources --prompts --json

# Open the MCP Inspector UI with file-watch reload
fastmcp dev inspector server.ts

# Install into editor/client configs
fastmcp install claude-code server.ts
fastmcp install cursor server.ts
fastmcp install claude-desktop server.ts

# Find locally configured MCP servers
fastmcp discover
```

---

## Ecosystem

| Package | Role |
|---|---|
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | Official low-level MCP protocol implementation — this library's foundation |
| [`fastmcp` (PyPI)](https://github.com/PrefectHQ/fastmcp) | The Python original this project models its API after |
| [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) | Official MCP Apps extension — foundation for the Apps pillar |
