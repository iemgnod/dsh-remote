/**
 * dsh-remote settings page.
 *
 * Plain `window.__ModuleLoader__` bundle: React and the JSX runtime come from
 * the host page through `require`, so this file needs no build step. The page is
 * registered into the `settings.section` slot and talks to the host over the
 * same-origin `/dsh-remote` routes.
 */

window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'dsh-remote';
    const zh = {
      nav: '远程服务器',
      title: '远程服务器',
      subtitle: '保存 SSH 连接信息，供 remote_exec、remote_sftp 等工具使用。密码和口令建议写成 env:NAME 引用环境变量。',
      file: '配置文件',
      configHint: '敏感字段不会回传；密码与口令只保存在本机的 0600 配置文件里。',
      showJson: '显示 JSON',
      hideJson: '隐藏 JSON',
      copyPath: '复制路径',
      copied: '已复制',
      details: '配置详情',
      basic: '基本配置',
      advancedTitle: '高级配置（超时、保活、输出上限）',
      createdAt: '创建时间',
      updatedAt: '更新时间',
      passwordSaved: '已保存',
      passwordNone: '未设置',
      jumpNone: '未使用',
      clearPassword: '清除已保存的密码',
      serverCount: '台服务器',
      jsonHidden: '这里不会显示密码与口令。',
      refresh: '刷新',
      add: '新增服务器',
      edit: '编辑',
      remove: '删除',
      test: '测试连接',
      testing: '连接中…',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      empty: '还没有服务器。',
      emptyHint: '点击「新增服务器」添加第一台，或让我用 remote_save_server 写入配置。',
      loading: '加载中…',
      name: '名称',
      host: '主机',
      port: '端口',
      username: '用户名',
      authType: '认证方式',
      authPassword: '密码',
      authKey: '私钥',
      authAgent: 'SSH Agent',
      password: '密码',
      passwordKeep: '已保存；留空表示不修改',
      privateKeyPath: '私钥路径',
      passphrase: '私钥口令',
      passphraseKeep: '已保存；留空表示不修改',
      workdir: '默认工作目录',
      description: '描述',
      tags: '标签（逗号分隔）',
      disabled: '停用此服务器',
      jump: '通过跳板机连接',
      jumpHost: '跳板机主机',
      jumpPort: '跳板机端口',
      jumpUsername: '跳板机用户名',
      jumpPassword: '跳板机密码',
      jumpPrivateKeyPath: '跳板机私钥路径',
      advanced: '高级选项',
      readyTimeoutMs: '握手超时 (ms)',
      keepaliveIntervalMs: '保活间隔 (ms)',
      maxOutputBytes: '单流输出上限 (字节)',
      enabled: '已启用',
      stopped: '已停用',
      commandTitle: '快速执行命令',
      commandHint: '以 SSH 登录用户身份非交互执行；输出上限由服务器配置决定。',
      commandPlaceholder: '例如：uptime && df -h',
      run: '执行',
      running: '执行中…',
      clear: '清空输出',
      noEnabled: '没有可用服务器（先在列表中启用一台）。',
      confirmRemove: '确定删除服务器「{name}」？只删除本地配置，不会改动远端。',
      saved: '已保存',
      deleted: '已删除',
      testOk: '连接成功',
      testFailed: '连接失败',
      required: '请填写必填项：名称、主机、用户名',
      passwordRequired: '密码认证需要填写密码',
      keyRequired: '私钥认证需要填写私钥路径',
      exitCode: '退出码',
      timedOut: '超时',
      warnings: '配置警告',
      requestFailed: '请求失败',
      close: '关闭',
      advancedHint: '留空使用默认值',
    };
    const en = {
      nav: 'Remote servers',
      title: 'Remote servers',
      subtitle: 'Saved SSH targets used by remote_exec and remote_sftp. Prefer env:NAME references for secrets.',
      file: 'Config file',
      configHint: 'Secrets are never returned; passwords and passphrases stay in the local 0600 config file.',
      showJson: 'Show JSON',
      hideJson: 'Hide JSON',
      copyPath: 'Copy path',
      copied: 'Copied',
      details: 'Configuration',
      basic: 'Basics',
      advancedTitle: 'Advanced (timeouts, keepalive, output cap)',
      createdAt: 'Created',
      updatedAt: 'Updated',
      passwordSaved: 'Saved',
      passwordNone: 'Not set',
      jumpNone: 'None',
      clearPassword: 'Clear saved password',
      serverCount: 'servers',
      jsonHidden: 'Passwords and passphrases are not shown here.',
      refresh: 'Refresh',
      add: 'Add server',
      edit: 'Edit',
      remove: 'Delete',
      test: 'Test',
      testing: 'Testing…',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      empty: 'No servers yet.',
      emptyHint: 'Add one above, or ask me to call remote_save_server.',
      loading: 'Loading…',
      name: 'Name',
      host: 'Host',
      port: 'Port',
      username: 'Username',
      authType: 'Authentication',
      authPassword: 'Password',
      authKey: 'Private key',
      authAgent: 'SSH agent',
      password: 'Password',
      passwordKeep: 'Saved — leave blank to keep',
      privateKeyPath: 'Private key path',
      passphrase: 'Key passphrase',
      passphraseKeep: 'Saved — leave blank to keep',
      workdir: 'Default working directory',
      description: 'Description',
      tags: 'Tags (comma separated)',
      disabled: 'Disable this server',
      jump: 'Connect through a jump host',
      jumpHost: 'Jump host',
      jumpPort: 'Jump port',
      jumpUsername: 'Jump username',
      jumpPassword: 'Jump password',
      jumpPrivateKeyPath: 'Jump private key path',
      advanced: 'Advanced',
      readyTimeoutMs: 'Handshake timeout (ms)',
      keepaliveIntervalMs: 'Keepalive interval (ms)',
      maxOutputBytes: 'Per-stream output cap (bytes)',
      enabled: 'Enabled',
      stopped: 'Disabled',
      commandTitle: 'Quick command',
      commandHint: 'Runs non-interactively as the SSH user; output is capped by the server settings.',
      commandPlaceholder: 'e.g. uptime && df -h',
      run: 'Run',
      running: 'Running…',
      clear: 'Clear output',
      noEnabled: 'No enabled server. Enable one in the list first.',
      confirmRemove: 'Delete server "{name}"? Only the local config is removed.',
      saved: 'Saved',
      deleted: 'Deleted',
      testOk: 'Connected',
      testFailed: 'Connection failed',
      required: 'Required: name, host, username',
      passwordRequired: 'Password authentication needs a password',
      keyRequired: 'Key authentication needs a private key path',
      exitCode: 'Exit code',
      timedOut: 'Timed out',
      warnings: 'Config warnings',
      requestFailed: 'Request failed',
      close: 'Close',
      advancedHint: 'Leave blank for defaults',
    };

    const CSS = `.dsh-remote{
  --r-border:var(--dsw-alias-border-l1,#e5e6eb);
  --r-border-strong:var(--dsw-alias-border-l2,#c9cdd4);
  --r-hover:var(--dsw-alias-interactive-bg-hover,rgba(31,35,41,.05));
  --r-bg:var(--dsw-alias-bg-layer-1,#fff);
  --r-text:var(--dsw-alias-label-primary,#1f2329);
  --r-secondary:var(--dsw-alias-label-secondary,#646a73);
  --r-muted:var(--dsw-alias-label-tertiary,#8f959e);
  --r-accent:var(--dsw-alias-button-info-fill,#4d6bfe);
  --r-accent-hover:var(--dsw-alias-button-info-hover,#3f5be0);
  --r-danger:var(--dsw-alias-state-error-primary,#d92d20);
  --r-success:var(--dsw-alias-state-success-primary,#12805c);
  max-width:960px;margin:0 auto;color:var(--r-text);font-size:13px;line-height:1.6;
}
.dsh-remote__page{height:100%;overflow:auto;padding:30px 38px 56px;box-sizing:border-box;background:transparent}
.dsh-remote__page .dsh-remote{margin:0 auto}
.dsh-remote h2{margin:0;font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-.01em}
.dsh-remote p{margin:0}
.dsh-remote__head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.dsh-remote__headtext{min-width:0}
.dsh-remote__sub{color:var(--r-secondary);font-size:12.5px;margin-top:5px;max-width:660px}
.dsh-remote__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-remote__spacer{flex:1}
.dsh-remote button{font:inherit;cursor:pointer;border-radius:9px;border:1px solid var(--r-border);background:var(--r-bg);color:inherit;padding:6px 12px;line-height:20px;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .15s,border-color .15s,color .15s,box-shadow .15s;white-space:nowrap}
.dsh-remote button:hover:not(:disabled){background:var(--r-hover);border-color:var(--r-border-strong)}
.dsh-remote button:disabled{opacity:.45;cursor:default}
.dsh-remote button.primary{background:var(--r-accent);border-color:transparent;color:#fff;box-shadow:0 1px 2px rgba(38,60,180,.18)}
.dsh-remote button.primary:hover:not(:disabled){background:var(--r-accent-hover);border-color:transparent}
.dsh-remote button.ghost{border-color:transparent;background:transparent;color:var(--r-secondary)}
.dsh-remote button.ghost:hover:not(:disabled){background:var(--r-hover);color:var(--r-text)}
.dsh-remote button.danger{color:var(--r-danger)}
.dsh-remote button.danger:hover:not(:disabled){background:rgba(217,45,32,.08);border-color:rgba(217,45,32,.22)}
.dsh-remote button.icon{padding:0;width:32px;height:32px}
.dsh-remote button.small{padding:4px 9px;font-size:12px;gap:5px;line-height:18px}
.dsh-remote__icon{display:inline-flex;flex:none;align-items:center;justify-content:center}
.dsh-remote__chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--r-hover);color:var(--r-secondary);font-weight:400}
.dsh-remote__chip.ok{background:rgba(18,128,92,.1);color:var(--r-success)}
.dsh-remote__chip.off{background:var(--r-hover);color:var(--r-muted)}
.dsh-remote__chip.id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace}
.dsh-remote__toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0 10px;min-height:24px}
.dsh-remote__muted{color:var(--r-muted);font-size:12px}
.dsh-remote__configbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--r-border);border-radius:10px;background:var(--r-bg)}
.dsh-remote__configlabel{font-size:12px;font-weight:500;color:var(--r-secondary)}
.dsh-remote__path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:11px;color:var(--r-muted);word-break:break-all;flex:1;min-width:180px}
.dsh-remote__json{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;margin:8px 0 0;padding:12px 14px;border-radius:10px;background:var(--r-hover);border:1px solid var(--r-border);color:var(--r-secondary)}
.dsh-remote__list{display:flex;flex-direction:column;gap:10px}
.dsh-remote__card{border:1px solid var(--r-border);border-radius:12px;padding:14px 16px;background:var(--r-bg);transition:border-color .15s,box-shadow .15s}
.dsh-remote__card:hover{border-color:var(--r-border-strong);box-shadow:0 3px 14px rgba(20,25,40,.05)}
.dsh-remote__cardhead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dsh-remote__cardhead>.dsh-remote__actions{flex:none}
.dsh-remote__identity{display:flex;align-items:flex-start;gap:10px;min-width:0;flex:1}
.dsh-remote__dot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex:none;background:var(--r-success);box-shadow:0 0 0 3px rgba(18,128,92,.12)}
.dsh-remote__dot.off{background:var(--r-muted);box-shadow:0 0 0 3px rgba(143,149,158,.16)}
.dsh-remote__name{font-size:14px;font-weight:600;display:flex;align-items:center;gap:7px;flex-wrap:wrap;line-height:20px}
.dsh-remote__endpoint{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:12px;color:var(--r-secondary);margin-top:3px;display:flex;align-items:center;gap:5px;flex-wrap:wrap;word-break:break-all}
.dsh-remote__sep{color:var(--r-muted)}
.dsh-remote__desc{color:var(--r-secondary);font-size:12px;margin-top:5px}
.dsh-remote__test{margin-top:8px;font-size:12px;display:flex;align-items:center;gap:6px}
.dsh-remote__ok{color:var(--r-success)}
.dsh-remote__err{color:var(--r-danger)}
.dsh-remote details{margin-top:10px}
.dsh-remote summary{cursor:pointer;font-size:12px;color:var(--r-secondary);display:inline-flex;align-items:center;gap:5px;list-style:none;user-select:none}
.dsh-remote summary::-webkit-details-marker{display:none}
.dsh-remote summary:hover{color:var(--r-text)}
.dsh-remote__fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;margin-top:10px}
.dsh-remote__fielditem{min-width:0;padding:8px 10px;border-radius:8px;background:var(--r-hover)}
.dsh-remote__fieldlabel{display:block;font-size:11px;color:var(--r-muted);margin-bottom:1px}
.dsh-remote__fieldvalue{display:block;font-size:12px;color:var(--r-text);overflow-wrap:anywhere}
.dsh-remote__panel{border:1px solid var(--r-border);border-radius:12px;padding:16px;margin:12px 0;background:var(--r-bg)}
.dsh-remote__panelhead{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsh-remote__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.dsh-remote__field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dsh-remote__field.full{grid-column:1/-1}
.dsh-remote__field label{font-size:12px;color:var(--r-secondary)}
.dsh-remote input[type=text],.dsh-remote input[type=number],.dsh-remote input[type=password],.dsh-remote select,.dsh-remote textarea{width:100%;box-sizing:border-box;font:inherit;color:inherit;background:var(--r-bg);border:1px solid var(--r-border);border-radius:9px;padding:7px 10px;outline:none;transition:border-color .15s,box-shadow .15s}
.dsh-remote input:focus,.dsh-remote select:focus,.dsh-remote textarea:focus{border-color:var(--r-accent);box-shadow:0 0 0 3px rgba(77,107,254,.14)}
.dsh-remote textarea{min-height:76px;resize:vertical;line-height:1.55}
.dsh-remote__note{font-size:12px;color:var(--r-muted);margin-top:4px}
.dsh-remote__section{margin:18px 0 8px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--r-muted)}
.dsh-remote__banner{border-radius:9px;padding:9px 12px;margin:8px 0;font-size:12px;background:var(--r-hover);border:1px solid transparent}
.dsh-remote__banner.error{background:rgba(217,45,32,.07);border-color:rgba(217,45,32,.16);color:var(--r-danger)}
.dsh-remote__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-remote__check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--r-secondary)}
.dsh-remote__check input{width:auto}
.dsh-remote__empty{text-align:center;padding:44px 24px;border:1px dashed var(--r-border);border-radius:12px;color:var(--r-secondary);background:var(--r-bg)}
.dsh-remote__empty .dsh-remote__icon{color:var(--r-muted);margin-bottom:8px}
.dsh-remote__empty strong{display:block;color:var(--r-text);font-size:14px;margin-bottom:3px}
.dsh-remote__terminal{margin-top:10px;border:1px solid #2a2f3a;border-radius:10px;background:#161a22;color:#d7dce5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:1.6;padding:12px 14px;max-height:380px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.dsh-remote__terminal .cmd{color:#8f9bb3}
.dsh-remote__terminal .err{color:#ff9b9b}
.dsh-remote__terminal .meta{color:#7f8a9d;margin-top:6px}
.dsh-remote__runbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.dsh-remote__runbar select{flex:1;min-width:180px}
.dsh-remote__footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
@media (max-width:640px){
  .dsh-remote__page{padding:20px 18px 40px}
  .dsh-remote__grid{grid-template-columns:1fr}
  .dsh-remote__cardhead{flex-direction:column}
  .dsh-remote__actions{width:100%}
}
`;
    function injectCss() {
      if (document.querySelector('style[data-plugin-css="dsh-remote"]') !== null) return;
      const style = document.createElement('style');
      style.setAttribute('data-plugin-css', 'dsh-remote');
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    async function request(path, options = {}) {
      const response = await fetch(`/dsh-remote${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error ?? `HTTP ${response.status}`);
      }
      return data;
    }

    function blankDraft() {
      return {
        id: undefined, name: '', host: '', port: 22, username: '',
        authType: 'password', password: '', privateKeyPath: '', passphrase: '', useAgent: false,
        workdir: '', description: '', tagsText: '', disabled: false,
        hasPassword: false, hasPassphrase: false, clearPassword: false, clearPassphrase: false,
        jumpEnabled: false, hadJump: false,
        jumpHost: '', jumpPort: 22, jumpUsername: '', jumpPassword: '', jumpPrivateKeyPath: '', jumpPassphrase: '',
        readyTimeoutMs: '', keepaliveIntervalMs: '', maxOutputBytes: '',
      };
    }

    function draftFromServer(server) {
      return {
        id: server.id,
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        authType: server.authType,
        password: '',
        privateKeyPath: server.privateKeyPath ?? '',
        passphrase: '',
        useAgent: server.useAgent === true,
        workdir: server.workdir ?? '',
        description: server.description ?? '',
        tagsText: (server.tags ?? []).join(', '),
        disabled: server.disabled === true,
        hasPassword: server.hasPassword === true,
        hasPassphrase: server.hasPassphrase === true,
        clearPassword: false,
        clearPassphrase: false,
        jumpEnabled: Boolean(server.jump),
        hadJump: Boolean(server.jump),
        jumpHost: server.jump?.host ?? '',
        jumpPort: server.jump?.port ?? 22,
        jumpUsername: server.jump?.username ?? '',
        jumpPassword: '',
        jumpPrivateKeyPath: server.jump?.privateKeyPath ?? '',
        jumpPassphrase: '',
        readyTimeoutMs: server.readyTimeoutMs ?? '',
        keepaliveIntervalMs: server.keepaliveIntervalMs ?? '',
        maxOutputBytes: server.maxOutputBytes ?? '',
      };
    }

    function splitTags(text) {
      return String(text ?? '').split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    }

    function payloadFromDraft(draft) {
      const payload = {
        name: draft.name.trim(),
        host: draft.host.trim(),
        username: draft.username.trim(),
        port: Number(draft.port) || 22,
        workdir: draft.workdir.trim(),
        description: draft.description.trim(),
        tags: splitTags(draft.tagsText),
        disabled: draft.disabled === true,
      };
      if (draft.id) payload.id = draft.id;
      for (const [key, field] of [['readyTimeoutMs', 'readyTimeoutMs'], ['keepaliveIntervalMs', 'keepaliveIntervalMs'], ['maxOutputBytes', 'maxOutputBytes']]) {
        if (String(draft[field] ?? '').trim() !== '') payload[key] = Number(draft[field]);
      }
      if (draft.authType === 'key') {
        payload.privateKeyPath = draft.privateKeyPath.trim();
        payload.useAgent = false;
        if (draft.passphrase) payload.passphrase = draft.passphrase;
        if (draft.id) payload.clearPassword = true;
      } else if (draft.authType === 'agent') {
        payload.useAgent = true;
        payload.privateKeyPath = '';
        if (draft.id) payload.clearPassword = true;
      } else {
        payload.useAgent = false;
        payload.privateKeyPath = '';
        if (draft.password) payload.password = draft.password;
        else if (draft.id) payload.clearPassword = draft.clearPassword === true || draft.hasPassword !== true ? true : undefined;
        if (draft.id && draft.hasPassphrase && draft.clearPassphrase === true) payload.clearPassphrase = true;
      }
      if (draft.jumpEnabled) {
        payload.jumpHost = draft.jumpHost.trim();
        payload.jumpUsername = draft.jumpUsername.trim();
        payload.jumpPort = Number(draft.jumpPort) || 22;
        payload.jumpPrivateKeyPath = draft.jumpPrivateKeyPath.trim();
        payload.jumpUseAgent = false;
        if (draft.jumpPassword) payload.jumpPassword = draft.jumpPassword;
        if (draft.jumpPassphrase) payload.jumpPassphrase = draft.jumpPassphrase;
      } else if (draft.id && draft.hadJump) {
        payload.jumpHost = '';
        payload.jumpUsername = '';
      }
      // Drop undefined so the store keeps the current secret instead of
      // rejecting an explicitly undefined value.
      for (const key of Object.keys(payload)) {
        if (payload[key] === undefined) delete payload[key];
      }
      return payload;
    }

    const ICONS = {
      plus: ['M12 5v14', 'M5 12h14'],
      refresh: ['M20 11a8 8 0 1 0-2.34 5.66', 'M20 5v6h-6'],
      play: ['M8 5l11 7-11 7z'],
      edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
      trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
      copy: ['M9 9h10v11H9z', 'M5 15H4V4h11v1'],
      sliders: ['M4 6h16', 'M4 12h16', 'M4 18h16', 'M8 4v4', 'M16 10v4', 'M11 16v4'],
      file: ['M14 3v5h5', 'M6 3h8l5 5v13H6z'],
      terminal: ['M4 5h16v14H4z', 'M8 9l3 3-3 3', 'M13 15h4'],
      server: ['M4 5h16v5H4z', 'M4 14h16v5H4z', 'M7 7.5h.01', 'M7 16.5h.01'],
      x: ['M6 6l12 12', 'M18 6L6 18'],
      check: ['M5 12l5 5L20 7'],
      info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8h.01', 'M11 12h1v4h1'],
    };
    const Icon = ({ name, size = 16 }) => React.createElement('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: name === 'play' ? 'currentColor' : 'none',
      stroke: name === 'play' ? 'none' : 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: 'dsh-remote__icon',
      'aria-hidden': 'true',
    }, (ICONS[name] ?? []).map((d, index) => React.createElement('path', { key: index, d })));

    function RemoteSection(props) {
      const { t } = props;
      const h = React.createElement;
      injectCss();
      const [servers, setServers] = useState([]);
      const [file, setFile] = useState('');
      const [warnings, setWarnings] = useState([]);
      const [loading, setLoading] = useState(true);
      const [loadError, setLoadError] = useState('');
      const [editing, setEditing] = useState(null);
      const [saveError, setSaveError] = useState('');
      const [saving, setSaving] = useState(false);
      const [tests, setTests] = useState({});
      const [runServer, setRunServer] = useState('');
      const [command, setCommand] = useState('');
      const [running, setRunning] = useState(false);
      const [runError, setRunError] = useState('');
      const [runResult, setRunResult] = useState(null);
      const [showJson, setShowJson] = useState(false);
      const [copied, setCopied] = useState(false);
      const mounted = useRef(true);
      useEffect(() => () => { mounted.current = false; }, []);

      const load = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        try {
          const data = await request('/servers');
          if (!mounted.current) return;
          setServers(data.servers ?? []);
          setFile(data.file ?? '');
          setWarnings(data.warnings ?? []);
        } catch (error) {
          if (mounted.current) setLoadError(String(error.message ?? error));
        } finally {
          if (mounted.current) setLoading(false);
        }
      }, []);

      useEffect(() => { void load(); }, [load]);
      const enabledServers = useMemo(() => servers.filter((server) => !server.disabled), [servers]);
      const configJson = useMemo(() => JSON.stringify({ version: 1, servers }, null, 2), [servers]);
      const copyPath = async () => {
        try {
          await navigator.clipboard.writeText(file);
          setCopied(true);
          setTimeout(() => { if (mounted.current) setCopied(false); }, 1500);
        } catch {
          // Clipboard may be unavailable; the path is still selectable.
        }
      };
      useEffect(() => {
        if (runServer === '' && enabledServers.length > 0) setRunServer(enabledServers[0].id);
        if (runServer !== '' && !enabledServers.some((server) => server.id === runServer)) {
          setRunServer(enabledServers[0]?.id ?? '');
        }
      }, [enabledServers, runServer]);

      const startEdit = (server) => {
        setSaveError('');
        setEditing(server ? draftFromServer(server) : blankDraft());
      };

      const save = async () => {
        if (!editing) return;
        setSaveError('');
        const payload = payloadFromDraft(editing);
        if (!payload.name || !payload.host || !payload.username) {
          setSaveError(t('required'));
          return;
        }
        if (editing.authType === 'password' && !editing.id && !editing.password) {
          setSaveError(t('passwordRequired'));
          return;
        }
        if (editing.authType === 'key' && !editing.privateKeyPath.trim()) {
          setSaveError(t('keyRequired'));
          return;
        }
        setSaving(true);
        try {
          await request('/servers', { method: 'POST', body: JSON.stringify({ server: payload }) });
          setEditing(null);
          await load();
        } catch (error) {
          setSaveError(String(error.message ?? error));
        } finally {
          setSaving(false);
        }
      };

      const remove = async (server) => {
        const message = t('confirmRemove').replace('{name}', server.name);
        if (typeof window.confirm === 'function' && !window.confirm(message)) return;
        try {
          await request(`/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' });
          if (editing?.id === server.id) setEditing(null);
          await load();
        } catch (error) {
          setLoadError(String(error.message ?? error));
        }
      };

      const test = async (server) => {
        setTests((prev) => ({ ...prev, [server.id]: { busy: true } }));
        try {
          const data = await request('/test', { method: 'POST', body: JSON.stringify({ server: server.id }) });
          if (!mounted.current) return;
          const result = data.result ?? {};
          setTests((prev) => ({
            ...prev,
            [server.id]: {
              busy: false,
              ok: result.ok === true,
              message: result.ok
                ? `${result.user || '?'} · ${result.platform || '?'} · ${result.latencyMs ?? '?'}ms`
                : `exit ${result.exitCode ?? '?'} ${result.stderr ?? ''}`,
            },
          }));
        } catch (error) {
          if (!mounted.current) return;
          setTests((prev) => ({ ...prev, [server.id]: { busy: false, ok: false, message: String(error.message ?? error) } }));
        }
      };

      const run = async () => {
        if (!runServer || command.trim() === '') return;
        setRunning(true);
        setRunError('');
        setRunResult(null);
        try {
          const data = await request('/exec', {
            method: 'POST',
            body: JSON.stringify({ server: runServer, command }),
          });
          if (mounted.current) setRunResult(data.exec);
        } catch (error) {
          if (mounted.current) setRunError(String(error.message ?? error));
        } finally {
          if (mounted.current) setRunning(false);
        }
      };

      const field = (label, control, options = {}) => React.createElement(
        'div',
        { className: `dsh-remote__field${options.full ? ' full' : ''}`, key: options.key ?? label },
        React.createElement('label', null, label),
        control,
        options.hint ? React.createElement('div', { className: 'dsh-remote__note' }, options.hint) : null,
      );

      const textInput = (value, onChange, extra = {}) => React.createElement('input', {
        type: extra.type ?? 'text',
        value: value ?? '',
        placeholder: extra.placeholder ?? '',
        onChange: (event) => onChange(event.target.value),
      });

      const editor = editing
        ? React.createElement('div', { className: 'dsh-remote__panel' }, [
          React.createElement('div', { key: 'head', className: 'dsh-remote__panelhead' }, [
            React.createElement('strong', { key: 't' }, editing.id ? `${t('edit')} · ${editing.name || editing.id}` : t('add')),
            React.createElement('button', {
              key: 'close',
              className: 'ghost icon',
              title: t('cancel'),
              'aria-label': t('cancel'),
              onClick: () => { setEditing(null); setSaveError(''); },
            }, h(Icon, { key: 'i', name: 'x', size: 15 })),
          ]),
          saveError ? React.createElement('div', { key: 'err', className: 'dsh-remote__banner error' }, saveError) : null,
          React.createElement('div', { key: 'basicHeading', className: 'dsh-remote__section' }, t('basic')),
          React.createElement('div', { key: 'grid', className: 'dsh-remote__grid' }, [
            field(t('name'), textInput(editing.name, (value) => setEditing({ ...editing, name: value })), { key: 'name' }),
            field(t('host'), textInput(editing.host, (value) => setEditing({ ...editing, host: value }), { placeholder: '192.168.1.10 或 example.com' }), { key: 'host' }),
            field(t('port'), textInput(editing.port, (value) => setEditing({ ...editing, port: value }), { type: 'number' }), { key: 'port' }),
            field(t('username'), textInput(editing.username, (value) => setEditing({ ...editing, username: value }), { placeholder: 'root' }), { key: 'username' }),
            React.createElement('div', { key: 'authHeading', className: 'dsh-remote__section', style: { gridColumn: '1/-1' } }, t('authType')),
            field(t('authType'), React.createElement('select', {
              value: editing.authType,
              onChange: (event) => setEditing({ ...editing, authType: event.target.value }),
            }, [
              React.createElement('option', { key: 'password', value: 'password' }, t('authPassword')),
              React.createElement('option', { key: 'key', value: 'key' }, t('authKey')),
              React.createElement('option', { key: 'agent', value: 'agent' }, t('authAgent')),
            ]), { key: 'auth' }),
            editing.authType === 'password'
              ? field(t('password'), textInput(editing.password, (value) => setEditing({ ...editing, password: value }), {
                type: 'password',
                placeholder: editing.hasPassword ? t('passwordKeep') : 'env:PROD_PASSWORD',
              }), { key: 'password', hint: 'env:NAME 或 ${NAME}' })
              : null,
            editing.authType === 'password' && editing.hasPassword
              ? React.createElement('div', { key: 'clearPassword', className: 'dsh-remote__field full' },
                React.createElement('label', { className: 'dsh-remote__check' }, [
                  React.createElement('input', {
                    key: 'i',
                    type: 'checkbox',
                    checked: editing.clearPassword === true,
                    onChange: (event) => setEditing({
                      ...editing,
                      clearPassword: event.target.checked,
                      password: event.target.checked ? '' : editing.password,
                    }),
                  }),
                  React.createElement('span', { key: 's' }, t('clearPassword')),
                ]))
              : null,
            editing.authType === 'key'
              ? field(t('privateKeyPath'), textInput(editing.privateKeyPath, (value) => setEditing({ ...editing, privateKeyPath: value }), { placeholder: '~/.ssh/id_ed25519' }), { key: 'key' })
              : null,
            editing.authType === 'key'
              ? field(t('passphrase'), textInput(editing.passphrase, (value) => setEditing({ ...editing, passphrase: value }), {
                type: 'password',
                placeholder: editing.hasPassphrase ? t('passphraseKeep') : 'env:KEY_PASSPHRASE',
              }), { key: 'passphrase' })
              : null,
            editing.authType === 'agent'
              ? React.createElement('div', { key: 'agent', className: 'dsh-remote__field full dsh-remote__note' },
                'Windows 使用 Pageant；Linux/macOS 使用 SSH_AUTH_SOCK。')
              : null,
            field(t('workdir'), textInput(editing.workdir, (value) => setEditing({ ...editing, workdir: value }), { placeholder: '/var/www' }), { key: 'workdir' }),
            field(t('description'), textInput(editing.description, (value) => setEditing({ ...editing, description: value })), { key: 'description' }),
            field(t('tags'), textInput(editing.tagsText, (value) => setEditing({ ...editing, tagsText: value }), { placeholder: 'web, prod' }), { key: 'tags' }),
            React.createElement('div', { key: 'disabled', className: 'dsh-remote__field' }, [
              React.createElement('label', { key: 'l' }, t('disabled')),
              React.createElement('label', { key: 'c', className: 'dsh-remote__check' }, [
                React.createElement('input', {
                  key: 'i',
                  type: 'checkbox',
                  checked: editing.disabled === true,
                  onChange: (event) => setEditing({ ...editing, disabled: event.target.checked }),
                }),
                React.createElement('span', { key: 's' }, t('disabled')),
              ]),
            ]),
          ]),
          React.createElement('details', { key: 'jump', defaultOpen: editing.jumpEnabled }, [
            React.createElement('summary', { key: 's' }, t('jump')),
            React.createElement('div', { key: 'b', className: 'dsh-remote__grid', style: { marginTop: '8px' } }, [
              React.createElement('div', { key: 'toggle', className: 'dsh-remote__field full' },
                React.createElement('label', { className: 'dsh-remote__check' }, [
                  React.createElement('input', {
                    key: 'i',
                    type: 'checkbox',
                    checked: editing.jumpEnabled,
                    onChange: (event) => setEditing({ ...editing, jumpEnabled: event.target.checked }),
                  }),
                  React.createElement('span', { key: 's' }, t('jump')),
                ])),
              editing.jumpEnabled ? field(t('jumpHost'), textInput(editing.jumpHost, (value) => setEditing({ ...editing, jumpHost: value })), { key: 'jh' }) : null,
              editing.jumpEnabled ? field(t('jumpPort'), textInput(editing.jumpPort, (value) => setEditing({ ...editing, jumpPort: value }), { type: 'number' }), { key: 'jp' }) : null,
              editing.jumpEnabled ? field(t('jumpUsername'), textInput(editing.jumpUsername, (value) => setEditing({ ...editing, jumpUsername: value })), { key: 'ju' }) : null,
              editing.jumpEnabled ? field(t('jumpPassword'), textInput(editing.jumpPassword, (value) => setEditing({ ...editing, jumpPassword: value }), { type: 'password', placeholder: editing.hadJump ? t('passwordKeep') : '' }), { key: 'jpw' }) : null,
              editing.jumpEnabled ? field(t('jumpPrivateKeyPath'), textInput(editing.jumpPrivateKeyPath, (value) => setEditing({ ...editing, jumpPrivateKeyPath: value })), { key: 'jk' }) : null,
            ]),
          ]),
          React.createElement('details', { key: 'advanced', defaultOpen: true }, [
            React.createElement('summary', { key: 's' }, t('advancedTitle')),
            React.createElement('div', { key: 'b', className: 'dsh-remote__grid', style: { marginTop: '8px' } }, [
              field(t('readyTimeoutMs'), textInput(editing.readyTimeoutMs, (value) => setEditing({ ...editing, readyTimeoutMs: value }), { type: 'number', placeholder: '20000' }), { key: 'rt', hint: t('advancedHint') }),
              field(t('keepaliveIntervalMs'), textInput(editing.keepaliveIntervalMs, (value) => setEditing({ ...editing, keepaliveIntervalMs: value }), { type: 'number', placeholder: '15000' }), { key: 'ka', hint: t('advancedHint') }),
              field(t('maxOutputBytes'), textInput(editing.maxOutputBytes, (value) => setEditing({ ...editing, maxOutputBytes: value }), { type: 'number', placeholder: '262144' }), { key: 'mo', hint: t('advancedHint') }),
            ]),
          ]),
          React.createElement('div', { key: 'actions', className: 'dsh-remote__footer' }, [
            React.createElement('button', { key: 'cancel', onClick: () => { setEditing(null); setSaveError(''); } }, t('cancel')),
            React.createElement('button', { key: 'save', className: 'primary', disabled: saving, onClick: save }, saving ? t('saving') : t('save')),
          ]),
        ])
        : null;

      const kv = (label, value, key) => h('div', { key, className: 'dsh-remote__fielditem' }, [
        h('span', { key: 'l', className: 'dsh-remote__fieldlabel' }, label),
        h('span', { key: 'v', className: 'dsh-remote__fieldvalue' }, value),
      ]);
      const cards = servers.map((server) => {
        const testState = tests[server.id];
        const authText = server.authType === 'key' ? t('authKey')
          : server.authType === 'agent' ? t('authAgent') : t('authPassword');
        const jumpText = server.jump
          ? `${server.jump.username}@${server.jump.host}:${server.jump.port}`
          : t('jumpNone');
        return h('div', { key: server.id, className: 'dsh-remote__card' }, [
          h('div', { key: 'head', className: 'dsh-remote__cardhead' }, [
            h('div', { key: 'id', className: 'dsh-remote__identity' }, [
              h('span', { key: 'dot', className: `dsh-remote__dot${server.disabled ? ' off' : ''}` }),
              h('div', { key: 'body', style: { minWidth: 0 } }, [
                h('div', { key: 'name', className: 'dsh-remote__name' }, [
                  h('span', { key: 'n' }, server.name),
                  h('span', { key: 'sid', className: 'dsh-remote__chip id' }, server.id),
                  h('span', {
                    key: 'st',
                    className: `dsh-remote__chip ${server.disabled ? 'off' : 'ok'}`,
                  }, server.disabled ? t('stopped') : t('enabled')),
                  ...(server.tags ?? []).map((tag) => h('span', { key: `tag-${tag}`, className: 'dsh-remote__chip' }, tag)),
                ]),
                h('div', { key: 'ep', className: 'dsh-remote__endpoint' }, [
                  h(Icon, { key: 'i', name: 'terminal', size: 13 }),
                  h('span', { key: 'a' }, `${server.username}@${server.host}:${server.port}`),
                  h('span', { key: 'sep', className: 'dsh-remote__sep' }, '·'),
                  h('span', { key: 'auth' }, authText),
                  server.jump ? h('span', { key: 'jump' }, `→ ${jumpText}`) : null,
                ]),
                server.description
                  ? h('div', { key: 'desc', className: 'dsh-remote__desc' }, server.description)
                  : null,
              ]),
            ]),
            h('div', { key: 'ops', className: 'dsh-remote__actions' }, [
              h('button', {
                key: 'test',
                className: 'small',
                disabled: testState?.busy === true || server.disabled,
                onClick: () => void test(server),
              }, [
                h(Icon, { key: 'i', name: 'play', size: 13 }),
                h('span', { key: 'l' }, testState?.busy ? t('testing') : t('test')),
              ]),
              h('button', {
                key: 'edit',
                className: 'small ghost',
                title: t('edit'),
                'aria-label': t('edit'),
                onClick: () => startEdit(server),
              }, h(Icon, { key: 'i', name: 'edit', size: 14 })),
              h('button', {
                key: 'del',
                className: 'small ghost danger',
                title: t('remove'),
                'aria-label': t('remove'),
                onClick: () => void remove(server),
              }, h(Icon, { key: 'i', name: 'trash', size: 14 })),
            ]),
          ]),
          testState
            ? h('div', {
              key: 'test',
              className: `dsh-remote__test ${testState.busy ? 'dsh-remote__muted' : testState.ok ? 'dsh-remote__ok' : 'dsh-remote__err'}`,
            }, [
              h(Icon, { key: 'i', name: testState.busy ? 'refresh' : testState.ok ? 'check' : 'x', size: 13 }),
              h('span', { key: 'm' }, testState.busy
                ? t('testing')
                : (testState.ok ? `${t('testOk')} · ${testState.message}` : `${t('testFailed')} · ${testState.message}`)),
            ])
            : null,
          h('details', { key: 'details' }, [
            h('summary', { key: 's' }, [
              h(Icon, { key: 'i', name: 'sliders', size: 13 }),
              h('span', { key: 'l' }, t('details')),
            ]),
            h('div', { key: 'fields', className: 'dsh-remote__fields' }, [
              kv(t('host'), server.host, 'host'),
              kv(t('port'), String(server.port), 'port'),
              kv(t('username'), server.username, 'user'),
              kv(t('authType'), `${authText} · ${server.hasPassword ? t('passwordSaved') : t('passwordNone')}`, 'auth'),
              kv(t('privateKeyPath'), server.privateKeyPath || '—', 'key'),
              kv(t('workdir'), server.workdir || '—', 'workdir'),
              kv(t('tags'), (server.tags ?? []).join(', ') || '—', 'tags'),
              kv(t('readyTimeoutMs'), String(server.readyTimeoutMs ?? '—'), 'rt'),
              kv(t('keepaliveIntervalMs'), String(server.keepaliveIntervalMs ?? '—'), 'ka'),
              kv(t('maxOutputBytes'), String(server.maxOutputBytes ?? '—'), 'mo'),
              kv(t('jump'), jumpText, 'jump'),
              kv(t('createdAt'), server.createdAt ? new Date(server.createdAt).toLocaleString() : '—', 'created'),
              kv(t('updatedAt'), server.updatedAt ? new Date(server.updatedAt).toLocaleString() : '—', 'updated'),
            ]),
          ]),
        ]);
      });

      const output = runResult
        ? h('div', { className: 'dsh-remote__terminal' }, [
          h('div', { key: 'cmd', className: 'cmd' }, `$ ${runResult.command}`),
          runResult.stdout?.text ? h('div', { key: 'out' }, runResult.stdout.text) : null,
          runResult.stderr?.text ? h('div', { key: 'err', className: 'err' }, `[stderr]\n${runResult.stderr.text}`) : null,
          h('div', { key: 'meta', className: 'meta' }, [
            `${t('exitCode')}: ${runResult.exitCode}`,
            runResult.timedOut ? ` · ${t('timedOut')}` : '',
            ` · ${runResult.durationMs}ms`,
          ].join('')),
        ])
        : null;

      return h('div', { className: 'dsh-remote' }, [
        h('div', { key: 'head', className: 'dsh-remote__head' }, [
          h('div', { key: 'text', className: 'dsh-remote__headtext' }, [
            h('h2', { key: 'title' }, t('title')),
            h('p', { key: 'sub', className: 'dsh-remote__sub' }, t('subtitle')),
          ]),
          h('div', { key: 'actions', className: 'dsh-remote__actions' }, [
            h('button', {
              key: 'refresh',
              className: 'ghost icon',
              title: t('refresh'),
              'aria-label': t('refresh'),
              disabled: loading,
              onClick: () => void load(),
            }, h(Icon, { key: 'i', name: 'refresh', size: 16 })),
            h('button', { key: 'add', className: 'primary', onClick: () => startEdit(null) }, [
              h(Icon, { key: 'i', name: 'plus', size: 15 }),
              h('span', { key: 'l' }, t('add')),
            ]),
          ]),
        ]),
        file
          ? h('div', { key: 'config', className: 'dsh-remote__configbar' }, [
            h(Icon, { key: 'i', name: 'file', size: 14 }),
            h('span', { key: 'label', className: 'dsh-remote__configlabel' }, t('file')),
            h('span', { key: 'path', className: 'dsh-remote__path' }, file),
            h('button', {
              key: 'copy',
              className: 'ghost small',
              onClick: () => void copyPath(),
            }, [
              h(Icon, { key: 'i', name: 'copy', size: 13 }),
              h('span', { key: 'l' }, copied ? t('copied') : t('copyPath')),
            ]),
            h('button', {
              key: 'json',
              className: 'ghost small',
              onClick: () => setShowJson(!showJson),
            }, showJson ? t('hideJson') : t('showJson')),
          ])
          : null,
        showJson ? h('pre', { key: 'json', className: 'dsh-remote__json' }, configJson) : null,
        file ? h('div', { key: 'hint', className: 'dsh-remote__note' }, t('configHint')) : null,
        warnings.length > 0
          ? h('div', { key: 'warn', className: 'dsh-remote__banner error' }, `${t('warnings')}: ${warnings.join('; ')}`)
          : null,
        h('div', { key: 'bar', className: 'dsh-remote__toolbar' }, [
          h('span', { key: 'count', className: 'dsh-remote__chip' }, `${servers.length} ${t('serverCount')}`),
          h('span', { key: 'enabled', className: 'dsh-remote__muted' }, `${t('enabled')} ${enabledServers.length}`),
        ]),
        loadError ? h('div', { key: 'loaderr', className: 'dsh-remote__banner error' }, loadError) : null,
        editor,
        loading
          ? h('div', { key: 'loading', className: 'dsh-remote__muted' }, t('loading'))
          : (servers.length === 0
            ? h('div', { key: 'empty', className: 'dsh-remote__empty' }, [
              h(Icon, { key: 'i', name: 'server', size: 30 }),
              h('strong', { key: 't' }, t('empty')),
              h('div', { key: 'h', className: 'dsh-remote__note' }, t('emptyHint')),
              h('button', { key: 'add', className: 'primary', style: { marginTop: '12px' }, onClick: () => startEdit(null) }, [
                h(Icon, { key: 'i', name: 'plus', size: 15 }),
                h('span', { key: 'l' }, t('add')),
              ]),
            ])
            : h('div', { key: 'cards', className: 'dsh-remote__list' }, cards)),
        h('div', { key: 'cmdpanel', className: 'dsh-remote__panel' }, [
          h('div', { key: 'head', className: 'dsh-remote__panelhead' }, [
            h('div', { key: 'text' }, [
              h('strong', { key: 't' }, t('commandTitle')),
              h('div', { key: 'h', className: 'dsh-remote__note' }, t('commandHint')),
            ]),
          ]),
          h('div', { key: 'ta', className: 'dsh-remote__field', style: { marginTop: '10px' } },
            h('textarea', {
              value: command,
              placeholder: t('commandPlaceholder'),
              onChange: (event) => setCommand(event.target.value),
              onKeyDown: (event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void run();
              },
            })),
          h('div', { key: 'runbar', className: 'dsh-remote__runbar' }, [
            h('select', {
              key: 'server',
              value: runServer,
              onChange: (event) => setRunServer(event.target.value),
            }, enabledServers.length === 0
              ? [h('option', { key: 'none', value: '' }, t('noEnabled'))]
              : enabledServers.map((server) => h('option', { key: server.id, value: server.id }, `${server.name} (${server.id})`))),
            h('button', {
              key: 'run',
              className: 'primary',
              disabled: running || !runServer || command.trim() === '',
              onClick: () => void run(),
            }, [
              h(Icon, { key: 'i', name: 'play', size: 14 }),
              h('span', { key: 'l' }, running ? t('running') : t('run')),
            ]),
            h('button', {
              key: 'clear',
              className: 'ghost',
              onClick: () => { setRunResult(null); setRunError(''); },
            }, t('clear')),
          ]),
          runError ? h('div', { key: 'runerr', className: 'dsh-remote__banner error' }, runError) : null,
          output,
        ]),
      ]);
    }

    const name = 'dsh-remote';
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'remote-config', order: 35, label: () => t('nav'), inject: () => ({ t }) },
          RemoteSection,
        );
      });
      // Full page in the sidebar, next to the host's own pages. The row selects
      // the `main` panel registered with the same key.
      // The row waits for the slot itself: registering it from inside the
      // parent slot's own injection can be missed by the host's list sync.
      ctx.slots.inject('sidebar.panellist', function* () {
        yield ctx.slots.register(
          { name: 'main', key: 'dsh-remote', locale: NS, inject: () => ({ t }) },
          (props) => React.createElement('div', { className: 'dsh-remote__page' }, React.createElement(RemoteSection, props)),
        );
      });
      ctx.slots.inject('sidebar.panellist', function* () {
        yield ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dsh-remote', order: 3, label: () => t('nav'), locale: NS },
          // Plain inline markup with a fixed size: the row calls this as a
          // function component, and anything it cannot resolve renders as an
          // empty inline-flex span next to the label.
          ((owner) => {
            const size = typeof owner === 'number' ? owner : owner?.size ?? 16;
            return React.createElement('svg', {
              width: size,
              height: size,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
              style: { display: 'block' },
            }, [
              React.createElement('rect', { key: 'a', x: 3, y: 4, width: 18, height: 7, rx: 2 }),
              React.createElement('rect', { key: 'b', x: 3, y: 13, width: 18, height: 7, rx: 2 }),
              React.createElement('circle', { key: 'c', cx: 7, cy: 7.5, r: 1.2, fill: 'currentColor', stroke: 'none' }),
              React.createElement('circle', { key: 'd', cx: 7, cy: 16.5, r: 1.2, fill: 'currentColor', stroke: 'none' }),
              React.createElement('path', { key: 'e', d: 'M11 7.5h6M11 16.5h6' }),
            ]);
          }),
        );
      });
    }

    return { name, inject, apply };
  },
});
