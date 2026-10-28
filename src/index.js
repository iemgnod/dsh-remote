/**
 * dsh-remote host entry.
 *
 * Owns the server inventory and the SSH pool, publishes the model-facing tools,
 * a short system-prompt policy, and the same-origin HTTP bridge the settings
 * page uses.
 */

import { ServerStore } from './store.js';
import { SshManager } from './ssh.js';
import { registerRemoteTools } from './tools.js';
import { registerRemoteRoutes } from './routes.js';

export const name = 'dsh-remote';

/** Services used by `apply`; the loader waits for them before activating. */
export const inject = ['tools', 'systemPrompt', 'webServer'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = {
    defaultTimeoutMs: 120000,
    connectionIdleMs: 60000,
    allowWebExec: true,
    ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}),
  };
  const logger = ctx.logger;
  const store = new ServerStore({
    ...(typeof config.dataFile === 'string' && config.dataFile ? { file: config.dataFile } : {}),
    logger,
  });
  const manager = new SshManager({
    store,
    idleMs: Number.isInteger(config.connectionIdleMs) && config.connectionIdleMs >= 0 ? config.connectionIdleMs : 60000,
    logger,
  });

  registerRemoteTools(ctx, { store, manager, config });

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-remote:servers',
    order: 3300,
    interpolate: false,
    text: () => [
      '## 远程服务器（dsh-remote）',
      `- 已保存的 SSH 服务器在 ${store.path}；用 remote_list_servers 查看 id 与名称，再用 remote_exec 执行命令。`,
      '- remote_exec 的 server 参数填服务器 id 或精确名称；不确定连接是否可用时先调用 remote_test_connection。',
      '- 命令是非交互执行的；需要 sudo 时传 sudoPassword（或用 tty=true）。文件操作优先用 remote_sftp。',
      '- 不要把密码、口令等敏感值原样回显给用户；配置时优先用 env:NAME 引用环境变量。',
    ].join('\n'),
  }), 'dsh-remote: system prompt');

  registerRemoteRoutes(ctx, { store, manager, config });

  ctx.effect(() => () => manager.closeAll(), 'dsh-remote: close connections');

  logger?.info?.(`dsh-remote: 服务器管理已就绪（${store.path}）`);
}

export { ServerStore, SshManager };
