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
3. **版本号单一来源，但有三处派生副本**。`package.json` 的 `version` 是唯一来源，运行时、
   镜像 tag、`/api/health`、侧栏都从它读；而 `agent/agent.sh` 的 `VERSION` 与两份 demo 快照的
   `appVersion` 必须跟着同步 —— 节点机上没有 `package.json`、静态演示站上没有 Node，
   这两类位置做不到运行时读取（旧版这里写的是「下发时会被替换」，是错的）。
   **别手工改副本**，用 `npm run version:set -- <新版本>`；`npm test` 与 CI 第一道会检查，
   不一致直接红灯。详见 README「版本号维护」。

## 提交前请自测

```bash
# 1) 单元 / 端到端（不需要起服务）
node test/version.js    # 版本号四处一致（CI 第一道，一秒钟，别跳过）
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
| 加一个接口 | `server.js` 的 `ROUTES` 表加一行（`[方法, 路径, 处理函数, 是否需要登录]`）；处理函数写在对应的 `server/<域>.js` 里并从那里导出，`server.js` 只负责挂表 |
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

## 发版流程（接手的人先看这一节）

一次发布只递增末位一位（`0.1.33 → 0.1.34`），本版所有改动合进**同一个提交**：

1. 改代码 → 跑全量测试。
2. **版本号由维护者明确确认**。AI 助手和脚本都不会自己定、也不会自动递增；
   确认后用 `npm run version:set -- 0.1.34` 一次写全四处。
3. 手工在 `CHANGELOG.md` 补一个 `## [0.1.34]` 段落，把本版所有改动写进这一段
   （一个版本一个段落；已发布的旧段落不要回填）。
4. `npm run test:version` 复核，`npm test` 跑全量。
5. `git commit`：一个版本一个提交，用精确路径 stage，不要 `git add -A`。
6. **只有维护者明确说「推送」才 `git push origin main`**。推送会触发 CI 并往 ghcr 推镜像 tag，
   误推的 tag 删不掉；含 `.github/workflows/` 变更的提交还需要 token 有 Workflows 写权限。
   说「commit」只提交到本地，这是硬规矩，没有例外。

> `.workbuddy-ai/` 已被 `.gitignore` 排除，里面的笔记只是本机助手的备忘，
> **不是规范来源**。仓库内以本文件、README 和 CI 检查结果为准。

## PR

- 一个 PR 只做一件事，附上「怎么验证的」。
- 破坏兼容的改动（接口字段、下发协议、schema 语义）请在描述里写清影响面。
- 提交信息用中文或英文都行，能说清改了什么即可。

## 不打算做的方向

见 README 的「非目标」。提之前先看一眼，能省彼此时间。
