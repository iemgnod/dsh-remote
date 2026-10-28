/**
 * Model-facing tools. Each definition goes through `defineTool`, so the host
 * validates arguments against the declared schema before `execute` runs.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { RemoteError, errorText, toJsonValue } from './util.js';

const SERVER_ARG = '服务器 id 或名称；先用 remote_list_servers 查看';

/** @param {string} text */
const renderText = (text) => [{ type: 'text', text }];

/** One-line endpoint label. */
function endpoint(server) {
  return `${server.username}@${server.host}:${server.port}`;
}

/** Authentication label without material. */
function authLabel(server) {
  if (server.authType === 'key') return '私钥';
  if (server.authType === 'agent') return 'SSH Agent';
  return '密码';
}

/** @param {ReturnType<import('./store.js').ServerStore['publicServer']>} server */
function serverLine(server) {
  const flags = [];
  if (server.disabled) flags.push('已停用');
  if (server.jump) flags.push(`跳板 ${server.jump.username}@${server.jump.host}:${server.jump.port}`);
  const tags = server.tags.length > 0 ? ` [${server.tags.join(', ')}]` : '';
  const suffix = flags.length > 0 ? ` (${flags.join('；')})` : '';
  const description = server.description ? ` — ${server.description}` : '';
  return `${server.id}  ${server.name}  ${server.username}@${server.host}:${server.port}  认证=${authLabel(server)}${tags}${suffix}${description}`;
}

/** Render a settled exec value the same way the host shell tools do. */
function renderExec(value) {
  const body = value.stdout.truncated
    ? `${value.stdout.text}\n[stdout truncated; total ${value.stdout.bytes} bytes]`
    : value.stdout.text;
  const err = value.stderr.truncated
    ? `${value.stderr.text}\n[stderr truncated; total ${value.stderr.bytes} bytes]`
    : value.stderr.text;
  const lines = [];
  if (body.length > 0) lines.push(body.replace(/\n$/, ''));
  if (err.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('[stderr]', err.replace(/\n$/, ''));
  }
  if (lines.length === 0) lines.push('(无输出)');
  const markers = [];
  if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs ?? '?'}ms]`);
  if (value.cancelled) markers.push('[cancelled]');
  if (value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`);
  markers.push(`[${value.durationMs}ms]`);
  return `${lines.join('\n')}\n${markers.join(' ')}`;
}

/**
 * Register every tool. The caller owns disposal through `ctx.effect`.
 * @param {{ tools: { register(definition: unknown): () => void } }} ctx
 * @param {{ store: import('./store.js').ServerStore, manager: import('./ssh.js').SshManager, config: Record<string, unknown> }} deps
 */
export function registerRemoteTools(ctx, deps) {
  const { store, manager } = deps;

  /** @param {string} name @param {string} description @param {Record<string, unknown>} parameters @param {Function} run @param {{ timeoutMs?: number, concurrency?: boolean }} [options] */
  const register = (name, description, parameters, run, options = {}) => {
    const tool = defineTool({
      name,
      description,
      parameters,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const rendered = /** @type {{ text?: string }} */ (value)?.text;
          return renderText(typeof rendered === 'string' ? rendered : JSON.stringify(value, null, 2));
        },
      },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.concurrency === undefined ? {} : { isConcurrencySafe: () => options.concurrency === true }),
      async execute(args, exec) {
        try {
          return toJsonValue(await run(args, exec));
        } catch (error) {
          if (error instanceof RemoteError) throw error;
          throw new RemoteError(errorText(error), { cause: error });
        }
      },
    });
    ctx.effect(() => ctx.tools.register(tool), `dsh-remote: tool ${name}`);
  };

  register(
    'remote_list_servers',
    '列出已保存的 SSH 服务器（id、名称、地址、认证方式、标签、跳板机）。先用它确认要操作的服务器，再调用 remote_exec 等工具。可用 query 按 id/名称/主机/标签过滤。',
    {
      query: { type: 'string', description: '可选过滤词，匹配 id、名称、主机、标签或描述' },
    },
    async (args) => {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const servers = store.list().map((server) => store.publicServer(server));
      const filtered = query === ''
        ? servers
        : servers.filter((server) => [
          server.id, server.name, server.host, server.username, server.description ?? '', ...server.tags,
        ].some((value) => value.toLowerCase().includes(query)));
      const lines = [
        `服务器配置文件：${store.path}`,
        filtered.length === 0
          ? (servers.length === 0
            ? '还没有服务器。用 remote_save_server 添加，或在 DSH 设置页「远程服务器」中配置。'
            : `没有匹配 ${JSON.stringify(query)} 的服务器。`)
          : filtered.map(serverLine).join('\n'),
      ];
      return { text: lines.filter(Boolean).join('\n'), file: store.path, count: filtered.length, servers: filtered };
    },
    { concurrency: true, timeoutMs: 30000 },
  );

  register(
    'remote_save_server',
    '新增或更新一台 SSH 服务器配置。新增时不要传 id；更新时传 id，只需给要改的字段（未给的字段保持不变）。密码/口令可以直接写，也可以写成 env:NAME 或 ${NAME} 引用环境变量，推荐后者以免明文落盘。密码字段留空表示保持原值，用 clearPassword=true 清除。',
    {
      id: { type: 'string', description: '更新已有服务器时必填；新增时省略' },
      name: { type: 'string', description: '显示名称，例如 生产 Web；新增时建议提供，默认 user@host' },
      host: { type: 'string', description: '主机名或 IP；新增时必填' },
      port: { type: 'integer', description: 'SSH 端口，默认 22' },
      username: { type: 'string', description: '登录用户名；新增时必填' },
      password: { type: 'string', description: '密码，或 env:NAME 引用；留空表示保持原值' },
      privateKeyPath: { type: 'string', description: '私钥路径，支持 ~/ 展开；与 password 二选一' },
      passphrase: { type: 'string', description: '私钥口令，或 env:NAME 引用' },
      useAgent: { type: 'boolean', description: '使用 SSH Agent（Windows 走 Pageant，其他平台走 SSH_AUTH_SOCK）' },
      workdir: { type: 'string', description: '默认远端工作目录' },
      description: { type: 'string', description: '备注' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，例如 ["web","prod"]' },
      disabled: { type: 'boolean', description: '停用后拒绝连接' },
      readyTimeoutMs: { type: 'integer', description: '握手超时毫秒，默认 20000' },
      keepaliveIntervalMs: { type: 'integer', description: '保活间隔毫秒，默认 15000，0 关闭' },
      maxOutputBytes: { type: 'integer', description: '单流输出上限字节，默认 262144' },
      jumpHost: { type: 'string', description: '跳板机主机；与 jumpUsername 一起出现' },
      jumpPort: { type: 'integer', description: '跳板机 SSH 端口，默认 22' },
      jumpUsername: { type: 'string', description: '跳板机用户名' },
      jumpPassword: { type: 'string', description: '跳板机密码，或 env:NAME 引用' },
      jumpPrivateKeyPath: { type: 'string', description: '跳板机私钥路径' },
      jumpPassphrase: { type: 'string', description: '跳板机私钥口令，或 env:NAME 引用' },
      jumpUseAgent: { type: 'boolean', description: '跳板机使用 SSH Agent' },
      clearPassword: { type: 'boolean', description: '清除已保存的密码' },
      clearPassphrase: { type: 'boolean', description: '清除已保存的私钥口令' },
      clearJumpPassword: { type: 'boolean', description: '清除跳板机密码' },
      clearJumpPassphrase: { type: 'boolean', description: '清除跳板机口令' },
    },
    async (args) => {
      const { server, created } = store.upsert(args);
      const publicServer = store.publicServer(server);
      return {
        text: `${created ? '已新增' : '已更新'}服务器：\n${serverLine(publicServer)}`,
        created,
        server: publicServer,
      };
    },
    { concurrency: false, timeoutMs: 30000 },
  );

  register(
    'remote_remove_server',
    '从本地配置中删除一台服务器。只删除配置，不会改动远端任何内容。',
    {
      server: { type: 'string', required: true, description: SERVER_ARG },
    },
    async (args) => {
      const { server } = store.remove(args.server);
      return {
        text: `已删除服务器 ${server.id}（${server.name}）；远端未做任何改动。`,
        server: store.publicServer(server),
      };
    },
    { concurrency: false, timeoutMs: 30000 },
  );

  register(
    'remote_test_connection',
    '测试到某台服务器的 SSH 连接并返回登录用户、系统内核和家目录。只读探测，可在不确定服务器是否可用时先调用。',
    {
      server: { type: 'string', required: true, description: SERVER_ARG },
      timeoutMs: { type: 'integer', description: '连接与探测总超时毫秒，默认 20000' },
    },
    async (args) => {
      const { server } = store.find(args.server);
      const result = await manager.test(server, { timeoutMs: args.timeoutMs });
      const text = result.ok
        ? `连接成功：${server.name}（${endpoint(server)}）\n用户：${result.user}\n系统：${result.platform}\n家目录：${result.home}\n耗时：${result.latencyMs}ms`
        : `连接已建立但探测命令异常：${server.name}（${endpoint(server)}）\nexit=${result.exitCode}\n${result.stderr}`;
      return {
        text,
        ok: result.ok,
        server: store.publicServer(server),
        user: result.user,
        platform: result.platform,
        home: result.home,
        latencyMs: result.latencyMs,
      };
    },
    { concurrency: true, timeoutMs: 140000 },
  );

  register(
    'remote_exec',
    '在指定服务器的 SSH 会话里执行一条命令（非交互）。返回 stdout、stderr 和退出码。命令由远端登录用户的 shell 执行；workdir/env 会与命令拼在同一个脚本里，sudo 也会带上它们。长时间命令请设置 timeoutMs（最大 600000）。',
    {
      server: { type: 'string', required: true, description: SERVER_ARG },
      command: { type: 'string', required: true, description: '要执行的命令，例如 docker ps 或 systemctl status nginx' },
      workdir: { type: 'string', description: '远端工作目录；省略时用服务器配置的默认目录' },
      env: { type: 'object', additionalProperties: true, description: '附加环境变量对象，例如 {"NODE_ENV":"production"}；值必须是字符串' },
      sudo: { type: 'boolean', description: '以 sudo 执行；需要 sudoPassword 或 tty=true' },
      sudoPassword: { type: 'string', description: 'sudo 密码；也可用环境变量 DSH_REMOTE_SUDO_PASSWORD' },
      loginShell: { type: 'boolean', description: '用 bash -lc 启动登录 shell（会加载 profile），默认 false' },
      tty: { type: 'boolean', description: '申请伪终端；适合需要 TTY 的程序，输出会带 \\r' },
      stdin: { type: 'string', description: '写入命令标准输入的文本，写完后关闭 stdin' },
      timeoutMs: { type: 'integer', description: '超时毫秒，默认 120000，最大 600000' },
    },
    async (args, exec) => {
      const { server } = store.find(args.server);
      const timeoutMs = args.timeoutMs ?? deps.config.defaultTimeoutMs ?? 120000;
      const value = await manager.exec(server, {
        command: args.command,
        workdir: args.workdir,
        env: args.env,
        sudo: args.sudo === true,
        sudoPassword: args.sudoPassword,
        loginShell: args.loginShell === true,
        tty: args.tty === true,
        stdin: args.stdin,
        timeoutMs,
        signal: exec?.signal,
      });
      return {
        text: `$ ${args.command}\n${renderExec({ ...value, timeoutMs })}`,
        server: store.publicServer(server),
        command: args.command,
        stdout: value.stdout,
        stderr: value.stderr,
        exitCode: value.exitCode,
        timedOut: value.timedOut,
        cancelled: value.cancelled,
        durationMs: value.durationMs,
      };
    },
    { concurrency: true, timeoutMs: 620000 },
  );

  register(
    'remote_sftp',
    '通过 SFTP 操作远端文件。action=list 列目录；read 读取文本（可用 maxBytes 限制）；write 写入文本并自动建父目录；upload/download 在本地与远端之间传输文件；stat 查看元数据。localPath 是本机路径，remotePath 是远端路径。',
    {
      server: { type: 'string', required: true, description: SERVER_ARG },
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'read', 'write', 'upload', 'download', 'stat'],
        description: '要执行的文件操作',
      },
      remotePath: { type: 'string', required: true, description: '远端路径' },
      localPath: { type: 'string', description: '本机路径；upload 与 download 必填' },
      content: { type: 'string', description: '写入的文本内容；write 必填' },
      maxBytes: { type: 'integer', description: 'read 的最大字节数，默认 262144，最大 4194304' },
    },
    async (args) => {
      const { server } = store.find(args.server);
      const action = args.action;
      if (!['list', 'read', 'write', 'upload', 'download', 'stat'].includes(action)) {
        throw new RemoteError(`不支持的 action：${action}`, { code: 'invalid-field', field: 'action' });
      }
      if ((action === 'upload' || action === 'download') && !args.localPath) {
        throw new RemoteError(`${action} 需要 localPath`, { code: 'invalid-field', field: 'localPath' });
      }
      if (action === 'write' && typeof args.content !== 'string') {
        throw new RemoteError('write 需要 content 字符串', { code: 'invalid-field', field: 'content' });
      }
      if (action === 'list') {
        const entries = await manager.listDirectory(server, { remotePath: args.remotePath });
        const body = entries.length === 0
          ? '(空目录)'
          : entries.map((entry) => {
            const marker = entry.type === 'dir' ? 'd' : entry.type === 'link' ? 'l' : '-';
            const when = entry.mtime ? new Date(entry.mtime * 1000).toISOString().slice(0, 16) : '';
            return `${marker} ${String(entry.size).padStart(10)}  ${when}  ${entry.name}${entry.type === 'dir' ? '/' : ''}`;
          }).join('\n');
        return {
          text: `${endpoint(server)}:${args.remotePath}\n${body}`,
          server: store.publicServer(server),
          action,
          remotePath: args.remotePath,
          entries,
        };
      }
      if (action === 'read') {
        const result = await manager.readRemoteFile(server, { remotePath: args.remotePath, maxBytes: args.maxBytes });
        const note = result.truncated ? `\n[已截断，文件共 ${result.size} 字节，只显示前 ${result.text.length} 字节]` : '';
        return {
          text: `${endpoint(server)}:${args.remotePath} (${result.size} bytes)\n${result.text}${note}`,
          server: store.publicServer(server),
          action,
          remotePath: args.remotePath,
          size: result.size,
          truncated: result.truncated,
          content: result.text,
        };
      }
      if (action === 'write') {
        const result = await manager.writeRemoteFile(server, {
          remotePath: args.remotePath,
          content: args.content,
        });
        return {
          text: `已写入 ${endpoint(server)}:${args.remotePath}（${result.bytes} 字节）`,
          server: store.publicServer(server),
          action,
          remotePath: args.remotePath,
          bytes: result.bytes,
        };
      }
      if (action === 'upload') {
        const result = await manager.upload(server, { localPath: args.localPath, remotePath: args.remotePath });
        return {
          text: `已上传 ${args.localPath} → ${endpoint(server)}:${args.remotePath}（${result.bytes} 字节）`,
          server: store.publicServer(server),
          action,
          remotePath: args.remotePath,
          localPath: args.localPath,
          bytes: result.bytes,
        };
      }
      if (action === 'download') {
        const result = await manager.download(server, { localPath: args.localPath, remotePath: args.remotePath });
        return {
          text: `已下载 ${endpoint(server)}:${args.remotePath} → ${args.localPath}（${result.bytes} 字节）`,
          server: store.publicServer(server),
          action,
          remotePath: args.remotePath,
          localPath: args.localPath,
          bytes: result.bytes,
        };
      }
      const stat = await manager.statRemote(server, { remotePath: args.remotePath });
      return {
        text: `${endpoint(server)}:${args.remotePath}\n类型：${stat.type}\n大小：${stat.size} 字节\n模式：${(stat.mode & 0o7777).toString(8)}\n修改时间：${stat.mtime ? new Date(stat.mtime * 1000).toISOString() : '(未知)'}`,
        server: store.publicServer(server),
        action,
        remotePath: args.remotePath,
        stat,
      };
    },
    { concurrency: true, timeoutMs: 300000 },
  );
}
