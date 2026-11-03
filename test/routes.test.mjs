import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerStore } from '../src/store.js';
import { SshManager } from '../src/ssh.js';
import { registerRemoteRoutes } from '../src/routes.js';
import { startSshServer } from './ssh-server.mjs';

function makeRequest(method, url, body, headers = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:1234', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

function makeResponse() {
  return {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body ?? '';
      this.writableEnded = true;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

async function call(route, method, url, body, headers) {
  const response = makeResponse();
  await route.handler(makeRequest(method, url, body, headers), response);
  return response;
}

function fixture({ gate } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-remote-routes-'));
  const store = new ServerStore({ dir: join(root, 'store'), env: {} });
  const manager = new SshManager({ store });
  let route;
  const ctx = {
    get(name) {
      if (name === 'connection' && gate !== undefined) return gate;
      return undefined;
    },
    effect(fn) {
      return fn();
    },
    webServer: {
      register(spec) {
        route = spec;
        return () => {};
      },
    },
  };
  registerRemoteRoutes(ctx, { store, manager, config: {} });
  return { root, store, manager, route, ctx };
}

test('health and an empty inventory', async () => {
  const f = fixture();
  try {
    const health = await call(f.route, 'GET', '/dsh-remote/health');
    assert.equal(health.status, 200);
    assert.equal(health.json().ok, true);

    const list = await call(f.route, 'GET', '/dsh-remote/servers');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json().servers, []);
  } finally {
    f.manager.closeAll();
  }
});

test('create, mask, update and delete over HTTP', async () => {
  const f = fixture();
  try {
    const created = await call(f.route, 'POST', '/dsh-remote/servers', {
      server: { name: 'prod', host: 'example.com', username: 'root', password: 'p@ss' },
    });
    assert.equal(created.status, 200);
    const server = created.json().server;
    assert.equal(server.hasPassword, true);
    assert.equal(server.password, undefined);

    const updated = await call(f.route, 'POST', '/dsh-remote/servers', {
      server: { id: server.id, description: 'changed' },
    });
    assert.equal(updated.json().server.description, 'changed');

    const removed = await call(f.route, 'DELETE', `/dsh-remote/servers/${server.id}`);
    assert.equal(removed.status, 200);
    const list = await call(f.route, 'GET', '/dsh-remote/servers');
    assert.deepEqual(list.json().servers, []);
  } finally {
    f.manager.closeAll();
  }
});

test('rejects unknown fields and cross-site origins', async () => {
  const f = fixture();
  try {
    const invalid = await call(f.route, 'POST', '/dsh-remote/servers', {
      server: { name: 'x', host: 'x.example', username: 'root', password: 'p', bogus: true },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json().code, 'unknown-field');

    const hostile = await call(f.route, 'POST', '/dsh-remote/servers', {
      server: { name: 'x', host: 'x.example', username: 'root', password: 'p' },
    }, { origin: 'https://evil.example' });
    assert.equal(hostile.status, 403);

    const rebound = await call(f.route, 'GET', '/dsh-remote/servers', undefined, { host: 'evil.example' });
    assert.equal(rebound.status, 403);
  } finally {
    f.manager.closeAll();
  }
});

test('honors the host request gate', async () => {
  const gate = { requestRejection: () => 401 };
  const f = fixture({ gate });
  try {
    const response = await call(f.route, 'GET', '/dsh-remote/servers');
    assert.equal(response.status, 401);
    assert.equal(response.json().code, 'host-rejected');
  } finally {
    f.manager.closeAll();
  }
});

/** A route fixture backed by a real in-process SSH server. */
async function sshFixture({ allowWebExec } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-remote-routes-term-'));
  const server = await startSshServer({ rootDir: join(root, 'remote') });
  const store = new ServerStore({ dir: join(root, 'store'), env: {} });
  const entry = store.upsert({
    name: 'test', host: server.host, port: server.port, username: server.username, password: server.password,
  }).server;
  const manager = new SshManager({ store });
  let route;
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    webServer: { register: (spec) => { route = spec; return () => {}; } },
  };
  registerRemoteRoutes(ctx, { store, manager, config: allowWebExec === undefined ? {} : { allowWebExec } });
  return {
    root,
    server,
    store,
    manager,
    entry,
    route,
    async close() {
      manager.closeAll();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Poll `/terminal` like the panel does until the expected text shows up. */
async function pollTerminal(route, serverId, expected, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let since = 0;
  let text = '';
  const events = [];
  while (Date.now() < deadline) {
    const response = await call(route, 'GET', `/dsh-remote/terminal?server=${serverId}&since=${since}`);
    const body = response.json();
    assert.equal(response.status, 200);
    since = body.cursor;
    events.push(...body.events);
    text += body.events.filter((event) => event.type === 'shell-data').map((event) => event.chunk).join('');
    if (text.includes(expected)) return { text, events, cursor: since };
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(expected)}; saw ${JSON.stringify(text)}`);
}

test('interactive terminal over HTTP: open, input, poll, interrupt, close', async () => {
  const f = await sshFixture();
  try {
    const opened = await call(f.route, 'POST', '/dsh-remote/shells', { server: f.entry.id, cols: 120, rows: 40 });
    assert.equal(opened.status, 200);
    assert.equal(opened.json().shell.open, true);
    assert.equal(opened.json().shell.id, f.entry.id);

    const listed = await call(f.route, 'GET', '/dsh-remote/shells');
    assert.deepEqual(listed.json().shells.map((shell) => shell.id), [f.entry.id]);

    const typed = await call(f.route, 'POST', '/dsh-remote/shell/input', { server: f.entry.id, data: "printf 'term'\n" });
    assert.equal(typed.status, 200);
    assert.equal(typed.json().ok, true);

    const seen = await pollTerminal(f.route, f.entry.id, 'term');
    assert.ok(seen.events.some((event) => event.type === 'shell-open'), 'the open event is logged');
    assert.ok(seen.events.every((event) => Number.isInteger(event.seq)), 'every event carries a cursor');

    const signalled = await call(f.route, 'POST', '/dsh-remote/shell/signal', { server: f.entry.id });
    assert.equal(signalled.status, 200);
    assert.equal(signalled.json().signal, 'INT');

    const resized = await call(f.route, 'POST', '/dsh-remote/shell/resize', { server: f.entry.id, cols: 90, rows: 24 });
    assert.equal(resized.json().shell.cols, 90);

    const cleared = await call(f.route, 'DELETE', `/dsh-remote/terminal?server=${f.entry.id}`);
    assert.equal(cleared.json().ok, true);
    const empty = await call(f.route, 'GET', `/dsh-remote/terminal?server=${f.entry.id}&since=0`);
    assert.deepEqual(empty.json().events, []);

    const closed = await call(f.route, 'DELETE', '/dsh-remote/shells', { server: f.entry.id });
    assert.equal(closed.json().closed, true);
    assert.deepEqual((await call(f.route, 'GET', '/dsh-remote/shells')).json().shells, []);
  } finally {
    await f.close();
  }
});

test('the terminal routes honor allowWebExec and validate input', async () => {
  const f = await sshFixture({ allowWebExec: false });
  try {
    const blocked = await call(f.route, 'POST', '/dsh-remote/shells', { server: f.entry.id });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json().code, 'web-exec-disabled');
    const blockedInput = await call(f.route, 'POST', '/dsh-remote/shell/input', { server: f.entry.id, data: 'ls\n' });
    assert.equal(blockedInput.status, 403);
  } finally {
    await f.close();
  }

  const g = await sshFixture();
  try {
    const missing = await call(g.route, 'POST', '/dsh-remote/shell/input', { server: g.entry.id });
    assert.equal(missing.status, 400);
    assert.equal(missing.json().code, 'invalid-field');
    assert.equal(missing.json().field, 'data');

    const notOpen = await call(g.route, 'POST', '/dsh-remote/shell/input', { server: g.entry.id, data: 'ls\n' });
    assert.equal(notOpen.status, 400);
    assert.equal(notOpen.json().code, 'shell-not-open');

    const unknown = await call(g.route, 'GET', '/dsh-remote/terminal');
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json().code, 'invalid-field');
  } finally {
    await g.close();
  }
});

test('runs a command through the HTTP bridge', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-remote-routes-exec-'));
  const server = await startSshServer({ rootDir: join(root, 'remote') });
  const store = new ServerStore({ dir: join(root, 'store'), env: {} });
  const entry = store.upsert({
    name: 'test', host: server.host, port: server.port, username: server.username, password: server.password,
  }).server;
  const manager = new SshManager({ store });
  let route;
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    webServer: { register: (spec) => { route = spec; return () => {}; } },
  };
  registerRemoteRoutes(ctx, { store, manager, config: {} });
  try {
    const response = await call(route, 'POST', '/dsh-remote/exec', { server: entry.id, command: "printf 'bridge'" });
    assert.equal(response.status, 200);
    assert.equal(response.json().exec.stdout.text, 'bridge');
    assert.equal(response.json().exec.exitCode, 0);
  } finally {
    manager.closeAll();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
