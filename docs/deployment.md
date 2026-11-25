# chat-demo 部署记录（aecci.net）

部署时间：2026-11-25 · 版本：chat-demo v0.1.4（commit `cdf9617`）

## 访问地址

| 入口 | 状态 |
| --- | --- |
| https://aecci.net/ | 200，HTTP/2 + gzip |
| https://www.aecci.net/ | 200（与主域同一站点） |
| IPv6 `2607:8700:5500:3694::2` | 200 |
| https://aecci.net/chat-demo/ | 301 → `https://aecci.net/`（旧路径兼容） |

证书：`/etc/nginx/ssl/aecci.net.crt`（CN=aecci.net，SAN 含 www，有效期至 2027-02-08，由 acme.sh 自动续期）。

## 访问方式与限制

| 方式 | 结果 | 说明 |
| --- | --- | --- |
| https://aecci.net/ · https://www.aecci.net/ | ✅ 200 | 推荐入口，IPv4 / IPv6 均可用 |
| http://65.49.234.80/ · http://[2607:...::2]/ | ✅ 301 | 80 端口默认 server 统一跳转到 `https://aecci.net/`，IPv4/IPv6 行为一致 |
| https://65.49.234.80/（严格校验） | ❌ 证书名不匹配 | 证书 SAN 只有 `aecci.net`、`www.aecci.net`，不含 IP；`curl -k` 可访问（200），但浏览器会拦截 |
| https://[2607:...::2]/（严格校验） | ❌ 同上 | 用域名访问即可 |
| IPv6 访问不通时 | — | 服务器侧已验证监听 `[::]:80/443` 且公网可达；若客户端无 IPv6 出口或 ISP 不支持则无法访问，属网络环境问题 |

> 若确实需要「https 直接访问 IP」：需要申请含 IP SAN 的证书（Let's Encrypt 2025 起支持 IP 证书，但为约 6 天有效期的短证书，需持续自动续期），不推荐；建议始终用域名访问。

## 服务器与目录

- 服务器：AlmaLinux 10.3，nginx 1.26.3，3 vCPU / 2G 内存，SSH 已配置免密钥（ed25519，IPv4 + IPv6）
- 代码仓库：`/root/chat-demo`（git，分支 **`aecci`**，跟踪 `origin/aecci`；远端 fork = `clearnature/chat-demo`，上游 = `deepseek-ai/chat-demo`）
- 发布目录：`/home/wwwroot/chat-demo`（owner `nginx:nginx`，只读权限）
- nginx 站点配置：`/etc/nginx/conf.d/aecci.conf`
- 原 WordPress 备份：`/root/backups/wordpress-main-20261125.tar.gz`（37MB，含 SQLite 数据 `.ht.sqlite.php`）

## 模型服务：DeepSeek 官方 / OpenCode Go

前端支持两种模型服务，在 **设置 → 数据管理 → 模型服务** 切换：

| 服务 | 协议 | Key 存储键 | 说明 |
| --- | --- | --- | --- |
| DeepSeek 官方（默认） | Anthropic Messages（`/anthropic/v1/messages`） | `chat-demo:api-key` | 保留全部原能力：联网搜索、阅读链接、附件、思考、服务端标题 |
| OpenCode Go | OpenAI Chat Completions（`/oc-api/chat/completions`） | `chat-demo:opencode-api-key` | 纯文本对话 + 思考（`reasoning_content`）；**模型列表自动从 `/oc-api/models` 拉取**（31 个 chat 模型），5 分钟缓存，可手动刷新；拉取失败时回退为手动输入 |

OpenCode Go 的接入细节：

- **同源反向代理**：opencode.ai 不支持浏览器 CORS（OPTIONS 预检返回 404），因此 nginx 把本站 `/oc-api/` 转发到 `https://opencode.ai/zen/go/v1/`，前端只请求同源路径。
  代理配置见 `aecci.conf` 的 `location ^~ /oc-api/`（`proxy_buffering off` 保证流式；`Host: opencode.ai`；剥离 Origin）。
- **会话头**：Go 要求每个会话带稳定的 `x-opencode-session`，前端用本地会话 ID 填充，用于路由与提示缓存。
- **Key 校验**：保存前用 `GET /oc-api/models` 校验（不产生生成费用）。
- **模型列表**：设置页打开时自动 `GET /oc-api/models`（带用户 Key），只保留 `type: "chat"` 的条目，展示 `名称 · id`；已保存但服务端已下线的模型仍保留为选项兜底；5 分钟缓存，可用刷新按钮强制重取。
- **能力差异**（前端已做限制）：
  - 联网搜索 / 阅读链接：不可用（OpenAI 兼容协议没有 `deepseek_web_search` / `deepseek_read_url`），设置里搜索开关置灰。
  - 附件上传：不可用（没有 Files API），选择附件会提示。
  - 对话前缀续写：不可用，回复不显示「继续生成」。
  - 服务端标题：没有该扩展，标题取首条提问前 30 字兜底。
  - `latest_reminder`：不发送。
- **使用条款提示**：OpenCode Go 定位是面向 coding agent 的订阅，官方会监控异常流量；用在本聊天 demo 上属于订阅者的自主选择，风险自担。
- API Key 只存在浏览器 localStorage，不经过服务器存储；服务器只做透明转发。

## 域名统一与浏览器存储（重要）

chat-demo 的 API Key / 设置存在浏览器 `localStorage`，**按 origin（协议+域名+端口）隔离**：
`https://aecci.net`、`https://www.aecci.net`、`https://IP` 是三份互不相通的存储，在其中一个入口保存的
Key 到另一个入口会显示为空（刷新不会跨域，换入口才会）。

nginx 已统一入口：

| 请求 | 行为 |
| --- | --- |
| `https://www.aecci.net/`（页面导航） | 301 → `https://aecci.net/` |
| `https://www.aecci.net/static/*`、`/oc-api/*`（过渡兼容） | 直接服务/代理，不重定向 |
| `https://65.49.234.80/...`（HTTPS，IP 直连） | 301 → `https://aecci.net/...`（证书仅覆盖域名） |
| `https://www.aecci.net:8443/...`（DSH） | 301 → `https://aecci.net:8443/...` |

**过渡兼容**：仍开着的 www 旧标签页，其 `/static/*` 与 `/oc-api/*` 请求由 www 直接处理（不 301），
否则 XHR 会被跨域重定向到 apex、CORS 预检 404，前端会报「网络异常」。页面导航仍 301 到主域。

旧入口保底迁移页：`https://www.aecci.net/migrate.html`（www 域名下，根路径照常 301），
可读出该域名下保存的 `chat-demo:*` 设置并用复制按钮搬到主域重新保存。

> 登录页（DSH）的密码**不存浏览器**：服务端只存 scrypt 哈希，浏览器只持有 30 天
> `HttpOnly; Secure; SameSite=Lax` 会话 Cookie；登录表单使用标准 `POST /login` 以便浏览器密码管理器识别。

## 附录：DeepSeek Harness Web（baseline，隔离部署）

同一台服务器上另行部署了 [clearnature/deepseek-harness](https://github.com/clearnature/deepseek-harness) 的 **`server` 分支** Web UI（= `baseline` + `deploy/server/` 部署资产），与 chat-demo 完全隔离。

| 项目 | 值 |
| --- | --- |
| 访问入口 | `https://aecci.net:8443/`（TLS 复用 aecci 证书 + Basic Auth + DSH launch token） |
| 服务 | `dsh-web.service`（systemd，已 enable） |
| 运行用户 | `dsh`（uid 1000，无密码、不可登录） |
| 代码 | `/opt/dsh/app`（git `server`，浅克隆；`server` = `baseline` + 部署资产，见仓库 `deploy/server/`） |
| 运行数据 | `DSH_HOME=/opt/dsh/data`（含服务端 API Key 凭据文件，600 权限） |
| 独立工具链 | Node v24.14.0 + pnpm 12.18.0 位于 `/opt/dsh/toolchain`（不依赖 root 的 fnm） |
| 监听 | 仅 `127.0.0.1:3080`；公网只经 nginx `8443` 反代 |
| 构建 | `pnpm run build:artifacts`（`NODE_OPTIONS=--max-old-space-size=3072`，8 gates ≈ 284s，峰值靠 swap） |
| 凭据/凭据说明 | `/root/dsh-secrets/`（`web.txt`、`launch-url.txt`、`README.txt`，仅 root） |
| nginx 配置 | `/etc/nginx/conf.d/dsh-web.conf`（Basic Auth、WebSocket、SSE、`proxy_cookie_flags ~ secure`） |
| 沙箱 | systemd `ProtectSystem=strict` + `ReadWritePaths=/opt/dsh` + `PrivateTmp` + `NoNewPrivileges` + 空 capability；`systemd-analyze security` 3.6 OK |
| 资源上限 | `MemoryHigh=1000M`、`MemoryMax=1400M`、`CPUQuota=200%`（实测常驻约 375MB） |

**部署资产（server 分支）**：`deploy/server/install.sh`（首次安装：建用户/独立 toolchain/拉代码/构建/装服务与 nginx 入口）、`update.sh`（拉取 + 构建 + 重启）、`dsh-web.service`（沙箱单元模板）、`nginx-dsh-web.conf`（入口模板）、`README.md`（完整说明）。更新 DSH 本体：`git merge baseline` 到 `server` 后再执行 `update.sh`。

**安全边界**：DSH 是能执行命令/读写工作区的 agent 框架（官方 SAFETY.md 明确未经过安全审计），因此公网入口必须始终保持 Basic Auth + TLS + launch token 三层；`ReadWritePaths=/opt/dsh` 保证它无法写 chat-demo 站点目录、nginx 配置等。服务端 API Key 由使用者在 Web UI 内填写，保存在 `DSH_HOME` 凭据文件，不写入配置或环境变量。

## 更新发布流程

```sh
ssh root@65.49.234.80
cd /root/chat-demo
git pull --ff-only        # 跟踪 origin/aecci
pnpm install --frozen-lockfile
NODE_ENV=production pnpm build
rm -rf /home/wwwroot/chat-demo && mkdir -p /home/wwwroot/chat-demo
cp -a dist/. /home/wwwroot/chat-demo/
chown -R nginx:nginx /home/wwwroot/chat-demo
chmod -R u=rwX,go=rX /home/wwwroot/chat-demo
```

- 静态文件直接覆盖即可，**不需要 reload nginx**；`index.html` 引用带内容哈希的资源，浏览器缓存自动失效。
- 若改了 `apiOrigin`：在 `rspack.config.ts` 的 `createConfig()` 处调整后重新构建。

## 回滚到 WordPress

```sh
# 1. 恢复 nginx 配置（备份文件带时间戳）
cp -a /etc/nginx/conf.d/aecci.conf.bak.20261124-214307 /etc/nginx/conf.d/aecci.conf
nginx -t && systemctl reload nginx

# 2. 恢复站点文件
mkdir -p /home/wwwroot/main
tar -xzf /root/backups/wordpress-main-20261125.tar.gz -C /home/wwwroot
chown -R nginx:nginx /home/wwwroot/main

# 3. 恢复 PHP
systemctl enable --now php-fpm
```

## 本次变更记录

1. nginx 主站 root 由 `/home/wwwroot/main`（WordPress）切换为 `/home/wwwroot/chat-demo`；
   移除 WordPress 专用 location（`wp-login.php` 限流、`xmlrpc.php` 拒绝、`\.php$` FastCGI），
   保留 `/search/`（searx）、`/xh-cfc31134`、`/cfc31134-...`（v2ray websocket）等代理入口。
2. 新增：`/static/` 长缓存（30d + immutable）、gzip、`/chat-demo/` 兼容跳转、`/index.html` 不缓存（发版即生效）。
5. 站点标题与侧边栏应用名由 `API 使用 demo` 改为 `deepwork-chat`
   （`src/index.html` + `src/i18n/zh.ts` + `src/i18n/en.ts`，已同步到服务器仓库并重新构建发布）。
   提交：`aecci` 分支 `bf0dfce`（本地、服务器、origin/aecci 三方已对齐；服务器原提交 `4e2a64e` 因内容一致已 reset 到 `bf0dfce`）。
3. 停用并禁用 `php-fpm`（原常驻约 77–81MB，2 个 worker，CPU 空闲）；WordPress 文件与 SQLite 数据已备份后删除。
4. 删除过期 `/var/lib/mysql`（113MB，MariaDB 系统表残留，包未安装、无用户数据库）。磁盘共回收约 239MB。

## 注意事项

- 浏览器直连 `https://api.deepseek.com`，CORS 预检已验证通过（含 `anthropic-beta`，附件上传可用）；API Key 只存在用户浏览器 localStorage，不落服务器。
- searx（`/search/`）在切换前就返回 502：`127.0.0.1:8888` 无监听，与本次部署无关，需要修复时另行处理。
- SSH 目前仍允许密码登录（`PermitRootLogin yes` + 密码），仅配置了免密钥；建议后续关闭密码登录、只保留密钥。
- `/root/chat-demo/node_modules` 保留，便于下次在服务器上直接构建；如磁盘紧张可删除（在服务器构建时重新 `pnpm install`）。
- 本机推送 GitHub 曾遇到 `Error in the HTTP2 framing layer`，已在本地仓库固化 `git config http.version HTTP/1.1` 规避。

## 访客 IP 页脚

- nginx 在 apex 与 www 的 443 server 块中提供同源接口 `location = /api/ip`，返回 `{"ip":"$remote_addr"}`（不缓存）。
- 前端组件 `src/components/base/VisitorIp.tsx` 在页面底部显示「当前访问 IP / Your IP」；请求失败时整条页脚自动隐藏，不影响页面。
- 部署后可用 `curl -s https://aecci.net/api/ip` 自检。
