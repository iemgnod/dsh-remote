/**
 * SSH transport: a small connection pool over `ssh2` plus command execution and
 * SFTP helpers.
 *
 * One pooled connection per server keeps repeated tool calls fast; any config
 * change (or an SSH-level close) drops the entry on the next use. The pool is
 * intentionally passive: it never reconnects in the background, so a dead
 * server costs one failed call, not a loop.
 */

import fs from 'node:fs';
import { dirname } from 'node:path';
import ssh2 from 'ssh2';
import {
  RemoteError,
  boundedText,
  connectionErrorText,
  connectionSignature,
  errorText,
  shellQuote,
} from './util.js';

const { Client } = ssh2;

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const DEFAULT_MAX_BYTES = 262144;
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** @param {unknown} value @param {string} field @returns {number} */
function positiveInteger(value, field, { min = 1, max = MAX_TIMEOUT_MS, fallback } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RemoteError(`${field} 必须是 ${min}..${max} 之间的整数`, { code: 'invalid-field', field });
  }
  return parsed;
}

/**
 * Compose the command string sshd hands to the user's shell.
 *
 * `workdir` and `env` are folded into the same script so sudo sees them too;
 * every interpolation is single-quoted.
 *
 * @param {{ command: string, workdir?: string, env?: Record<string, string>, sudo?: boolean, loginShell?: boolean }} options
 * @returns {string}
 */
export function buildRemoteCommand(options) {
  const lines = [];
  if (options.workdir) lines.push(`cd -- ${shellQuote(options.workdir)}`);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new RemoteError(`环境变量名非法：${key}`, { code: 'invalid-field', field: 'env' });
    }
    lines.push(`export ${key}=${shellQuote(String(value))}`);
  }
  lines.push(options.command);
  let script = lines.join('\n');
  if (options.loginShell) script = `bash -lc ${shellQuote(script)}`;
  if (options.sudo) script = `sudo -S -p '' sh -c ${shellQuote(script)}`;
  return script;
}

/**
 * Open one ssh2 client and resolve on `ready`.
 * @param {import('ssh2').ConnectConfig & { readyTimeout: number }} config
 * @param {string} label
 * @returns {Promise<import('ssh2').Client>}
 */
function openClient(config, label) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        // already gone
      }
      reject(new RemoteError(connectionErrorText(error, { host: config.host, port: config.port }), {
        code: 'connect-failed',
        cause: error,
      }));
    };
    const timer = setTimeout(() => {
      fail(new Error(`${label} Timed out while waiting for handshake after ${config.readyTimeout}ms`));
    }, Math.max(1000, config.readyTimeout) + 2000);
    client.once('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', fail);
    try {
      client.connect(config);
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Parse `ssh2` private-key material once, with a clearer failure than the
 * generic connection message.
 * @param {string} path
 * @returns {Buffer}
 */
function readPrivateKey(path) {
  try {
    return fs.readFileSync(path);
  } catch (error) {
    throw new RemoteError(`无法读取私钥 ${path}：${errorText(error)}`, {
      code: 'private-key-unreadable',
      field: 'privateKeyPath',
      cause: error,
    });
  }
}

/**
 * Build the `ssh2` connect config for one endpoint.
 * @param {import('./store.js').ServerConfig | import('./store.js').JumpConfig} endpoint
 * @param {string} label
 */
function endpointConfig(endpoint, label) {
  /** @type {import('ssh2').ConnectConfig} */
  const config = {
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.username,
    readyTimeout: 'readyTimeoutMs' in endpoint ? endpoint.readyTimeoutMs : 20000,
  };
  if (endpoint.password) config.password = endpoint.password;
  if (endpoint.privateKeyPath) config.privateKey = readPrivateKey(endpoint.privateKeyPath);
  if (endpoint.passphrase) config.passphrase = endpoint.passphrase;
  if (endpoint.useAgent) {
    if (process.platform === 'win32') config.agent = 'pageant';
    else {
      const sock = process.env.SSH_AUTH_SOCK;
      if (!sock) {
        throw new RemoteError(`${label} 启用了 SSH Agent，但 SSH_AUTH_SOCK 未设置`, {
          code: 'agent-unavailable',
          field: 'useAgent',
        });
      }
      config.agent = sock;
    }
  }
  config.keepaliveInterval = 'keepaliveIntervalMs' in endpoint ? endpoint.keepaliveIntervalMs : 15000;
  config.keepaliveCountMax = 3;
  return config;
}

/**
 * Connection pool + command/SFTP operations.
 */
export class SshManager {
  /**
   * @param {{ store: import('./store.js').ServerStore, idleMs?: number, logger?: { warn(message: string): void } }} options
   */
  constructor(options) {
    this.store = options.store;
    this.idleMs = options.idleMs ?? 60000;
    this.logger = options.logger;
    /** @type {Map<string, { client: import('ssh2').Client, jump?: import('ssh2').Client, signature: string, active: number, timer?: NodeJS.Timeout }>} */
    this.pool = new Map();
    this.closed = false;
  }

  /**
   * Acquire a ready client for one stored server, reusing a pooled connection
   * when the effective configuration has not changed.
   * @param {import('./store.js').ServerConfig} server
   * @returns {Promise<{ client: import('ssh2').Client, release: () => void }>}
   */
  async acquire(server) {
    if (this.closed) throw new RemoteError('插件正在卸载，无法建立新连接', { code: 'closed' });
    if (server.disabled) {
      throw new RemoteError(`服务器 ${server.name} 已停用；先在配置中启用它`, {
        code: 'server-disabled',
        field: 'disabled',
      });
    }
    const resolved = this.store.resolveConnection(server);
    const signature = connectionSignature(resolved);
    const existing = this.pool.get(server.id);
    if (existing && existing.signature === signature) return this.hold(server.id, existing);
    if (existing) this.drop(server.id);
    const created = await this.open(resolved);
    const entry = { ...created, signature, active: 0, timer: undefined };
    this.pool.set(server.id, entry);
    const guard = () => this.drop(server.id);
    entry.client.once('close', guard);
    entry.client.once('error', guard);
    return this.hold(server.id, entry);
  }

  /**
   * Open a fresh client, tunnelling through a jump host when configured.
   * @param {import('./store.js').ServerConfig} server - with secrets already resolved.
   * @returns {Promise<{ client: import('ssh2').Client, jump?: import('ssh2').Client }>}
   */
  async open(server) {
    const target = endpointConfig(server, '目标服务器');
    if (!server.jump) {
      const client = await openClient(/** @type {any} */ ({ ...target, readyTimeout: server.readyTimeoutMs }), '服务器');
      return { client };
    }
    const jump = await openClient(
      /** @type {any} */ ({ ...endpointConfig(server.jump, '跳板机'), readyTimeout: server.readyTimeoutMs }),
      '跳板机',
    );
    let sock;
    try {
      sock = await new Promise((resolve, reject) => {
        jump.forwardOut('127.0.0.1', 0, server.host, server.port, (error, stream) => {
          if (error) reject(error);
          else resolve(stream);
        });
      });
    } catch (error) {
      try {
        jump.end();
      } catch {
        // ignore
      }
      throw new RemoteError(
        `通过跳板机 ${server.jump.host}:${server.jump.port} 转发到 ${server.host}:${server.port} 失败：${connectionErrorText(error, server)}`,
        { code: 'jump-failed', cause: error },
      );
    }
    try {
      const client = await openClient(
        /** @type {any} */ ({ ...target, sock, readyTimeout: server.readyTimeoutMs }),
        '目标服务器',
      );
      return { client, jump };
    } catch (error) {
      try {
        jump.end();
      } catch {
        // ignore
      }
      throw error;
    }
  }

  /**
   * Mark one pooled connection busy and hand it out with its matching release.
   * @param {string} id
   * @param {{ client: import('ssh2').Client, active: number, timer?: NodeJS.Timeout }} entry
   */
  hold(id, entry) {
    entry.active += 1;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.active = Math.max(0, entry.active - 1);
      if (entry.active === 0 && !this.closed) {
        entry.timer = setTimeout(() => this.drop(id), this.idleMs);
        entry.timer.unref?.();
      }
    };
    return { client: entry.client, release };
  }

  /** @param {string} id */
  drop(id) {
    const entry = this.pool.get(id);
    if (!entry) return;
    this.pool.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    for (const client of [entry.client, entry.jump]) {
      try {
        client?.end();
      } catch {
        // already closed
      }
    }
  }

  closeAll() {
    this.closed = true;
    for (const id of [...this.pool.keys()]) this.drop(id);
  }

  /**
   * Run one command.
   * @param {import('./store.js').ServerConfig} server
   * @param {{
   *   command: string,
   *   workdir?: string,
   *   env?: Record<string, string>,
   *   sudo?: boolean,
   *   sudoPassword?: string,
   *   loginShell?: boolean,
   *   tty?: boolean,
   *   timeoutMs?: number,
   *   maxOutputBytes?: number,
   *   stdin?: string,
   *   signal?: AbortSignal,
   * }} options
   */
  async exec(server, options) {
    if (typeof options.command !== 'string' || options.command.trim() === '') {
      throw new RemoteError('command 不能为空', { code: 'invalid-field', field: 'command' });
    }
    if (options.command.length > 65536) {
      throw new RemoteError('command 过长（最多 65536 个字符）', { code: 'invalid-field', field: 'command' });
    }
    const workdir = options.workdir ?? (server.workdir || undefined);
    const env = options.env ?? {};
    if (typeof env !== 'object' || Array.isArray(env)) {
      throw new RemoteError('env 必须是对象', { code: 'invalid-field', field: 'env' });
    }
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') {
        throw new RemoteError(`env.${key} 必须是字符串`, { code: 'invalid-field', field: 'env' });
      }
    }
    if (options.sudo && !options.sudoPassword) {
      const fromEnv = this.store.env.DSH_REMOTE_SUDO_PASSWORD;
      if (fromEnv) options = { ...options, sudoPassword: fromEnv };
    }
    if (options.sudo && !options.sudoPassword && !options.tty) {
      throw new RemoteError('启用 sudo 时需要 sudoPassword（或用 tty:true 手动输入）；也可以通过环境变量 DSH_REMOTE_SUDO_PASSWORD 提供', {
        code: 'sudo-password-required',
        field: 'sudoPassword',
      });
    }
    const timeoutMs = positiveInteger(options.timeoutMs, 'timeoutMs', {
      min: 100,
      max: MAX_TIMEOUT_MS,
      fallback: DEFAULT_TIMEOUT_MS,
    });
    const maxBytes = positiveInteger(options.maxOutputBytes, 'maxOutputBytes', {
      min: 1024,
      max: 4194304,
      fallback: server.maxOutputBytes || DEFAULT_MAX_BYTES,
    });
    const command = buildRemoteCommand({
      command: options.command,
      workdir,
      env,
      sudo: options.sudo === true,
      loginShell: options.loginShell === true,
    });
    const { client, release } = await this.acquire(server);
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      /** @type {Buffer[]} */
      const out = [];
      /** @type {Buffer[]} */
      const err = [];
      let outBytes = 0;
      let errBytes = 0;
      let exitCode;
      let exitSignal;
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      /** @type {(() => void) | undefined} */
      let abortListener;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        release();
        if (timer) clearTimeout(timer);
        if (abortListener && options.signal) options.signal.removeEventListener('abort', abortListener);
        if (error) {
          reject(error);
          return;
        }
        resolve({
          server: server.id,
          command: options.command,
          stdout: boundedText(Buffer.concat(out), maxBytes),
          stderr: boundedText(Buffer.concat(err), maxBytes),
          exitCode: typeof exitCode === 'number' ? exitCode : -1,
          timedOut,
          cancelled,
          durationMs: Date.now() - startedAt,
          bytesTotal: outBytes + errBytes,
        });
      };

      const kill = (reason) => {
        if (settled) return;
        if (reason === 'timeout') timedOut = true;
        if (reason === 'cancel') cancelled = true;
        try {
          stream.signal('KILL');
        } catch {
          // Some servers do not support signals; close() below still helps.
        }
        try {
          stream.close();
        } catch {
          // ignore
        }
        // Do not wait forever for a server that ignores the close.
        setTimeout(() => finish(
          reason === 'timeout'
            ? undefined
            : undefined,
        ), 1500).unref?.();
      };

      timer = setTimeout(() => kill('timeout'), timeoutMs);
      timer.unref?.();
      if (options.signal) {
        if (options.signal.aborted) {
          finish();
          return;
        }
        abortListener = () => kill('cancel');
        options.signal.addEventListener('abort', abortListener, { once: true });
      }

      /** @type {import('ssh2').ClientChannel} */
      let stream;
      const handle = (error, channel) => {
        if (error) {
          finish(new RemoteError(connectionErrorText(error, server), { code: 'exec-failed', cause: error }));
          return;
        }
        stream = channel;
        channel.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          outBytes += buffer.length;
          if (outBytes <= maxBytes) out.push(buffer);
        });
        channel.stderr.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          errBytes += buffer.length;
          if (errBytes <= maxBytes) err.push(buffer);
        });
        channel.on('exit', (code, signal) => {
          exitCode = code;
          exitSignal = signal;
        });
        channel.on('close', () => finish());
        channel.on('error', (streamError) => {
          finish(new RemoteError(`命令通道错误：${errorText(streamError)}`, { code: 'channel-error', cause: streamError }));
        });
        // Only close stdin when this call actually wrote to it. Closing it
        // unconditionally tears the channel down before a command that never
        // reads stdin has produced output.
        if (options.sudo && options.sudoPassword) {
          channel.write(`${options.sudoPassword}\n`);
          channel.end();
        } else if (options.stdin) {
          channel.write(options.stdin);
          channel.end();
        }
      };
      try {
        if (options.tty) {
          client.exec(command, { pty: { term: 'xterm-256color', cols: 120, rows: 40 } }, handle);
        } else {
          client.exec(command, handle);
        }
      } catch (error) {
        finish(new RemoteError(`启动命令失败：${errorText(error)}`, { code: 'exec-failed', cause: error }));
      }
    });
  }

  /**
   * Open a short-lived SFTP session.
   * @param {import('./store.js').ServerConfig} server
   * @param {(sftp: import('ssh2').SFTPWrapper) => Promise<T>} run
   * @returns {Promise<T>}
   * @template T
   */
  async withSftp(server, run) {
    const { client, release } = await this.acquire(server);
    return new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          release();
          reject(new RemoteError(`无法打开 SFTP 会话：${errorText(error)}（服务器可能禁用了 SFTP 子系统）`, {
            code: 'sftp-unavailable',
            cause: error,
          }));
          return;
        }
        run(sftp).then(resolve, reject).finally(() => {
          try {
            sftp.end();
          } catch {
            // ignore
          }
          release();
        });
      });
    });
  }

  /**
   * @param {import('./store.js').ServerConfig} server
   * @param {{ localPath: string, remotePath: string }} options
   */
  async upload(server, { localPath, remotePath }) {
    let stat;
    try {
      stat = fs.statSync(localPath);
    } catch (error) {
      throw new RemoteError(`本地文件不存在：${localPath}`, { code: 'local-not-found', field: 'localPath', cause: error });
    }
    if (!stat.isFile()) throw new RemoteError(`本地路径不是文件：${localPath}`, { code: 'not-a-file', field: 'localPath' });
    await this.withSftp(server, async (sftp) => {
      await mkdirRemote(sftp, dirname(remotePath));
      await new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (error) => {
          if (error) reject(new RemoteError(`上传失败：${errorText(error)}`, { code: 'sftp-put-failed', cause: error }));
          else resolve();
        });
      });
    });
    return { bytes: stat.size };
  }

  /**
   * @param {import('./store.js').ServerConfig} server
   * @param {{ localPath: string, remotePath: string }} options
   */
  async download(server, { localPath, remotePath }) {
    await this.withSftp(server, async (sftp) => {
      const stat = await statRemote(sftp, remotePath);
      if (!stat.isFile()) throw new RemoteError(`远端路径不是文件：${remotePath}`, { code: 'not-a-file', field: 'remotePath' });
      fs.mkdirSync(dirname(localPath), { recursive: true });
      await new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (error) => {
          if (error) reject(new RemoteError(`下载失败：${errorText(error)}`, { code: 'sftp-get-failed', cause: error }));
          else resolve();
        });
      });
      return stat.size;
    });
    return { bytes: fs.statSync(localPath).size };
  }

  /**
   * @param {import('./store.js').ServerConfig} server
   * @param {{ remotePath: string, maxBytes?: number }} options
   */
  async readRemoteFile(server, { remotePath, maxBytes }) {
    const limit = positiveInteger(maxBytes, 'maxBytes', { min: 1, max: MAX_READ_BYTES, fallback: DEFAULT_MAX_BYTES });
    return this.withSftp(server, async (sftp) => {
      const stat = await statRemote(sftp, remotePath);
      if (!stat.isFile()) throw new RemoteError(`远端路径不是文件：${remotePath}`, { code: 'not-a-file', field: 'remotePath' });
      const chunks = [];
      let total = 0;
      await new Promise((resolve, reject) => {
        const stream = sftp.createReadStream(remotePath);
        stream.on('data', (chunk) => {
          if (total < limit) chunks.push(chunk.subarray(0, Math.max(0, limit - total)));
          total += chunk.length;
        });
        stream.on('error', (error) => reject(new RemoteError(`读取失败：${errorText(error)}`, { code: 'sftp-read-failed', cause: error })));
        stream.on('end', resolve);
      });
      const buffer = Buffer.concat(chunks);
      return { ...boundedText(buffer, limit), size: stat.size, truncated: total > limit };
    });
  }

  /**
   * @param {import('./store.js').ServerConfig} server
   * @param {{ remotePath: string, content: string, encoding?: BufferEncoding, mode?: number, createParents?: boolean }} options
   */
  async writeRemoteFile(server, { remotePath, content, encoding = 'utf8', mode, createParents = true }) {
    if (typeof content !== 'string') {
      throw new RemoteError('content 必须是字符串（二进制文件请用上传）', { code: 'invalid-field', field: 'content' });
    }
    if (encoding !== 'utf8') {
      throw new RemoteError(`不支持的编码：${encoding}；目前只支持 utf8`, { code: 'invalid-field', field: 'encoding' });
    }
    await this.withSftp(server, async (sftp) => {
      if (createParents) await mkdirRemote(sftp, dirname(remotePath));
      await new Promise((resolve, reject) => {
        const options = mode === undefined ? undefined : { mode };
        sftp.writeFile(remotePath, content, options ?? {}, (error) => {
          if (error) reject(new RemoteError(`写入失败：${errorText(error)}`, { code: 'sftp-write-failed', cause: error }));
          else resolve();
        });
      });
    });
    return { bytes: Buffer.byteLength(content, 'utf8') };
  }

  /**
   * @param {import('./store.js').ServerConfig} server
   * @param {{ remotePath: string }} options
   */
  async listDirectory(server, { remotePath }) {
    return this.withSftp(server, async (sftp) => {
      const list = await new Promise((resolve, reject) => {
        sftp.readdir(remotePath, (error, entries) => {
          if (error) reject(new RemoteError(`列目录失败：${errorText(error)}`, { code: 'sftp-readdir-failed', cause: error }));
          else resolve(entries);
        });
      });
      return list.filter((entry) => entry.filename !== '.' && entry.filename !== '..').map((entry) => ({
        name: entry.filename,
        type: modeType(entry.attrs?.mode),
        size: entry.attrs?.size ?? 0,
        mtime: entry.attrs?.mtime ?? 0,
        mode: entry.attrs?.mode ?? 0,
      })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    });
  }

  /**
   * @param {import('./store.js').ServerConfig} server
   * @param {{ remotePath: string }} options
   */
  async statRemote(server, { remotePath }) {
    return this.withSftp(server, async (sftp) => {
      const stat = await statRemote(sftp, remotePath);
      return {
        type: modeType(stat.mode),
        size: stat.size,
        mtime: stat.mtime,
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
      };
    });
  }

  /**
   * Run a harmless probe and return host facts.
   * @param {import('./store.js').ServerConfig} server
   * @param {{ timeoutMs?: number }} [options]
   */
  async test(server, options = {}) {
    const startedAt = Date.now();
    const result = await this.exec(server, {
      command: 'printf \'DSH_REMOTE_OK\\n%s\\n%s\\n%s\\n\' "$(id -un 2>/dev/null || whoami)" "$(uname -srm 2>/dev/null || echo unknown)" "$(pwd)"',
      timeoutMs: options.timeoutMs ?? 20000,
      maxOutputBytes: 65536,
    });
    const lines = result.stdout.text.split(/\r?\n/).filter(Boolean);
    const ok = result.exitCode === 0 && lines[0] === 'DSH_REMOTE_OK';
    return {
      ok,
      server: server.id,
      latencyMs: Date.now() - startedAt,
      user: lines[1] ?? '',
      platform: lines[2] ?? '',
      home: lines[3] ?? '',
      exitCode: result.exitCode,
      stderr: result.stderr.text,
    };
  }
}

/**
 * @param {number | undefined} mode
 * @returns {'dir' | 'file' | 'link' | 'other'}
 */
function modeType(mode) {
  if (typeof mode !== 'number') return 'other';
  const type = mode & 0o170000;
  if (type === 0o040000) return 'dir';
  if (type === 0o100000) return 'file';
  if (type === 0o120000) return 'link';
  return 'other';
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} path
 */
function statRemote(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, stat) => {
      if (error) reject(new RemoteError(`无法读取远端路径信息：${path}：${errorText(error)}`, { code: 'sftp-stat-failed', cause: error }));
      else resolve(stat);
    });
  });
}

/**
 * `mkdir -p` over SFTP. Existing directories are ignored.
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} directory
 */
async function mkdirRemote(sftp, directory) {
  if (!directory || directory === '.' || directory === '/') return;
  const absolute = directory.startsWith('/');
  const parts = directory.split('/').filter(Boolean);
  let current = absolute ? '' : '.';
  for (const part of parts) {
    current = current === '' ? `/${part}` : current === '.' ? part : `${current}/${part}`;
    await new Promise((resolve, reject) => {
      sftp.mkdir(current, (error) => {
        // SFTP status 4 (failure) is what servers return for an existing dir;
        // there is no portable EEXIST code at this layer, so verify instead.
        if (!error) {
          resolve();
          return;
        }
        sftp.stat(current, (statError) => {
          if (!statError) resolve();
          else reject(new RemoteError(`无法创建远端目录 ${current}：${errorText(error)}`, { code: 'sftp-mkdir-failed', cause: error }));
        });
      });
    });
  }
}

export { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_READ_BYTES };
