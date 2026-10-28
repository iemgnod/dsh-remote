/**
 * Shared helpers for dsh-remote.
 *
 * Kept dependency-free so the store, the SSH layer and the HTTP routes can be
 * exercised by plain Node without booting DSH.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** A user-facing, expected failure. Tools turn `message` into their error text. */
export class RemoteError extends Error {
  /**
   * @param {string} message - what the caller has to change.
   * @param {{ code?: string, field?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RemoteError';
    this.code = options.code ?? 'remote-error';
    this.field = options.field;
  }
}

/**
 * Absolute DSH home. `DSH_HOME` wins, matching the harness' own resolution.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim();
  return configured ? configured : join(homedir(), '.dsh');
}

/** Directory this plugin owns under the harness home. */
export function dataDirectory(env = process.env) {
  return join(dshHome(env), 'dsh-remote');
}

/**
 * Render any thrown value as a single-line message.
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Quote one argument so a POSIX shell reads it as a single literal word.
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Expand `env:NAME` and `${NAME}` secret references.
 *
 * A literal value that merely starts with `env:` is indistinguishable from a
 * reference, so the accepted spellings are exactly those two forms; use
 * `\\env:...` to force a literal `env:...` value in the unlikely case.
 *
 * @param {string | undefined} value
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} field - human name used in the failure message.
 * @returns {string | undefined}
 */
export function resolveSecretReference(value, env = process.env, field = 'secret') {
  if (value === undefined || value === '') return value;
  let name;
  if (value.startsWith('env:')) name = value.slice(4).trim();
  else {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (!match) return value;
    name = match[1];
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new RemoteError(`${field} 引用了非法环境变量名：${JSON.stringify(value)}`, {
      code: 'bad-secret-reference',
      field,
    });
  }
  const resolved = env[name];
  if (resolved === undefined || resolved === '') {
    throw new RemoteError(`${field} 引用的环境变量 ${name} 未设置或为空`, {
      code: 'missing-secret-env',
      field,
    });
  }
  return resolved;
}

/**
 * Reject a malformed `env:NAME` / `${NAME}` reference without requiring the
 * variable to exist yet: users often save the inventory before exporting it.
 * @param {string | undefined} value
 * @param {string} field
 */
export function assertSecretReferenceSyntax(value, field) {
  if (value === undefined || value === '') return;
  if (value.startsWith('env:')) {
    const name = value.slice(4).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new RemoteError(`${field} 引用了非法环境变量名：${JSON.stringify(value)}`, {
        code: 'bad-secret-reference',
        field,
      });
    }
    return;
  }
  const match = /^\$\{([^}]*)\}$/.exec(value);
  if (!match) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(match[1])) {
    throw new RemoteError(`${field} 引用了非法环境变量名：${JSON.stringify(value)}`, {
      code: 'bad-secret-reference',
      field,
    });
  }
}

/**
 * Project a canonical value onto lossless JSON. `undefined` object properties
 * are dropped (the host rejects them), array holes become `null`, and
 * non-finite numbers become `null`.
 * @param {unknown} value
 * @returns {unknown}
 */
export function toJsonValue(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry));
  if (typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    const out = {};
    for (const [key, entry] of Object.entries(record)) {
      if (entry !== undefined) out[key] = toJsonValue(entry);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/**
 * Bound one byte string and report whether anything was dropped.
 * @param {Buffer} buffer
 * @param {number} limit
 * @returns {{ text: string, truncated: boolean, bytes: number }}
 */
export function boundedText(buffer, limit) {
  const bytes = buffer.byteLength;
  if (bytes <= limit) return { text: buffer.toString('utf8'), truncated: false, bytes };
  return { text: buffer.subarray(0, limit).toString('utf8'), truncated: true, bytes };
}

/**
 * One stable, non-secret connection fingerprint. Changing any field that
 * affects the socket invalidates a pooled connection.
 * @param {Record<string, unknown>} server
 * @returns {string}
 */
export function connectionSignature(server) {
  return JSON.stringify([
    server.host,
    server.port,
    server.username,
    server.password ?? '',
    server.privateKeyPath ?? '',
    server.passphrase ?? '',
    server.useAgent === true,
    server.readyTimeoutMs ?? 20000,
    server.jump?.host ?? '',
    server.jump?.port ?? '',
    server.jump?.username ?? '',
    server.jump?.password ?? '',
    server.jump?.privateKeyPath ?? '',
    server.jump?.passphrase ?? '',
    server.jump?.useAgent === true,
  ]);
}

/**
 * Plain-language hint for the SSH failures users actually hit.
 * @param {unknown} error
 * @param {{ host?: string, port?: number }} target
 * @returns {string}
 */
export function connectionErrorText(error, target = {}) {
  const raw = errorText(error);
  const where = target.host === undefined
    ? ''
    : ` (${target.host}${target.port === undefined ? '' : `:${target.port}`})`;
  if (/All configured authentication methods failed|authentication failed/i.test(raw)) {
    return `认证失败${where}：用户名、密码、私钥或口令不正确，也可能服务器只允许 publickey 登录。原始错误：${raw}`;
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return `连接被拒绝${where}：端口没有 SSH 服务在监听，检查端口与防火墙。原始错误：${raw}`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return `主机名无法解析${where}：检查主机名或 DNS。原始错误：${raw}`;
  }
  if (/Timed out while waiting for handshake|ETIMEDOUT|timeout/i.test(raw)) {
    return `连接超时${where}：网络不通、SSH 端口被拦截，或跳板机配置有误。原始错误：${raw}`;
  }
  if (/ENOENT/i.test(raw)) {
    return `读取私钥失败${where}：私钥文件不存在或不可读。原始错误：${raw}`;
  }
  if (/Cannot parse privateKey|bad passphrase|Bad passphrase|integrity check failed/i.test(raw)) {
    return `私钥无法解密${where}：口令错误或私钥格式不受支持（需要 OpenSSH 或 PEM 私钥）。原始错误：${raw}`;
  }
  if (/Host key verification failed/i.test(raw)) {
    return `主机密钥校验失败${where}。原始错误：${raw}`;
  }
  return `SSH 连接失败${where}：${raw}`;
}
