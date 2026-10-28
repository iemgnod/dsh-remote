/**
 * Same-origin HTTP bridge for the settings page.
 *
 * The harness web server has no server-wide auth, so this route asks the host's
 * own request gate and applies the same Origin/Host checks the plugin market
 * uses. Mutating routes are POST/PUT/DELETE only and are refused from a
 * cross-site page.
 */

import { RemoteError, errorText } from './util.js';

const PREFIX = '/dsh-remote';
const MAX_BODY_BYTES = 128 * 1024;
const MAX_COMMAND_LENGTH = 8192;

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new RemoteError('请求体过大', { code: 'body-too-large' });
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected an object');
    }
    return parsed;
  } catch (error) {
    throw new RemoteError(`请求体不是合法 JSON 对象：${errorText(error)}`, { code: 'bad-json' });
  }
}

/** @param {string} host */
function loopbackAuthority(host) {
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {() => string[]} trustedHosts
 */
function sameOrigin(request, trustedHosts) {
  const host = request.headers.host;
  if (host !== undefined && !loopbackAuthority(host)) {
    const trusted = trustedHosts().some((entry) => entry.toLowerCase() === host.toLowerCase());
    if (!trusted) return false;
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * @param {{ get(name: string): any, webServer: { register(route: unknown): () => void } }} ctx
 * @param {{ store: import('./store.js').ServerStore, manager: import('./ssh.js').SshManager, config: Record<string, unknown> }} deps
 */
export function registerRemoteRoutes(ctx, deps) {
  const { store, manager, config } = deps;
  const connection = () => {
    try {
      return ctx.get('connection');
    } catch {
      return undefined;
    }
  };
  const trustedHosts = () => {
    const value = connection()?.trustedHosts;
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
  };

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function handler(request, response) {
    try {
      const gate = connection();
      if (typeof gate?.requestRejection === 'function') {
        let rejection;
        try {
          rejection = gate.requestRejection(request);
        } catch {
          rejection = 403;
        }
        if (rejection !== undefined) {
          sendJson(response, rejection, { ok: false, error: '请求被宿主拒绝', code: 'host-rejected' });
          return;
        }
      }
      if (!sameOrigin(request, trustedHosts)) {
        sendJson(response, 403, { ok: false, error: '不受信任的来源', code: 'untrusted-origin' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const method = request.method ?? 'GET';
      const route = url.pathname.slice(PREFIX.length) || '/';

      if (method === 'GET' && route === '/health') {
        sendJson(response, 200, { ok: true, file: store.path });
        return;
      }

      if (route === '/servers' && method === 'GET') {
        const { servers, warnings } = store.read();
        sendJson(response, 200, {
          ok: true,
          file: store.path,
          warnings,
          servers: servers.map((server) => store.publicServer(server)),
        });
        return;
      }

      if (route === '/servers' && method === 'POST') {
        const body = await readJson(request);
        const input = body.server !== undefined ? body.server : body;
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new RemoteError('server 必须是对象', { code: 'invalid-field', field: 'server' });
        }
        const { server, created } = store.upsert(/** @type {Record<string, unknown>} */ (input));
        sendJson(response, 200, { ok: true, created, file: store.path, server: store.publicServer(server) });
        return;
      }

      const serverMatch = /^\/servers\/([^/]+)$/.exec(route);
      if (serverMatch && method === 'DELETE') {
        const id = decodeURIComponent(serverMatch[1]);
        const { server } = store.remove(id);
        sendJson(response, 200, { ok: true, server: store.publicServer(server) });
        return;
      }

      if (route === '/test' && method === 'POST') {
        const body = await readJson(request);
        const selector = typeof body.server === 'string' ? body.server : typeof body.id === 'string' ? body.id : '';
        if (selector === '') throw new RemoteError('缺少 server', { code: 'invalid-field', field: 'server' });
        const { server } = store.find(selector);
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
        const result = await manager.test(server, { timeoutMs });
        sendJson(response, 200, {
          ok: true,
          tested: store.publicServer(server),
          result,
        });
        return;
      }

      if (route === '/exec' && method === 'POST') {
        if (config.allowWebExec === false) {
          sendJson(response, 403, { ok: false, error: '网页端命令执行已关闭', code: 'web-exec-disabled' });
          return;
        }
        const body = await readJson(request);
        const selector = typeof body.server === 'string' ? body.server : '';
        const command = typeof body.command === 'string' ? body.command : '';
        if (selector === '') throw new RemoteError('缺少 server', { code: 'invalid-field', field: 'server' });
        if (command.trim() === '') throw new RemoteError('缺少 command', { code: 'invalid-field', field: 'command' });
        if (command.length > MAX_COMMAND_LENGTH) {
          throw new RemoteError(`command 过长（最多 ${MAX_COMMAND_LENGTH} 字符）`, { code: 'invalid-field', field: 'command' });
        }
        const { server } = store.find(selector);
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : config.defaultTimeoutMs;
        const workdir = typeof body.workdir === 'string' ? body.workdir : undefined;
        const result = await manager.exec(server, { command, workdir, timeoutMs });
        sendJson(response, 200, { ok: true, exec: result });
        return;
      }

      sendJson(response, 404, { ok: false, error: `未知接口 ${method} ${route}`, code: 'not-found' });
    } catch (error) {
      if (error instanceof RemoteError) {
        sendJson(response, 400, {
          ok: false,
          error: error.message,
          code: error.code,
          ...(error.field === undefined ? {} : { field: error.field }),
        });
        return;
      }
      if (!response.writableEnded) {
        sendJson(response, 500, { ok: false, error: errorText(error), code: 'internal-error' });
      }
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'dsh-remote: settings routes',
  );
}

export { PREFIX };
