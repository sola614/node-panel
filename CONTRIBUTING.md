# 参与开发

欢迎提 Issue 和 PR。这个项目刻意做得很小，所以有几条硬规矩，先看完再动手能省一轮 review。

## 本地跑起来

```bash
node server.js            # 需要 Node.js 22.13+
# → http://localhost:8080   首次登录 admin / admin888（会强制你改密）
```

想看有数据的样子：

```bash
PANEL_SEED_DEMO=1 PANEL_DATA_DIR=./.demo node server.js
```

## 三条不可破的约定

1. **零运行时依赖**。面板只用 Node 标准库（数据库是内置 `node:sqlite`，HTTP 是内置 `http`），
   agent 是纯 POSIX shell。新增 `dependencies` 基本不会被接受；需要某个能力时先想标准库能不能做。
2. **前端零构建**。`public/js/*.js` 是经典脚本（不是 ES module），由 `index.html` 按顺序加载，
   顶层声明在全局词法环境里互相可见。别引入打包器、别写 `import`。
3. **版本号单一来源**。只改 `package.json` 的 `version`，agent 的 `VERSION` 会在下发时被服务端替换。

## 提交前请自测

```bash
# 1) 单元 / 端到端（不需要起服务）
node test/hosts.js      # 前后端共享的域名校验
node test/renew.js        # 续期逻辑
node test/security.js     # 强制改密、登录限流、升级前备份（自带独立实例）

# 2) 接口冒烟（先起一个测试实例，用非出厂密码，否则会被强制改密拦住）
PANEL_DATA_DIR=./.tmp-test PORT=8080 PANEL_ADMIN_PASSWORD=test-pass-123 node server.js &
PANEL_ADMIN_PASSWORD=test-pass-123 node test/smoke.js http://127.0.0.1:8080
PANEL_ADMIN_PASSWORD=test-pass-123 node test/ui.js    http://127.0.0.1:8080
```

两套端到端测试都是幂等的，会自己清理 `SMOKE-*` / `UI-*` 数据。

## 改代码时的常见落点

| 想做的事 | 改哪里 |
| --- | --- |
| 加一个页面 | `public/index.html` 加 `.nav-item` → `public/js/core.js` 的 `VIEWS` → 新建 `public/js/views-*.js` 并在 `index.html` 里按序引入 → 写 `RENDERERS.<名字>` |
| 加一个接口 | `server.js` 的 `ROUTES` 表加一行（`[方法, 路径, 处理函数, 是否需要登录]`）；权限默认要登录 |
| 加一个字段 | `lib/store.js` 的 `TABLE_SPECS` 加列 → `ensureColumn()` → `migrate()` 补默认值 → `SCHEMA_VERSION` +1 |
| 改节点协议 | `lib/xray.js` / `lib/hysteria.js`（配置）+ `lib/sub.js`（分享链接与 Clash） |
| 改下发逻辑 | `lib/agentBundle.js`（编译成 shell 包）+ `agent/agent.sh`（落盘执行） |

### 改 schema 的硬要求

- 只做**加法**：加列、加表。不要删列、不要改语义，否则老库升上来会炸。
- `SCHEMA_VERSION` 必须递增。升级前会自动备份到 `data/backups/`，但别依赖它兜底。
- 自测一次「降级」：把新加的列 `ALTER TABLE ... DROP COLUMN` 掉，重启面板，确认能自愈。

### 前端样式

所有颜色必须走 `public/style.css` 顶部的 CSS 变量（`var(--bg)` / `var(--text)` / `var(--accent)` …），
写死色值会在日间皮肤下漏出破绽。

## PR

- 一个 PR 只做一件事，附上「怎么验证的」。
- 破坏兼容的改动（接口字段、下发协议、schema 语义）请在描述里写清影响面。
- 提交信息用中文或英文都行，能说清改了什么即可。

## 不打算做的方向

见 README 的「非目标」。提之前先看一眼，能省彼此时间。
