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

function makeInMemoryAdapter(): FileStorageAdapter {
  const store = new Map<string, FileHandle>()
  return {
    save: (handle, file) => store.set(handle, file),
    load: (handle) => store.get(handle),
    delete: (handle) => store.delete(handle),
  }
}

export interface FileUploadOptions {
  storage?: FileStorageAdapter
}

const SESSION_HANDLES_KEY = '__fastmcp_file_handles'

export class FileUpload {
  readonly server: FastMCP
  private readonly _storage: FileStorageAdapter

  constructor(options?: FileUploadOptions) {
    this._storage = options?.storage ?? makeInMemoryAdapter()
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
        const handle = randomUUID()
        const fileData = Buffer.from(args.data as string, 'base64')
        storage.save(handle, {
          handle,
          name: args.name as string,
          mimeType: args.mimeType as string,
          data: fileData,
        })

        // Track handle in session state for future cleanup
        const ctx = contextStore.getStore()
        if (ctx) {
          const existing = (ctx.getState(SESSION_HANDLES_KEY) as string[] | undefined) ?? []
          ctx.setState(SESSION_HANDLES_KEY, [...existing, handle])
        }

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
        const ctx = contextStore.getStore()
        if (ctx) {
          const existing = (ctx.getState(SESSION_HANDLES_KEY) as string[] | undefined) ?? []
          ctx.setState(SESSION_HANDLES_KEY, existing.filter((h) => h !== handle))
        }
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
