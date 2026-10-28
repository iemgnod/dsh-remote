import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerStore } from '../src/store.js';
import { SshManager } from '../src/ssh.js';
import { registerRemoteTools } from '../src/tools.js';
import { startSshServer } from './ssh-server.mjs';

function makeContext() {
  const tools = new Map();
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  return { ctx, tools };
}

test('registers the expected tool set', () => {
  const store = new ServerStore({ dir: fs.mkdtempSync(join(tmpdir(), 'dsh-remote-tools-')), env: {} });
  const manager = new SshManager({ store });
  const { ctx, tools } = makeContext();
  registerRemoteTools(ctx, { store, manager, config: {} });
  assert.deepEqual([...tools.keys()].sort(), [
    'remote_exec',
    'remote_list_servers',
    'remote_remove_server',
    'remote_save_server',
    'remote_sftp',
    'remote_test_connection',
  ]);
  for (const tool of tools.values()) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.parameters, 'object');
    assert.equal(tool.output.schema.type, 'json');
    assert.equal(typeof tool.execute, 'function');
  }
});

test('tool flow: save, list, exec and sftp', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-remote-tools-'));
  const server = await startSshServer({ rootDir: join(root, 'remote') });
  const store = new ServerStore({ dir: join(root, 'store'), env: {} });
  const manager = new SshManager({ store });
  const { ctx, tools } = makeContext();
  registerRemoteTools(ctx, { store, manager, config: {} });
  const call = (name, args) => tools.get(name).execute(args, {});
  try {
    const saved = await call('remote_save_server', {
      name: 'test', host: server.host, port: server.port, username: server.username, password: server.password,
      tags: ['ci'],
    });
    assert.equal(saved.created, true);
    assert.equal(saved.server.tags[0], 'ci');

    const listed = await call('remote_list_servers', {});
    assert.equal(listed.count, 1);
    assert.match(listed.text, /test/);

    const exec = await call('remote_exec', { server: 'test', command: "printf 'tool'" });
    assert.equal(exec.stdout.text, 'tool');
    assert.equal(exec.exitCode, 0);
    assert.match(exec.text, /\$ printf 'tool'/);

    const write = await call('remote_sftp', { server: 'test', action: 'write', remotePath: 'dir/a.txt', content: 'abc' });
    assert.equal(write.bytes, 3);
    const read = await call('remote_sftp', { server: 'test', action: 'read', remotePath: 'dir/a.txt' });
    assert.equal(read.content, 'abc');
    const list = await call('remote_sftp', { server: 'test', action: 'list', remotePath: 'dir' });
    assert.equal(list.entries[0].name, 'a.txt');
    const stat = await call('remote_sftp', { server: 'test', action: 'stat', remotePath: 'dir/a.txt' });
    assert.equal(stat.stat.type, 'file');

    const tested = await call('remote_test_connection', { server: 'test' });
    assert.equal(tested.ok, true);

    const removed = await call('remote_remove_server', { server: 'test' });
    assert.equal(removed.server.id, saved.server.id);
    assert.throws(() => store.find('test'));
  } finally {
    manager.closeAll();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
