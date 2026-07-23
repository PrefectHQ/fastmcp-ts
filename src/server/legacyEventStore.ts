import { randomUUID } from 'node:crypto'
import type { EventStore, EventId, StreamId, JSONRPCMessage } from '@modelcontextprotocol/server'

/**
 * Default per-session retention cap for {@link BoundedEventStore}.
 *
 * SEP-1699 resumability without unbounded growth: one store lives per legacy
 * session and holds at most this many most-recent events across all of that
 * session's SSE streams. Older events are evicted FIFO; a client that has fallen
 * further behind than the cap reconnects fresh instead of resuming.
 *
 * This is a COUNT cap (event count), not a byte cap: a burst of large tool results
 * can retain up to 256 large messages, so worst-case bytes scale with message
 * size. A POST tools/call stream normally carries only a handful of events
 * (priming + optional progress + result), so 256 is generous headroom in practice.
 *
 * The store is freed with the session only on GRACEFUL close (client `DELETE` or
 * `mcp.close()`). A client that drops its TCP connection without a `DELETE` leaves
 * the session — and this store — resident until process shutdown; that is the
 * pre-existing legacy-session retention behavior, which an event store makes
 * heavier per session. There is no idle reaper.
 */
export const DEFAULT_MAX_EVENTS = 256

/**
 * `retry:` hint (milliseconds) sent in the SSE priming event (SEP-1699).
 *
 * The SDK transport renders a `retry:` field only when this is set, so fastmcp
 * supplies a sane fixed value rather than a tunable option (YAGNI — operators do
 * not normally tune SSE reconnect timing). 1000 ms is a responsive-yet-calm
 * reconnect cadence: fast enough to resume a dropped poll promptly, slow enough
 * to avoid a reconnect storm.
 */
export const LEGACY_SSE_RETRY_MS = 1000

/**
 * Bounded in-memory {@link EventStore} for the legacy Streamable HTTP transport's
 * SSE resumability (SEP-1699). Enabling an event store makes the SDK transport
 * emit a priming event (an SSE `id:` with empty `data:`) — plus a `retry:` hint
 * when `retryInterval` is set — at the head of each POST SSE stream, and lets a
 * client replay missed events after reconnecting with `Last-Event-ID`.
 *
 * Retention is bounded to `maxEvents` (default {@link DEFAULT_MAX_EVENTS}): once
 * the cap is exceeded the oldest event is evicted. `Map` preserves insertion
 * order, so eviction and ordered replay are both O(1) amortized off that order.
 * The event id carries a monotonic sequence plus a UUID so ids are unique and
 * stable; stream recovery is a plain map lookup, not id parsing.
 */
export class BoundedEventStore implements EventStore {
  private readonly _events = new Map<EventId, { streamId: StreamId; message: JSONRPCMessage }>()
  private _seq = 0

  constructor(private readonly _maxEvents: number = DEFAULT_MAX_EVENTS) {}

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    // seq + uuid make the id unique and per-store ordered. The `streamId` prefix is
    // decorative (aids debugging only) — getStreamIdForEventId reads the stored
    // record, it never parses the id — so an opaque streamId can contain "::".
    const eventId = `${streamId}::${(this._seq++).toString(36)}::${randomUUID()}`
    this._events.set(eventId, { streamId, message })
    // FIFO eviction keeps retention bounded. Map iteration order is insertion
    // order, so the first key is always the oldest retained event.
    while (this._events.size > this._maxEvents) {
      const oldest = this._events.keys().next().value as EventId | undefined
      if (oldest === undefined) break
      this._events.delete(oldest)
    }
    return eventId
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    // Undefined for an unknown/evicted id — the SDK answers 400 rather than
    // silently replaying an empty stream, which is the correct resume error.
    return this._events.get(eventId)?.streamId
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const anchor = this._events.get(lastEventId)
    if (!anchor) return '' // unknown/evicted anchor: nothing to replay
    const { streamId } = anchor
    let pastAnchor = false
    for (const [eventId, stored] of this._events) {
      if (eventId === lastEventId) {
        pastAnchor = true
        continue
      }
      if (pastAnchor && stored.streamId === streamId) await send(eventId, stored.message)
    }
    return streamId
  }
}
