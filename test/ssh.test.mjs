import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerStore } from '../src/store.js';
import { SshManager } from '../src/ssh.js';
import { startSshServer } from './ssh-server.mjs';

/**
 * One store + manager + server fixture.
 */
async function fixture(extra = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-remote-ssh-'));
  const remoteRoot = join(root, 'remote');
  const server = await startSshServer({ rootDir: remoteRoot, ...extra });
  const store = new ServerStore({ dir: join(root, 'store'), env: {} });
  const entry = store.upsert({
    name: 'test', host: server.host, port: server.port, username: server.username, password: server.password,
  }).server;
  const manager = new SshManager({ store, idleMs: 60000 });
  return {
    root,
    remoteRoot,
    server,
    store,
    manager,
    entry,
    async close() {
      manager.closeAll();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('exec returns stdout, stderr and the exit code', async () => {
  const f = await fixture();
  try {
    const result = await f.manager.exec(f.entry, { command: "printf 'hello\\n'" });
    assert.equal(result.stdout.text, 'hello\n');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);

    const failed = await f.manager.exec(f.entry, { command: "printf 'oops' >&2; exit 3" });
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.stderr.text, 'oops');
  } finally {
    await f.close();
  }
});

test('exec applies workdir, env and a login shell', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(join(f.remoteRoot, 'sub'));
    const result = await f.manager.exec(f.entry, {
      command: 'printf "%s|%s" "$PWD" "$FOO"',
      workdir: 'sub',
      env: { FOO: "a b'c" },
    });
    assert.ok(result.stdout.text.endsWith("sub|a b'c"), result.stdout.text);
    assert.equal(result.exitCode, 0);

    const login = await f.manager.exec(f.entry, { command: 'printf ok', loginShell: true });
    assert.equal(login.stdout.text, 'ok');
  } finally {
    await f.close();
  }
});

test('exec enforces timeout and cancellation', async () => {
  const f = await fixture();
  try {
    const started = Date.now();
    const timed = await f.manager.exec(f.entry, { command: 'sleep 5', timeoutMs: 400 });
    assert.equal(timed.timedOut, true);
    assert.ok(Date.now() - started < 4000, 'timeout should settle promptly');

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const cancelled = await f.manager.exec(f.entry, { command: 'sleep 5', signal: controller.signal });
    assert.equal(cancelled.cancelled, true);
  } finally {
    await f.close();
  }
});

test('test() reports host facts and reuses the pooled connection', async () => {
  const f = await fixture();
  try {
    const first = await f.manager.test(f.entry);
    assert.equal(first.ok, true);
    assert.ok(first.platform.length > 0);
    assert.ok(first.home.length > 0);
    assert.equal(f.manager.pool.size, 1);
    await f.manager.test(f.entry);
    assert.equal(f.manager.pool.size, 1);
  } finally {
    await f.close();
  }
});

test('SFTP upload, download, read, write, list and stat', async () => {
  const f = await fixture();
  try {
    const local = join(f.root, 'local.txt');
    fs.writeFileSync(local, 'uploaded-content');
    const uploaded = await f.manager.upload(f.entry, { localPath: local, remotePath: 'dir/uploaded.txt' });
    assert.equal(uploaded.bytes, 'uploaded-content'.length);
    assert.equal(fs.readFileSync(join(f.remoteRoot, 'dir/uploaded.txt'), 'utf8'), 'uploaded-content');

    const read = await f.manager.readRemoteFile(f.entry, { remotePath: 'dir/uploaded.txt' });
    assert.equal(read.text, 'uploaded-content');
    assert.equal(read.truncated, false);

    const written = await f.manager.writeRemoteFile(f.entry, { remotePath: 'dir/written.txt', content: 'hello 世界' });
    assert.ok(written.bytes > 6);

    const listing = await f.manager.listDirectory(f.entry, { remotePath: 'dir' });
    const names = listing.map((item) => item.name).sort();
    assert.deepEqual(names, ['uploaded.txt', 'written.txt']);
    assert.ok(listing.every((item) => item.type === 'file'));

    const stat = await f.manager.statRemote(f.entry, { remotePath: 'dir/written.txt' });
    assert.equal(stat.type, 'file');
    assert.ok(stat.size > 0);

    const target = join(f.root, 'downloaded.txt');
    const downloaded = await f.manager.download(f.entry, { localPath: target, remotePath: 'dir/written.txt' });
    assert.ok(downloaded.bytes > 0);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello 世界');
  } finally {
    await f.close();
  }
});

test('readRemoteFile truncates and caps oversized reads', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(join(f.remoteRoot, 'big.txt'), 'x'.repeat(5000));
    const read = await f.manager.readRemoteFile(f.entry, { remotePath: 'big.txt', maxBytes: 100 });
    assert.equal(read.text.length, 100);
    assert.equal(read.truncated, true);
    assert.equal(read.size, 5000);
  } finally {
    await f.close();
  }
});

test('jump host forwards the target connection', async () => {
  const target = await fixture();
  try {
    const jumpRoot = fs.mkdtempSync(join(tmpdir(), 'dsh-remote-jump-'));
    const jumpServer = await startSshServer({ rootDir: join(jumpRoot, 'remote'), forwardTo: target.server.port });
    const store = new ServerStore({ dir: join(jumpRoot, 'store'), env: {} });
    const entry = store.upsert({
      name: 'behind-jump',
      host: '127.0.0.1',
      port: target.server.port,
      username: target.server.username,
      password: target.server.password,
      jumpHost: '127.0.0.1',
      jumpPort: jumpServer.port,
      jumpUsername: jumpServer.username,
      jumpPassword: jumpServer.password,
    }).server;
    const manager = new SshManager({ store, idleMs: 60000 });
    try {
      const result = await manager.exec(entry, { command: "printf 'via-jump'" });
      assert.equal(result.stdout.text, 'via-jump');
      assert.equal(result.exitCode, 0);
    } finally {
      manager.closeAll();
      await jumpServer.close();
      fs.rmSync(jumpRoot, { recursive: true, force: true });
    }
  } finally {
    await target.close();
  }
});

test('wrong password and disabled servers fail with actionable messages', async () => {
  const f = await fixture();
  try {
    const wrongStore = new ServerStore({ dir: join(f.root, 'wrong-store'), env: {} });
    const wrong = wrongStore.upsert({
      name: 'wrong', host: f.server.host, port: f.server.port, username: f.server.username, password: 'nope',
    }).server;
    const manager = new SshManager({ store: wrongStore });
    try {
      await assert.rejects(
        manager.exec(wrong, { command: 'printf x' }),
        (error) => /认证失败/.test(error.message),
      );
    } finally {
      manager.closeAll();
    }

    const disabled = { ...f.entry, disabled: true };
    await assert.rejects(
      f.manager.exec(disabled, { command: 'printf x' }),
      (error) => /已停用/.test(error.message),
    );
  } finally {
    await f.close();
  }
});
