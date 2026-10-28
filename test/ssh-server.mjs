/**
 * In-process SSH/SFTP server used by the test suite. It is deliberately small:
 * password auth, one exec session, a real `bash -lc` child, an SFTP v3 subset,
 * and TCP forwarding so the jump-host path can be exercised.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import ssh2 from 'ssh2';
import { runScript } from './mini-shell.mjs';

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const OPEN = OPEN_MODE ?? {
  READ: 0x1,
  WRITE: 0x2,
  APPEND: 0x4,
  CREAT: 0x8,
  TRUNC: 0x10,
  EXCL: 0x20,
};
const STATUS = STATUS_CODE ?? { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 };

const HOST_KEYS = utils.generateKeyPairSync('ed25519');

/**
 * @param {{ username?: string, password?: string, rootDir: string, forwardTo?: number }} options
 */
export async function startSshServer(options) {
  const username = options.username ?? 'tester';
  const password = options.password ?? 'secret';
  const rootDir = path.resolve(options.rootDir);
  fs.mkdirSync(rootDir, { recursive: true });

  const server = new Server({ hostKeys: [HOST_KEYS.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          let cancelled = false;
          stream.on('close', () => { cancelled = true; });
          runScript(info.command, { cwd: rootDir, env: { ...process.env }, username, cancelled: () => cancelled })
            .then(({ stdout, stderr, code }) => {
              if (cancelled) return;
              if (stdout.length > 0) stream.write(stdout);
              if (stderr.length > 0) stream.stderr.write(stderr);
              stream.exit(code);
              stream.end();
            })
            .catch((error) => {
              if (cancelled) return;
              stream.stderr.write(String(error));
              stream.exit(1);
              stream.end();
            });
        });
        session.on('sftp', (acceptSftp) => {
          handleSftp(acceptSftp(), rootDir);
        });
      });
      if (options.forwardTo !== undefined) {
        client.on('tcpip', (acceptTcp, _reject, info) => {
          void info;
          const stream = acceptTcp();
          const socket = net.connect(options.forwardTo, '127.0.0.1');
          socket.on('error', () => stream.close());
          stream.pipe(socket).pipe(stream);
          stream.on('close', () => socket.destroy());
        });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  return {
    port: address.port,
    host: '127.0.0.1',
    username,
    password,
    rootDir,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function handleSftp(sftp, rootDir) {
  const handles = new Map();
  let next = 1;

  const resolveLocal = (requested) => {
    const clean = String(requested).replace(/\\/g, '/');
    const relative = clean.startsWith('/') ? clean.slice(1) : clean;
    const local = path.resolve(rootDir, relative);
    if (local !== rootDir && !local.startsWith(rootDir + path.sep)) throw new Error('outside root');
    return local;
  };
  const makeHandle = (value) => {
    const id = next++;
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id, 0);
    handles.set(id, value);
    return buffer;
  };
  const getHandle = (buffer) => handles.get(buffer.readUInt32BE(0));
  const attrsOf = (stat) => ({
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  });
  const fail = (reqid, error) => {
    const code = error && error.code === 'ENOENT' ? STATUS.NO_SUCH_FILE
      : error && error.code === 'EACCES' ? STATUS.PERMISSION_DENIED
        : STATUS.FAILURE;
    sftp.status(reqid, code);
  };
  const readFlags = (flags) => {
    if (flags & OPEN.WRITE) {
      if (flags & OPEN.APPEND) return 'a';
      if (flags & OPEN.EXCL) return 'wx';
      if (flags & OPEN.READ) return 'r+';
      return 'w';
    }
    return 'r';
  };

  sftp.on('OPEN', (reqid, filename, flags, attrs) => {
    try {
      const fd = fs.openSync(resolveLocal(filename), readFlags(flags), attrs?.mode ?? 0o644);
      sftp.handle(reqid, makeHandle({ kind: 'file', fd }));
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('READ', (reqid, handle, offset, length) => {
    const entry = getHandle(handle);
    if (!entry || entry.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE);
    const buffer = Buffer.alloc(length);
    try {
      const bytes = fs.readSync(entry.fd, buffer, 0, length, offset);
      if (bytes === 0) sftp.status(reqid, STATUS.EOF);
      else sftp.data(reqid, buffer.subarray(0, bytes));
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const entry = getHandle(handle);
    if (!entry || entry.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE);
    try {
      fs.writeSync(entry.fd, data, 0, data.length, offset);
      sftp.status(reqid, STATUS.OK);
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('CLOSE', (reqid, handle) => {
    const entry = getHandle(handle);
    if (!entry) return sftp.status(reqid, STATUS.FAILURE);
    handles.delete(handle.readUInt32BE(0));
    try {
      if (entry.kind === 'file') fs.closeSync(entry.fd);
      sftp.status(reqid, STATUS.OK);
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('FSTAT', (reqid, handle) => {
    const entry = getHandle(handle);
    if (!entry || entry.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE);
    try {
      sftp.attrs(reqid, attrsOf(fs.fstatSync(entry.fd)));
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('FSETSTAT', (reqid, handle, attrs) => {
    const entry = getHandle(handle);
    if (!entry || entry.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE);
    try {
      if (attrs?.size !== undefined) fs.ftruncateSync(entry.fd, attrs.size);
      if (attrs?.mode !== undefined) fs.fchmodSync(entry.fd, attrs.mode);
      sftp.status(reqid, STATUS.OK);
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('STAT', (reqid, requested) => {
    try {
      sftp.attrs(reqid, attrsOf(fs.statSync(resolveLocal(requested))));
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('LSTAT', (reqid, requested) => {
    try {
      sftp.attrs(reqid, attrsOf(fs.lstatSync(resolveLocal(requested))));
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('REALPATH', (reqid, requested) => {
    try {
      const local = resolveLocal(requested);
      const relative = path.relative(rootDir, local).split(path.sep).join('/');
      sftp.name(reqid, [{ filename: `/${relative}` }]);
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('SETSTAT', (reqid, requested, attrs) => {
    try {
      const local = resolveLocal(requested);
      if (attrs?.size !== undefined) fs.truncateSync(local, attrs.size);
      if (attrs?.mode !== undefined) fs.chmodSync(local, attrs.mode);
      if (attrs?.atime !== undefined && attrs?.mtime !== undefined) {
        fs.utimesSync(local, attrs.atime, attrs.mtime);
      }
      sftp.status(reqid, STATUS.OK);
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('OPENDIR', (reqid, requested) => {
    try {
      const entries = fs.readdirSync(resolveLocal(requested), { withFileTypes: true }).map((entry) => {
        const stat = fs.statSync(path.join(resolveLocal(requested), entry.name));
        return { filename: entry.name, longname: entry.name, attrs: attrsOf(stat) };
      });
      sftp.handle(reqid, makeHandle({ kind: 'dir', entries, index: 0 }));
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('READDIR', (reqid, handle) => {
    const entry = getHandle(handle);
    if (!entry || entry.kind !== 'dir') return sftp.status(reqid, STATUS.FAILURE);
    if (entry.index >= entry.entries.length) return sftp.status(reqid, STATUS.EOF);
    const batch = entry.entries.slice(entry.index, entry.index + 16);
    entry.index += batch.length;
    sftp.name(reqid, batch);
  });
  sftp.on('MKDIR', (reqid, requested, attrs) => {
    try {
      fs.mkdirSync(resolveLocal(requested), { mode: attrs?.mode ?? 0o755 });
      sftp.status(reqid, STATUS.OK);
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('RMDIR', (reqid, requested) => {
    try {
      fs.rmdirSync(resolveLocal(requested));
      sftp.status(reqid, STATUS.OK);
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('REMOVE', (reqid, requested) => {
    try {
      fs.unlinkSync(resolveLocal(requested));
      sftp.status(reqid, STATUS.OK);
    } catch (error) {
      fail(reqid, error);
    }
  });
  sftp.on('RENAME', (reqid, from, to) => {
    try {
      fs.renameSync(resolveLocal(from), resolveLocal(to));
      sftp.status(reqid, STATUS.OK);
    } catch (error) {
      fail(reqid, error);
    }
  });
}
