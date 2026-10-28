# dsh-remote

远程服务器管理插件：在 DSH 里保存 SSH 服务器配置，让模型通过 `remote_*` 工具连接服务器执行命令、传输文件；同时在「设置 → 远程服务器」里提供可视化配置页和快速命令面板。

## 功能

- **服务器配置**：名称、主机、端口、用户名、密码 / 私钥 / SSH Agent、私钥口令、跳板机、默认工作目录、标签、描述、连接超时、保活间隔、输出上限、停用开关。
- **连接池**：按服务器复用 SSH 连接，配置变更或连接断开时自动重建；空闲 60 秒回收。
- **命令执行**：非交互执行，支持工作目录、环境变量、`sudo`、登录 shell、TTY、标准输入和超时。
- **文件传输**：SFTP 上传、下载、读文本、写文本、列目录、查看元数据。
- **侧边栏入口**：左侧边栏新增「远程服务器」页面，和设置页共用同一套配置与命令面板；不打开设置也能日常使用。
- **网页设置页**：新增 / 编辑 / 删除服务器，测试连接，直接跑命令并查看 stdout / stderr / 退出码。
- **显式配置**：页面顶部展示配置文件路径，可复制路径、查看脱敏后的 JSON；每台服务器都有「配置详情」，逐项列出主机、端口、认证、私钥路径、工作目录、标签、超时、保活、输出上限、跳板机和时间戳。
- **安全**：配置文件权限 0600；列表接口不回传密码；支持 `env:NAME` / `${NAME}` 引用环境变量，避免密文落盘；HTTP 接口要求同源并经过 DSH 宿主的请求门禁。

## 工具

| 工具 | 说明 |
| --- | --- |
| `remote_list_servers` | 列出服务器，可按 id / 名称 / 主机 / 标签过滤 |
| `remote_save_server` | 新增或更新服务器（更新只需给要改的字段） |
| `remote_remove_server` | 删除本地配置 |
| `remote_test_connection` | 测试连接，返回登录用户、系统、家目录和延迟 |
| `remote_exec` | 执行命令，返回 stdout / stderr / 退出码 |
| `remote_sftp` | list / read / write / upload / download / stat |

`server` 参数填服务器 id 或精确名称。命令由远端登录用户的 shell 执行；插件不会在本地起 shell。

## 配置文件

默认位置：`<DSH_HOME>/dsh-remote/servers.json`（Windows 通常是 `C:\Users\<你>\.dsh\dsh-remote\servers.json`）。

```json
{
  "version": 1,
  "servers": [
    {
      "id": "prod-web",
      "name": "生产 Web",
      "host": "10.0.0.10",
      "port": 22,
      "username": "deploy",
      "password": "env:PROD_SSH_PASSWORD",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "workdir": "/srv/app",
      "tags": ["web", "prod"],
      "description": "对外 Web 服务器",
      "disabled": false,
      "readyTimeoutMs": 20000,
      "keepaliveIntervalMs": 15000,
      "maxOutputBytes": 262144
    }
  ]
}
```

密码、私钥口令、跳板机密码都支持 `env:NAME` 与 `${NAME}` 两种环境变量引用。引用在建立连接时解析；变量缺失会给出明确错误。

## 插件自身配置

`cordis.patch.yml` 里的 `dsh-remote.config` 支持：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultTimeoutMs` | `120000` | `remote_exec` 未指定超时时的默认值 |
| `connectionIdleMs` | `60000` | SSH 连接池空闲回收时间 |
| `allowWebExec` | `true` | 是否允许网页侧边栏/设置页直接执行命令 |
| `dataFile` | `<DSH_HOME>/dsh-remote/servers.json` | 覆盖配置文件路径 |

## 使用示例

```
# 看有哪些服务器
remote_list_servers {}

# 新增
remote_save_server {
  "name": "测试机",
  "host": "192.168.1.20",
  "username": "root",
  "password": "env:TEST_SSH_PASSWORD"
}

# 执行命令
remote_exec {
  "server": "测试机",
  "command": "uptime && df -h && systemctl is-active nginx"
}

# 通过 sudo 执行
remote_exec {
  "server": "测试机",
  "command": "systemctl restart nginx",
  "sudo": true,
  "sudoPassword": "env:TEST_SUDO_PASSWORD",
  "timeoutMs": 60000
}

# 上传并读取
remote_sftp { "server": "测试机", "action": "upload", "localPath": "dist/app.tar.gz", "remotePath": "/tmp/app.tar.gz" }
remote_sftp { "server": "测试机", "action": "read", "remotePath": "/etc/nginx/nginx.conf" }
```

## 从源码安装

克隆后直接用 DSH 的插件管理器安装本地目录即可（会自动打包并链接进 profile）：

```bash
git clone https://github.com/iemgnod/dsh-remote.git
# 然后在 DSH 的插件管理里选择「安装本地目录」，指向克隆下来的目录
```

## 安装到本机 DSH

开发时可以用桌面版自带的 CLI 把本地目录装进 profile：

```powershell
# 1. 在插件目录打包（只包含 src / client / locale 等，不含 node_modules）
npm pack --ignore-scripts

# 2. 安装到 desktop profile
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add file:D:\path\to\dsh-remote-0.1.0.tgz
```

安装后把包名加入 profile 的 `package.json` → `dsh.profile.bundles`，或在插件管理页启用；没有 HMR 时需要重启 DSH。

## 安全说明

- 插件以 DSH 进程权限读写本地配置文件；密码若不以 `env:` 引用，会以明文（权限 0600）保存在 `servers.json`。
- `remote_exec` 以远端 SSH 用户的权限执行任意命令，没有本地命令白名单。请只把服务器交给可信的模型/会话，并优先使用权限较小的登录用户。
- 网页端 `/dsh-remote` 只接受同源请求，并先询问 DSH 宿主的 `connection.requestRejection`。DSH 的 web server 本身不做全局认证，因此不要把 DSH 端口暴露到不可信网络。
- 想关闭网页端命令执行，可在 `cordis.patch.yml` 的 `dsh-remote.config` 里设置 `allowWebExec: false`。

## 开发与测试

```bash
node test/store.test.mjs
node test/ssh.test.mjs
node test/command.test.mjs
node test/routes.test.mjs
node test/tools.test.mjs
```

测试里的 SSH 服务器在进程内启动（`test/ssh-server.mjs`），覆盖密码认证、命令执行、超时、SFTP 与跳板机转发。由于 DSH 的 Windows 沙箱不允许管道式 stdio，测试服务器使用一个最小 POSIX 解释器而不是真正 spawn bash。

## 已知限制

- 命令执行面向 POSIX（Linux / macOS）服务器；Windows OpenSSH 的 `cmd`/PowerShell 默认 shell 不支持 `cd --` / `export` 包装。
- 暂不支持交互式终端会话、端口转发、SFTP 递归目录传输。
- 连接池只在插件生命周期内有效；DSH 重启后需要重新连接。
