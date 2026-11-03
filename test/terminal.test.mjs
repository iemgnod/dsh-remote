import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalLog, MAX_EVENTS_PER_SERVER, MAX_CHUNK_CHARS } from '../src/terminal.js';

test('records events with a monotonic cursor', () => {
  const log = new TerminalLog();
  const first = log.record('s1', { type: 'agent-start', command: 'ls' });
  const second = log.record('s1', { type: 'agent-data', chunk: 'a\n' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(log.seq, 2);

  assert.deepEqual(log.read('s1').map((event) => event.seq), [1, 2]);
  assert.deepEqual(log.read('s1', 1).map((event) => event.seq), [2]);
  assert.deepEqual(log.read('s1', 2), []);
  assert.deepEqual(log.read('s2'), []);
});

test('keeps servers apart and clears one at a time', () => {
  const log = new TerminalLog();
  log.record('s1', { type: 'shell-data', chunk: 'one' });
  log.record('s2', { type: 'shell-data', chunk: 'two' });
  assert.equal(log.read('s1').length, 1);
  assert.equal(log.read('s2').length, 1);

  log.clear('s1');
  assert.deepEqual(log.read('s1'), []);
  assert.equal(log.read('s2').length, 1);

  log.reset();
  assert.deepEqual(log.read('s2'), []);
});

test('drops the oldest events past the per-server limit', () => {
  const log = new TerminalLog({ limit: 3 });
  for (let index = 0; index < 5; index += 1) log.record('s1', { type: 'agent-data', chunk: `${index}` });
  const kept = log.read('s1');
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((event) => event.chunk), ['2', '3', '4']);
  // The cursor still moves forward, so a poller never replays dropped events.
  assert.equal(log.seq, 5);
  assert.deepEqual(log.read('s1', 4).map((event) => event.chunk), ['4']);
});

test('truncates oversized chunks', () => {
  const log = new TerminalLog();
  const big = 'x'.repeat(MAX_CHUNK_CHARS + 100);
  const entry = log.record('s1', { type: 'agent-data', chunk: big });
  assert.equal(entry.truncated, true);
  assert.ok(entry.chunk.length <= MAX_CHUNK_CHARS + 1, `chunk stayed at ${entry.chunk.length} chars`);
  assert.ok(entry.chunk.startsWith('x'));
  assert.equal(MAX_EVENTS_PER_SERVER, 600);
});
