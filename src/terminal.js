/**
 * A small per-server event log for the terminal panel.
 *
 * The panel is a plain browser page, so it cannot receive a push stream from
 * the host without SSE; instead every terminal event is appended here with a
 * monotonic sequence number, and the page polls `since=<seq>` for the delta.
 * The log is intentionally lossy: old events are dropped so a long-running
 * session cannot grow the host's memory without bound.
 */

const MAX_EVENTS_PER_SERVER = 600;
const MAX_CHUNK_CHARS = 16 * 1024;

export class TerminalLog {
  /**
   * @param {{ limit?: number }} [options]
   */
  constructor(options = {}) {
    this.limit = options.limit ?? MAX_EVENTS_PER_SERVER;
    /** Global, monotonic: one cursor for the page, whatever the server. */
    this.seq = 0;
    /** @type {Map<string, Array<Record<string, unknown>>>} */
    this.logs = new Map();
  }

  /**
   * Append one event. Returns the stored copy, which carries `seq`.
   * @param {string} serverId
   * @param {Record<string, unknown>} event
   */
  record(serverId, event) {
    const entry = { ...event, seq: (this.seq += 1) };
    if (typeof entry.chunk === 'string' && entry.chunk.length > MAX_CHUNK_CHARS) {
      entry.chunk = `${entry.chunk.slice(0, MAX_CHUNK_CHARS)}…`;
      entry.truncated = true;
    }
    const list = this.logs.get(serverId);
    if (list) {
      list.push(entry);
      if (list.length > this.limit) list.splice(0, list.length - this.limit);
    } else {
      this.logs.set(serverId, [entry]);
    }
    return entry;
  }

  /**
   * Events for one server newer than `since`.
   * @param {string} serverId
   * @param {number} since
   */
  read(serverId, since = 0) {
    const list = this.logs.get(serverId) ?? [];
    return list.filter((event) => event.seq > since);
  }

  /** @param {string} serverId */
  clear(serverId) {
    this.logs.delete(serverId);
  }

  /** Drop everything (used on plugin unload). */
  reset() {
    this.logs.clear();
  }
}

export { MAX_EVENTS_PER_SERVER, MAX_CHUNK_CHARS };
