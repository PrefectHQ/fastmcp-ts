import { randomUUID } from 'node:crypto'
import { FastMCP } from '../../FastMCP'
import { ResourceResult } from '../../resource'
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
}

function makeInMemoryAdapter(): FileStorageAdapter {
  const store = new Map<string, FileHandle>()
  return {
    save: (handle, file) => store.set(handle, file),
    load: (handle) => store.get(handle),
  }
}

export interface FileUploadOptions {
  storage?: FileStorageAdapter
}

export class FileUpload {
  readonly server: FastMCP
  private readonly _storage: FileStorageAdapter

  constructor(options?: FileUploadOptions) {
    this._storage = options?.storage ?? makeInMemoryAdapter()
    this.server = new FastMCP({ name: 'file-upload' })

    const storage = this._storage

    // LLM-visible: shows drag-and-drop file picker UI
    this.server.tool(
      {
        name: 'file_upload_open',
        description: 'Open a file picker UI for the user to upload a file',
        ui: { visibility: ['model', 'app'] },
      },
      (args: Record<string, unknown>) => {
        return Column({}, [
          Text((args.prompt as string | undefined) ?? 'Upload a file'),
          Button({ label: 'Choose file', action: 'file_upload_submit' }),
        ])
      },
    )

    // Backend-only: receives base64 file bytes from the iframe, stores server-side
    this.server.tool(
      {
        name: 'file_upload_submit',
        description: 'Receive and store uploaded file bytes server-side',
        ui: { visibility: ['app'] },
      },
      (args: Record<string, unknown>) => {
        const handle = randomUUID()
        const fileData = Buffer.from(args.data as string, 'base64')
        storage.save(handle, { handle, name: args.name as string, mimeType: args.mimeType as string, data: fileData })
        const uri = `ui://files/${handle}`
        return { handle, uri }
      },
    )

    // Resource: serve stored file content via ui://files/{handle}
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
