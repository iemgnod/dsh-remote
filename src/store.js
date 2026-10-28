/**
 * Server inventory stored under `<DSH_HOME>/dsh-remote/servers.json`.
 *
 * Secrets are stored as ordinary strings, so the file is created with mode
 * 0600. Both `env:NAME` and `${NAME}` are kept as references and resolved only
 * when a connection is opened, which lets a user keep passwords out of the
 * file entirely.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RemoteError, assertSecretReferenceSyntax, dataDirectory, resolveSecretReference } from './util.js';

const FILE_VERSION = 1;
const MAX_SERVERS = 200;
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_KEEPALIVE_MS = 15000;
const DEFAULT_MAX_OUTPUT_BYTES = 262144;

/** Fields accepted by the public save shape. Kept explicit so a typo cannot silently vanish. */
const SERVER_FIELDS = new Set([
  'id', 'name', 'host', 'port', 'username',
  'password', 'privateKeyPath', 'passphrase', 'useAgent',
  'workdir', 'description', 'tags', 'disabled',
  'readyTimeoutMs', 'keepaliveIntervalMs', 'maxOutputBytes',
  'jumpHost', 'jumpPort', 'jumpUsername', 'jumpPassword', 'jumpPrivateKeyPath', 'jumpPassphrase', 'jumpUseAgent',
  'clearPassword', 'clearPassphrase', 'clearJumpPassword', 'clearJumpPassphrase',
]);

/** Fields a caller may not set directly. */
const RESERVED_FIELDS = new Set(['createdAt', 'updatedAt', 'authType', 'hasPassword', 'hasPassphrase']);

/**
 * @typedef {object} JumpConfig
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {string} [password]
 * @property {string} [privateKeyPath]
 * @property {string} [passphrase]
 * @property {boolean} [useAgent]
 */

/**
 * @typedef {object} ServerConfig
 * @property {string} id
 * @property {string} name
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {string} [password]
 * @property {string} [privateKeyPath]
 * @property {string} [passphrase]
 * @property {boolean} [useAgent]
 * @property {string} workdir
 * @property {string} description
 * @property {string[]} tags
 * @property {boolean} disabled
 * @property {number} readyTimeoutMs
 * @property {number} keepaliveIntervalMs
 * @property {number} maxOutputBytes
 * @property {JumpConfig} [jump]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

function stringField(value, field, { required = false, max = 1024 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RemoteError(`缺少必填字段 ${field}`, { code: 'invalid-field', field });
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new RemoteError(`${field} 必须是字符串`, { code: 'invalid-field', field });
  }
  const trimmed = field === 'password' || field === 'passphrase'
    ? value // a password may legitimately contain leading/trailing spaces
    : value.trim();
  if (required && trimmed === '') {
    throw new RemoteError(`${field} 不能为空`, { code: 'invalid-field', field });
  }
  if (trimmed.length > max) {
    throw new RemoteError(`${field} 过长（最多 ${max} 个字符）`, { code: 'invalid-field', field });
  }
  return trimmed;
}

function integerField(value, field, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new RemoteError(`${field} 必须是整数`, { code: 'invalid-field', field });
  }
  if (parsed < min || parsed > max) {
    throw new RemoteError(`${field} 必须在 ${min}..${max} 之间`, { code: 'invalid-field', field });
  }
  return parsed;
}

function booleanField(value, field, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new RemoteError(`${field} 必须是布尔值`, { code: 'invalid-field', field });
  }
  return value;
}

function rejectUnknown(input) {
  const unknown = Object.keys(input).filter((key) => !SERVER_FIELDS.has(key) && !RESERVED_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new RemoteError(`不认识的字段：${unknown.join(', ')}；允许的字段：${[...SERVER_FIELDS].join(', ')}`, {
      code: 'unknown-field',
      field: unknown[0],
    });
  }
  // Reserved names are a contract mistake, not user input; refuse instead of dropping.
  const reserved = Object.keys(input).filter((key) => RESERVED_FIELDS.has(key));
  if (reserved.length > 0) {
    throw new RemoteError(`${reserved.join(', ')} 由系统维护，不能直接写入`, {
      code: 'reserved-field',
      field: reserved[0],
    });
  }
}

function tagList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
    throw new RemoteError('tags 必须是字符串数组', { code: 'invalid-field', field: 'tags' });
  }
  if (value.length > 20) {
    throw new RemoteError('tags 最多 20 个', { code: 'invalid-field', field: 'tags' });
  }
  return [...new Set(value.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function hasAuth(entry) {
  return typeof entry.password === 'string' && entry.password.length > 0
    || typeof entry.privateKeyPath === 'string' && entry.privateKeyPath.length > 0
    || entry.useAgent === true;
}

function slugify(name) {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return ascii || 'srv';
}

/**
 * Inventory service.
 */
export class ServerStore {
  /**
   * @param {{ file?: string, dir?: string, env?: NodeJS.ProcessEnv, logger?: { warn(message: string): void } }} [options]
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.dir = options.dir ?? dataDirectory(this.env);
    this.file = options.file ?? join(this.dir, 'servers.json');
    this.logger = options.logger;
    /** @type {string[]} */
    this.warnings = [];
  }

  /** Canonical, user-facing path of the inventory file. */
  get path() {
    return this.file;
  }

  /** Create the owning directory with restrictive permissions. */
  ensureDirectory() {
    fs.mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dirname(this.file), 0o700);
    } catch {
      // Best effort: Windows has no meaningful POSIX mode.
    }
  }

  /**
   * Read and validate the inventory.
   * @returns {{ version: number, servers: ServerConfig[], warnings: string[] }}
   */
  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { version: FILE_VERSION, servers: [], warnings: [] };
      throw new RemoteError(`无法读取服务器配置 ${this.file}：${error.message}`, {
        code: 'io-error',
        cause: error,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.file, backup);
      } catch {
        // The error below still tells the user where to look.
      }
      throw new RemoteError(
        `服务器配置不是合法 JSON：${this.file}。已尝试备份到 ${backup}；请修复或删除该文件后重试。`,
        { code: 'corrupt-file', cause: error },
      );
    }
    const list = Array.isArray(parsed?.servers) ? parsed.servers : [];
    /** @type {ServerConfig[]} */
    const servers = [];
    const warnings = [];
    for (const [index, entry] of list.entries()) {
      try {
        servers.push(this.normalizeStored(entry));
      } catch (error) {
        warnings.push(`跳过第 ${index + 1} 个服务器条目：${error.message}`);
      }
    }
    this.warnings = warnings;
    return { version: FILE_VERSION, servers, warnings };
  }

  /**
   * Write the whole inventory atomically.
   * @param {ServerConfig[]} servers
   */
  write(servers) {
    if (servers.length > MAX_SERVERS) {
      throw new RemoteError(`最多保存 ${MAX_SERVERS} 台服务器`, { code: 'too-many-servers' });
    }
    this.ensureDirectory();
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({ version: FILE_VERSION, servers }, null, 2) + '\n';
    try {
      fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        // Windows: ACLs decide, and the harness home is already user-scoped.
      }
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
      throw new RemoteError(`无法写入服务器配置 ${this.file}：${error.message}`, {
        code: 'io-error',
        cause: error,
      });
    }
  }

  /**
   * Normalize one stored entry; unknown or invalid data is a warning for the
   * caller to surface, never a crash at plugin load.
   * @param {unknown} entry
   * @returns {ServerConfig}
   */
  normalizeStored(entry) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RemoteError('条目不是对象', { code: 'invalid-field' });
    }
    const input = /** @type {Record<string, unknown>} */ (entry);
    const id = stringField(input.id, 'id', { required: true, max: 64 });
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new RemoteError(`id 含有非法字符：${id}`, { code: 'invalid-field', field: 'id' });
    }
    const host = stringField(input.host, 'host', { required: true, max: 255 });
    const username = stringField(input.username, 'username', { required: true, max: 128 });
    const normalize = {
      id,
      name: stringField(input.name, 'name', { max: 80 }) || `${username}@${host}`,
      host,
      port: integerField(input.port, 'port', { min: 1, max: 65535, fallback: 22 }),
      username,
      password: stringField(input.password, 'password', { max: 4096 }),
      privateKeyPath: stringField(input.privateKeyPath, 'privateKeyPath', { max: 1024 }),
      passphrase: stringField(input.passphrase, 'passphrase', { max: 4096 }),
      useAgent: booleanField(input.useAgent, 'useAgent', false),
      workdir: stringField(input.workdir, 'workdir', { max: 1024 }) ?? '',
      description: stringField(input.description, 'description', { max: 500 }) ?? '',
      tags: tagList(input.tags),
      disabled: booleanField(input.disabled, 'disabled', false),
      readyTimeoutMs: integerField(input.readyTimeoutMs, 'readyTimeoutMs', {
        min: 1000, max: 120000, fallback: DEFAULT_READY_TIMEOUT_MS,
      }),
      keepaliveIntervalMs: integerField(input.keepaliveIntervalMs, 'keepaliveIntervalMs', {
        min: 0, max: 60000, fallback: DEFAULT_KEEPALIVE_MS,
      }),
      maxOutputBytes: integerField(input.maxOutputBytes, 'maxOutputBytes', {
        min: 4096, max: 4194304, fallback: DEFAULT_MAX_OUTPUT_BYTES,
      }),
      createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : new Date().toISOString(),
      updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : new Date().toISOString(),
    };
    if (input.jump !== undefined) {
      if (input.jump === null) {
        // explicit removal
      } else if (typeof input.jump !== 'object' || Array.isArray(input.jump)) {
        throw new RemoteError('jump 必须是对象', { code: 'invalid-field', field: 'jump' });
      } else {
        const jump = /** @type {Record<string, unknown>} */ (input.jump);
        const normalizedJump = {
          host: stringField(jump.host, 'jump.host', { required: true, max: 255 }),
          port: integerField(jump.port, 'jump.port', { min: 1, max: 65535, fallback: 22 }),
          username: stringField(jump.username, 'jump.username', { required: true, max: 128 }),
          password: stringField(jump.password, 'jump.password', { max: 4096 }),
          privateKeyPath: stringField(jump.privateKeyPath, 'jump.privateKeyPath', { max: 1024 }),
          passphrase: stringField(jump.passphrase, 'jump.passphrase', { max: 4096 }),
          useAgent: booleanField(jump.useAgent, 'jump.useAgent', false),
        };
        if (!hasAuth(normalizedJump)) {
          throw new RemoteError('跳板机缺少认证方式（密码、私钥或 SSH Agent）', {
            code: 'invalid-field',
            field: 'jump',
          });
        }
        normalize.jump = normalizedJump;
      }
    }
    if (!hasAuth(normalize)) {
      throw new RemoteError('缺少认证方式（密码、私钥或 SSH Agent）', { code: 'invalid-field', field: 'password' });
    }
    return normalize;
  }

  /**
   * Turn one save request into a canonical entry.
   * `existing` supplies the secrets a blank field means "keep".
   * @param {Record<string, unknown>} input
   * @param {{ existing?: ServerConfig, servers?: ServerConfig[] }} [context]
   * @returns {ServerConfig}
   */
  normalizeInput(input, context = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new RemoteError('服务器配置必须是对象', { code: 'invalid-field' });
    }
    rejectUnknown(input);
    const existing = context.existing;
    const host = stringField(input.host, 'host', { required: existing === undefined, max: 255 }) ?? existing.host;
    const username = stringField(input.username, 'username', { required: existing === undefined, max: 128 }) ?? existing.username;
    if (!host) throw new RemoteError('host 不能为空', { code: 'invalid-field', field: 'host' });
    if (!username) throw new RemoteError('username 不能为空', { code: 'invalid-field', field: 'username' });
    const servers = context.servers ?? [];
    const requestedId = stringField(input.id, 'id', { max: 64 });
    const id = context.existing?.id
      ?? (requestedId ? requestedId : this.createId(input.name, host, username, servers));
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new RemoteError(`id 只能包含字母、数字、点、下划线和短横线：${id}`, { code: 'invalid-field', field: 'id' });
    }
    const name = stringField(input.name, 'name', { max: 80 }) || context.existing?.name || `${username}@${host}`;
    if (servers.some((server) => server.id !== id && server.name.toLowerCase() === name.toLowerCase())) {
      throw new RemoteError(`名称已被其他服务器占用：${name}`, { code: 'duplicate-name', field: 'name' });
    }

    const passwordInput = stringField(input.password, 'password', { max: 4096 });
    const passphraseInput = stringField(input.passphrase, 'passphrase', { max: 4096 });
    const clearPassword = booleanField(input.clearPassword, 'clearPassword', false);
    const clearPassphrase = booleanField(input.clearPassphrase, 'clearPassphrase', false);

    const password = clearPassword ? undefined : passwordInput === '' || passwordInput === undefined ? existing?.password : passwordInput;
    const passphrase = clearPassphrase ? undefined : passphraseInput === '' || passphraseInput === undefined ? existing?.passphrase : passphraseInput;
    const privateKeyPath = input.privateKeyPath === undefined
      ? existing?.privateKeyPath
      : stringField(input.privateKeyPath, 'privateKeyPath', { max: 1024 }) || undefined;
    const useAgent = input.useAgent === undefined ? existing?.useAgent ?? false : booleanField(input.useAgent, 'useAgent', false);

    const jumpHost = stringField(input.jumpHost, 'jumpHost', { max: 255 });
    const jumpUsername = stringField(input.jumpUsername, 'jumpUsername', { max: 128 });
    /** @type {JumpConfig | undefined} */
    let jump;
    if (jumpHost || jumpUsername) {
      if (!jumpHost || !jumpUsername) {
        throw new RemoteError('跳板机需要同时提供 jumpHost 和 jumpUsername', {
          code: 'invalid-field',
          field: jumpHost ? 'jumpUsername' : 'jumpHost',
        });
      }
      const jumpPassword = stringField(input.jumpPassword, 'jumpPassword', { max: 4096 });
      const jumpPassphrase = stringField(input.jumpPassphrase, 'jumpPassphrase', { max: 4096 });
      const jumpClearPassword = booleanField(input.clearJumpPassword, 'clearJumpPassword', false);
      const jumpClearPassphrase = booleanField(input.clearJumpPassphrase, 'clearJumpPassphrase', false);
      const previousJump = existing?.jump;
      jump = {
        host: jumpHost,
        port: integerField(input.jumpPort, 'jumpPort', { min: 1, max: 65535, fallback: previousJump?.port ?? 22 }),
        username: jumpUsername,
        password: jumpClearPassword ? undefined : jumpPassword === '' || jumpPassword === undefined ? previousJump?.password : jumpPassword,
        privateKeyPath: input.jumpPrivateKeyPath === undefined
          ? previousJump?.privateKeyPath
          : stringField(input.jumpPrivateKeyPath, 'jumpPrivateKeyPath', { max: 1024 }) || undefined,
        passphrase: jumpClearPassphrase ? undefined : jumpPassphrase === '' || jumpPassphrase === undefined ? previousJump?.passphrase : jumpPassphrase,
        useAgent: input.jumpUseAgent === undefined ? previousJump?.useAgent ?? false : booleanField(input.jumpUseAgent, 'jumpUseAgent', false),
      };
      if (!hasAuth(jump)) {
        throw new RemoteError('跳板机缺少认证方式（密码、私钥或 SSH Agent）', {
          code: 'invalid-field',
          field: 'jumpPassword',
        });
      }
    } else if (input.jumpHost === undefined && input.jumpUsername === undefined) {
      jump = existing?.jump;
    }

    const candidate = {
      id,
      name,
      host,
      port: integerField(input.port, 'port', { min: 1, max: 65535, fallback: existing?.port ?? 22 }),
      username,
      password,
      privateKeyPath,
      passphrase,
      useAgent,
      workdir: input.workdir === undefined ? existing?.workdir ?? '' : stringField(input.workdir, 'workdir', { max: 1024 }) ?? '',
      description: input.description === undefined
        ? existing?.description ?? ''
        : stringField(input.description, 'description', { max: 500 }) ?? '',
      tags: input.tags === undefined ? existing?.tags ?? [] : tagList(input.tags),
      disabled: input.disabled === undefined ? existing?.disabled ?? false : booleanField(input.disabled, 'disabled', false),
      readyTimeoutMs: integerField(input.readyTimeoutMs, 'readyTimeoutMs', {
        min: 1000, max: 120000, fallback: existing?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      }),
      keepaliveIntervalMs: integerField(input.keepaliveIntervalMs, 'keepaliveIntervalMs', {
        min: 0, max: 60000, fallback: existing?.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS,
      }),
      maxOutputBytes: integerField(input.maxOutputBytes, 'maxOutputBytes', {
        min: 4096, max: 4194304, fallback: existing?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      }),
      ...(jump === undefined ? {} : { jump }),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!hasAuth(candidate)) {
      throw new RemoteError('缺少认证方式：请提供 password、privateKeyPath 或 useAgent=true', {
        code: 'invalid-field',
        field: 'password',
      });
    }
    // Reject malformed references now; a missing variable is reported when a
    // connection is actually attempted, so the inventory can be saved first.
    assertSecretReferenceSyntax(candidate.password, 'password');
    assertSecretReferenceSyntax(candidate.passphrase, 'passphrase');
    assertSecretReferenceSyntax(candidate.jump?.password, 'jump.password');
    assertSecretReferenceSyntax(candidate.jump?.passphrase, 'jump.passphrase');
    return candidate;
  }

  /**
   * @param {unknown} name
   * @param {string} host
   * @param {string} username
   * @param {ServerConfig[]} servers
   */
  createId(name, host, username, servers) {
    const base = slugify(typeof name === 'string' && name.trim() ? name : `${username}-${host}`);
    let candidate = base;
    let counter = 2;
    while (servers.some((server) => server.id === candidate)) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    if (candidate.length >= 3) return candidate;
    return `srv-${randomBytes(3).toString('hex')}`;
  }

  /**
   * Resolve secret references and the private-key path for a connection.
   * @param {ServerConfig} server
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {ServerConfig & { jump?: JumpConfig }}
   */
  resolveConnection(server, env = this.env) {
    const keyPath = (value) => {
      if (!value) return undefined;
      const expanded = value.startsWith('~/') || value === '~' ? join(homedir(), value.slice(1)) : value;
      return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
    };
    const resolved = {
      ...server,
      password: resolveSecretReference(server.password, env, 'password'),
      passphrase: resolveSecretReference(server.passphrase, env, 'passphrase'),
      privateKeyPath: keyPath(server.privateKeyPath),
    };
    if (server.jump) {
      resolved.jump = {
        ...server.jump,
        password: resolveSecretReference(server.jump.password, env, 'jump.password'),
        passphrase: resolveSecretReference(server.jump.passphrase, env, 'jump.passphrase'),
        privateKeyPath: keyPath(server.jump.privateKeyPath),
      };
    }
    return resolved;
  }

  /**
   * Look up one server by id or exact (case-insensitive) name.
   * @param {string} selector
   * @returns {{ server: ServerConfig, servers: ServerConfig[] }}
   */
  find(selector) {
    if (typeof selector !== 'string' || selector.trim() === '') {
      throw new RemoteError('请提供服务器 id 或名称', { code: 'invalid-field', field: 'server' });
    }
    const wanted = selector.trim();
    const { servers } = this.read();
    const byId = servers.find((server) => server.id === wanted);
    if (byId) return { server: byId, servers };
    const lower = wanted.toLowerCase();
    const byName = servers.filter((server) => server.name.toLowerCase() === lower);
    if (byName.length === 1) return { server: byName[0], servers };
    if (byName.length > 1) {
      throw new RemoteError(`名称 ${wanted} 对应多台服务器，请改用 id：${byName.map((server) => server.id).join(', ')}`, {
        code: 'ambiguous-server',
        field: 'server',
      });
    }
    const available = servers.length === 0
      ? '当前还没有服务器，请先用 remote_save_server 添加'
      : `可用服务器：${servers.map((server) => `${server.id}（${server.name}）`).join('、')}`;
    throw new RemoteError(`找不到服务器 ${wanted}。${available}`, { code: 'server-not-found', field: 'server' });
  }

  /** @returns {ServerConfig[]} */
  list() {
    const { servers } = this.read();
    return [...servers].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  /**
   * Create or update one server.
   * @param {Record<string, unknown>} input
   * @returns {{ server: ServerConfig, created: boolean }}
   */
  upsert(input) {
    const { servers } = this.read();
    let existing;
    if (typeof input.id === 'string' && input.id !== '') {
      existing = servers.find((server) => server.id === input.id);
      if (!existing) {
        throw new RemoteError(`找不到要更新的服务器 id：${input.id}；新建时不要传 id`, {
          code: 'server-not-found',
          field: 'id',
        });
      }
    }
    const server = this.normalizeInput(input, { existing, servers });
    const next = existing
      ? servers.map((entry) => (entry.id === server.id ? server : entry))
      : [...servers, server];
    this.write(next);
    return { server, created: existing === undefined };
  }

  /**
   * Remove one server by id or name.
   * @param {string} selector
   * @returns {{ server: ServerConfig }}
   */
  remove(selector) {
    const { server, servers } = this.find(selector);
    this.write(servers.filter((entry) => entry.id !== server.id));
    return { server };
  }

  /**
   * Public projection: no secret material, but enough to edit a form.
   * @param {ServerConfig} server
   */
  publicServer(server) {
    const jump = server.jump
      ? {
          host: server.jump.host,
          port: server.jump.port,
          username: server.jump.username,
          privateKeyPath: server.jump.privateKeyPath,
          useAgent: server.jump.useAgent === true,
          hasPassword: Boolean(server.jump.password),
          hasPassphrase: Boolean(server.jump.passphrase),
        }
      : null;
    return {
      id: server.id,
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      authType: server.privateKeyPath ? 'key' : server.useAgent ? 'agent' : 'password',
      hasPassword: Boolean(server.password),
      hasPassphrase: Boolean(server.passphrase),
      privateKeyPath: server.privateKeyPath,
      useAgent: server.useAgent === true,
      workdir: server.workdir,
      description: server.description,
      tags: server.tags,
      disabled: server.disabled,
      readyTimeoutMs: server.readyTimeoutMs,
      keepaliveIntervalMs: server.keepaliveIntervalMs,
      maxOutputBytes: server.maxOutputBytes,
      jump,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    };
  }
}
