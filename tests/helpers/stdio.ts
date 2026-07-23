import { PassThrough } from 'node:stream'

// ---------------------------------------------------------------------------
// In-process stdio pipe pair
//
// Two PassThrough streams wired crosswise give an in-process stdio wire: bytes
// one side writes are the bytes the other side reads, with no child process
// and no real file descriptors involved. Every in-process stdio harness in
// this suite (tests/helpers/eras.ts, the interop matrix's C2-stdio and
// B2-stdio cells) wires the same pair the same way, so it lives here once.
// ---------------------------------------------------------------------------

export interface StdioPipePair {
  /** The stream the server reads from and the client writes to. */
  clientToServer: PassThrough
  /** The stream the server writes to and the client reads from. */
  serverToClient: PassThrough
}

/** A fresh crosswired `PassThrough` pair for one in-process stdio connection. */
export function stdioPipePair(): StdioPipePair {
  return { clientToServer: new PassThrough(), serverToClient: new PassThrough() }
}
