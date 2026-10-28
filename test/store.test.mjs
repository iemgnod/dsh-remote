import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerStore } from '../src/store.js';
import { RemoteError } from '../src/util.js';

function makeStore(env = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'dsh-remote-store-'));
  return { store: new ServerStore({ dir, env }), dir };
}

test('creates a server, writes 0600 JSON and masks secrets', () => {
  const { store, dir } = makeStore();
  const created = store.upsert({
    name: 'prod', host: 'example.com', username: 'root', password: 'p@ss', tags: ['web'],
  });
  assert.equal(created.created, true);
  assert.equal(created.server.port, 22);
  assert.match(created.server.id, /^prod$/);

  const raw = fs.readFileSync(join(dir, 'servers.json'), 'utf8');
  assert.match(raw, /p@ss/);
  const publicEntry = store.publicServer(store.list()[0]);
  assert.equal(publicEntry.password, undefined);
  assert.equal(publicEntry.hasPassword, true);
  assert.equal(publicEntry.authType, 'password');
  assert.deepEqual(publicEntry.tags, ['web']);
});

test('updates keep unspecified secrets and allow partial fields', () => {
  const { store } = makeStore();
  const { server } = store.upsert({ name: 'prod', host: 'example.com', username: 'root', password: 'p@ss' });
  const updated = store.upsert({ id: server.id, description: '生产环境' });
  assert.equal(updated.created, false);
  assert.equal(updated.server.password, 'p@ss');
  assert.equal(updated.server.host, 'example.com');
  assert.equal(updated.server.description, '生产环境');

  const cleared = store.upsert({ id: server.id, privateKeyPath: '~/.ssh/id_ed25519', clearPassword: true });
  assert.equal(cleared.server.password, undefined);
  assert.equal(cleared.server.privateKeyPath, '~/.ssh/id_ed25519');
  assert.equal(store.publicServer(cleared.server).authType, 'key');
});

test('rejects invalid and duplicate entries', () => {
  const { store } = makeStore();
  store.upsert({ name: 'a', host: 'a.example', username: 'root', password: 'x' });
  assert.throws(
    () => store.upsert({ name: 'a', host: 'b.example', username: 'root', password: 'x' }),
    (error) => error instanceof RemoteError && error.code === 'duplicate-name',
  );
  assert.throws(
    () => store.upsert({ name: 'c', host: 'c.example' }),
    (error) => error instanceof RemoteError && error.code === 'invalid-field',
  );
  assert.throws(
    () => store.upsert({ name: 'c', host: 'c.example', username: 'root', password: 'x', surprise: 1 }),
    (error) => error instanceof RemoteError && /不认识的字段/.test(error.message),
  );
  assert.throws(
    () => store.upsert({ name: 'c', host: 'c.example', username: 'root', password: 'x', port: 70000 }),
    (error) => error instanceof RemoteError && error.field === 'port',
  );
  const { server } = store.upsert({ name: 'd', host: 'd.example', username: 'root', password: 'x' });
  assert.throws(
    () => store.upsert({ id: server.id, host: '' }),
    (error) => error instanceof RemoteError && error.field === 'host',
  );
});

test('resolves env secret references only when connecting', () => {
  const { store } = makeStore({ PROD_PASSWORD: 'from-env' });
  const { server } = store.upsert({ name: 'prod', host: 'example.com', username: 'root', password: 'env:PROD_PASSWORD' });
  assert.equal(store.resolveConnection(server).password, 'from-env');

  const { server: missing } = store.upsert({ name: 'b', host: 'b.example', username: 'root', password: 'env:NOT_SET' });
  assert.throws(
    () => store.resolveConnection(missing),
    (error) => error instanceof RemoteError && error.code === 'missing-secret-env',
  );
  assert.throws(
    () => store.upsert({ name: 'c', host: 'c.example', username: 'root', password: 'env:bad name' }),
    (error) => error instanceof RemoteError && error.code === 'bad-secret-reference',
  );
});

test('removes by id or exact name and reports unknown selectors', () => {
  const { store } = makeStore();
  store.upsert({ name: 'prod', host: 'example.com', username: 'root', password: 'x' });
  store.upsert({ name: 'stage', host: 'stage.example', username: 'root', password: 'x' });
  assert.equal(store.remove('prod').server.name, 'prod');
  assert.equal(store.list().length, 1);
  assert.throws(() => store.find('prod'), (error) => error instanceof RemoteError && error.code === 'server-not-found');
  assert.throws(() => store.find(''), (error) => error instanceof RemoteError && error.code === 'invalid-field');
});

test('reports a corrupt file once without destroying it', () => {
  const { store, dir } = makeStore();
  fs.writeFileSync(join(dir, 'servers.json'), '{ not json');
  assert.throws(() => store.list(), (error) => error instanceof RemoteError && error.code === 'corrupt-file');
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('servers.json.corrupt-')));
});

test('skips an invalid stored entry but keeps the others', () => {
  const { store, dir } = makeStore();
  const valid = {
    id: 'ok', name: 'ok', host: 'ok.example', port: 22, username: 'root', password: 'x',
    workdir: '', description: '', tags: [], disabled: false, readyTimeoutMs: 20000,
    keepaliveIntervalMs: 15000, maxOutputBytes: 262144,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(join(dir, 'servers.json'), JSON.stringify({ version: 1, servers: [valid, { id: 'bad' }] }));
  const { servers, warnings } = store.read();
  assert.equal(servers.length, 1);
  assert.equal(warnings.length, 1);
});
