import { randomUUID } from 'node:crypto'
import { FastMCP } from '../../FastMCP'
import { ResourceResult } from '../../resource'
import { contextStore } from '../../context'
import { actionRef } from '../actionRef'
import { Column, Text, Button } from '../components'

export interface FileHandle {
  handle: string
  name: string
  mimeType: string
  data: Buffer
}

export interface FileStorageAdapter {
  save(handle: string, file: FileHandle): void
  load(handle: string): FileHandle | undefined
  delete(handle: string): void
}

/**
 * Default in-memory adapter with TTL-based expiry. Expiry is checked lazily on
 * every save/load (no timer), so it costs nothing when idle. This is the
 * era-agnostic cleanup mechanism for uploaded files: unlike session-close
 * cleanup (ctx.onClose, below), which only fires for transports that actually
 * have a session (stdio, legacy HTTP), TTL expiry works uniformly for
 * stateless modern (2026-07-28) HTTP requests too, where there is no session
 * to close.
 */
function makeInMemoryAdapter(ttlMs: number): FileStorageAdapter {
  const store = new Map<string, { file: FileHandle; expiresAt: number }>()
  function sweep(): void {
    const now = Date.now()
    for (const [handle, entry] of store) {
      if (entry.expiresAt <= now) store.delete(handle)
    }
  }
  return {
    save: (handle, file) => {
      sweep()
      store.set(handle, { file, expiresAt: Date.now() + ttlMs })
    },
    load: (handle) => {
      sweep()
      return store.get(handle)?.file
    },
    delete: (handle) => {
      store.delete(handle)
    },
  }
}

export interface FileUploadOptions {
  storage?: FileStorageAdapter
  /**
   * How long (ms) an uploaded file is retained by the default in-memory storage
   * adapter before automatic expiry. Only applies when no custom `storage` is
   * supplied. Default: 30 minutes.
   */
  ttlMs?: number
}

export class FileUpload {
  readonly server: FastMCP
  private readonly _storage: FileStorageAdapter

  constructor(options?: FileUploadOptions) {
    this._storage = options?.storage ?? makeInMemoryAdapter(options?.ttlMs ?? 30 * 60_000)
    this.server = new FastMCP({ name: 'file-upload' })

    const storage = this._storage

    this.server.tool(
      {
        name: 'file_upload_open',
        description: 'Open a file picker UI for the user to upload a file',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Instructions shown above the file picker' },
          },
        },
        ui: { visibility: ['model', 'app'] },
      },
      (args: Record<string, unknown>) => {
        return Column({}, [
          Text((args.prompt as string | undefined) ?? 'Upload a file'),
          Button({ label: 'Choose file', action: actionRef('file_upload_submit') }),
        ])
      },
    )

    this.server.tool(
      {
        name: 'file_upload_submit',
        description: 'Receive and store uploaded file bytes server-side',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name' },
            mimeType: { type: 'string', description: 'MIME type of the file' },
            data: { type: 'string', description: 'Base64-encoded file content' },
          },
          required: ['name', 'mimeType', 'data'],
        },
        ui: { visibility: ['app'] },
      },
      (args: Record<string, unknown>) => {
        // The handle is the durable, portable identifier for this upload — it works
        // the same way whether the caller is on a session-based transport (stdio,
        // legacy HTTP) or a stateless modern (2026-07-28) HTTP request: the model
        // threads it back as an ordinary tool argument on later calls (file_upload_delete,
        // reading the ui://files/{handle} resource), the same explicit-handle pattern
        // the spec recommends in place of session state.
        const handle = randomUUID()
        const fileData = Buffer.from(args.data as string, 'base64')
        storage.save(handle, {
          handle,
          name: args.name as string,
          mimeType: args.mimeType as string,
          data: fileData,
        })

        // Best-effort early cleanup for transports that actually have a session
        // (stdio, legacy HTTP) — a no-op on stateless modern HTTP, where there is no
        // session to close. The real, era-agnostic cleanup is the storage adapter's
        // own TTL expiry (see makeInMemoryAdapter / FileUploadOptions.ttlMs).
        contextStore.getStore()?.onClose(() => storage.delete(handle))

        const uri = `ui://files/${handle}`
        return { handle, uri }
      },
    )

    this.server.tool(
      {
        name: 'file_upload_delete',
        description: 'Delete a previously uploaded file by its handle',
        inputSchema: {
          type: 'object',
          properties: {
            handle: { type: 'string', description: 'The file handle returned by file_upload_submit' },
          },
          required: ['handle'],
        },
        ui: { visibility: ['app'] },
      },
      (args: Record<string, unknown>) => {
        const handle = args.handle as string
        storage.delete(handle)
        return { deleted: handle }
      },
    )

    this.server.resource(
      { uri: 'ui://files/{handle}', name: 'uploaded-file', mimeType: 'application/octet-stream' },
      (params) => {
        const h = params?.handle
        if (!h) throw new Error('Missing file handle')
        const file = storage.load(h)
        if (!file) throw new Error(`File not found: ${h}`)
        const uri = `ui://files/${h}`
        if (file.mimeType.startsWith('text/')) {
          return new ResourceResult([{ uri, mimeType: file.mimeType, text: file.data.toString('utf8') }])
        }
        return new ResourceResult([{ uri, mimeType: file.mimeType, blob: file.data.toString('base64') }])
      },
    )
  }
}
