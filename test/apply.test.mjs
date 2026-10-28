import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.js';

test('apply publishes tools, prompt policy and the settings route', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-remote-apply-'));
  const tools = new Set();
  const sections = [];
  let route;
  const disposers = [];
  const ctx = {
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    effect(fn, label) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push({ label, dispose });
      return () => {};
    },
    tools: {
      register(definition) {
        tools.add(definition.name);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec);
        return () => {};
      },
    },
    webServer: {
      register(spec) {
        route = spec;
        return () => {};
      },
    },
  };
  apply(ctx, { dataFile: join(root, 'servers.json') });
  assert.deepEqual([...tools].sort(), [
    'remote_exec', 'remote_list_servers', 'remote_remove_server',
    'remote_save_server', 'remote_sftp', 'remote_test_connection',
  ]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'dsh-remote:servers');
  assert.match(sections[0].text(), /remote_exec/);
  assert.equal(route.path, '/dsh-remote');
  assert.ok(disposers.length >= 8);
  for (const { dispose } of disposers) dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
