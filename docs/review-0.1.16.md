# node-panel 0.1.16 架构评审报告

| 项 | 内容 |
| --- | --- |
| 评审对象 | 工作区未提交改动（`package.json` 0.1.15 → **0.1.16**），17 个文件、+2768 / −80 行 |
| 评审视角 | 架构师：正确性、失效模式、兼容与迁移、可运维性、安全边界、代码结构 |
| 评审日期 | 2026-10-29 |
| 评审方式 | 全量 diff 走读 + 关键路径实测（起真实实例复现）+ 四套测试全跑 |
| 结论 | **不建议直接发版**：5 个阻断级问题（其中 3 个会造成静默错账 / 静默宕机），修复成本都不高 |

---

## 一、结论摘要

改动本身的设计质量是好的：兼容期做了双向兼容、401 与"连不上"做了语义区分、卸载逻辑只保留一份实现、
订阅与配置层的可见性规则收敛到 `planCovers` 一处 —— 这些都是对的决策。测试也跟得上（smoke 314→369、
agent 46→70、ui 172→183）。

问题集中在**"失败路径没有被验证过"**这一类：happy path 全部正确且有测试，但一旦证书配错、
端口被占、agent 被重装、面板记录被删后重建，系统会进入**日志看不出来、界面看不出来**的错误状态。

| 级别 | 数量 | 含义 |
| --- | --- | --- |
| P1 阻断 | 5 | 静默错账 / 静默宕机 / 宣称的能力实际未生效，建议发版前修 |
| P2 中等 | 9 | 边界场景、体验与一致性，可与本版一起或紧随其后 |
| P3 低 | 4 | 仓库卫生、措辞、性能微优化 |

**实测结果**（本机，`PANEL_ADMIN_PASSWORD=ci-test-pass-123`，临时数据目录）：

```
test/smoke.js     369 项通过   0 失败
test/ui.js        183 项通过   0 失败
test/agent.js      70 项通过   0 失败   （8 分 41 秒）
test/security.js   26 项通过   0 失败
```

测试全绿，但下面的 P1 问题**没有一条被现有测试覆盖** —— 这是本次评审最值得注意的一点。

---

## 二、P1 阻断级问题

### P1-1 v2 流量上报缺少"agent 实例代数"，重装后永久丢弃、重接入后全量重算

**位置**：`agent/agent.sh:1316`（`report_v2`）、`server.js:3809`（`duplicate` 分支）、`server.js:3830`（水位差值）、
`server.js:2418` / `1617`（`clearReportState`）

v2 协议用「累计字节 + 单调序号」对账，但**序号和累计值都只存在于机器本地**（`STATE_DIR/.seq`、`STATE_DIR/totals`），
面板侧没有任何标识能区分"同一台机器的第 N 次上报"和"这台机器重装后的第一次上报"。于是两个方向都会错：

**方向一：重装后流量永远不再入账（静默丢账）**

1. 机器上执行 `sh /opt/nodepanel/uninstall.sh`（本版新增的入口，会 `rm -rf $STATE_DIR`），或重装系统、手删目录；
2. 面板上的服务器记录**没有删**，重新跑一遍部署命令 → `STATE_DIR` 重建，`.seq` 从 0 开始；
3. agent 第一次上报 `seq=1`，而面板 `@seq` 水位停在比如 `50000`；
4. 面板判 `seq <= lastSeq` → 整批丢弃，**回 200 `{duplicate:true}`**；
5. agent 侧 `http_post_json` 成功 → 打印「↑ 已上报累计流量（序号 1）」。

结果：面板上这台机器看起来一切正常（回执、心跳、在线状态都对），但**流量从此刻起永久不再计入**，
直到序号自然追平（60 秒一轮，`50000` 轮 ≈ 35 天），或者管理员恰好删掉记录重建。
没有任何日志、任何界面能暴露这件事。

**方向二：删记录后重新接入，全量累计被重算一遍（静默多计）**

1. 面板上删除服务器 → `deleteServer` 调 `clearReportState` 清掉水位；
2. 机器上的 agent 仍在跑（孤儿模式），`totals` 完好，继续累计；
3. 重新添加这台机器（新 `serverId`）→ 水位从 0 起算；
4. 首轮上报：`prev = 0`，`delta = totals 全量` → **这台机器自部署以来的全部流量被一次性记到用户头上**。

配额是硬约束，这会直接把用户打成"超额停用"。同样的路径也适用于"面板换新库 / 从 0.1.15 的旧备份恢复
（`report_state` 表为空）"。

**根因**：把"累计值"当成了全局单调量，但它其实是**某个 agent 实例的局部量**。协议缺一个 `gen` 字段。

**建议修复**（一个机制同时解决两个方向）：

- agent 首次创建 `totals` 时生成一个随机 `gen`（写入 `STATE_DIR/totals.gen`，与 totals 同生命周期）；
- 上报体加 `"gen":"<8 字节 hex>"`，面板 `report_state` 的哨兵行改成按 `(scope_id, gen)` 记水位；
- `gen` 变化 → **只建基线、不入账**（丢一个上报周期 ≈ 60 秒的量，可接受）；
- 旧 agent 不带 `gen` → 按 `gen=''` 处理，行为与现在完全一致（兼容期不受影响）。

**最小兜底**（若不想动协议）：`lastSeq === 0` 时只写水位、不入账，即"首报建基线"。
但这会让"v2 首次启用"少记一轮，且**解决不了方向一**（重装后 seq 变小仍会被当重复丢弃），
所以只建议作为临时措施。

---

### P1-2 探测的 SAN 校验是死代码：`subjectaltstring` 字段不存在

**位置**：`server.js:1757`

```js
const sans = String(c.subjectaltstring || '')   // ← 字段名写错
  .split(',')...
if (sans.length && !cert.sniMatchesDomains(sans, sni)) { ... }
```

Node 的 `tlsSocket.getPeerCertificate()` 返回的字段是 **`subjectaltname`**，`subjectaltstring` 恒为 `undefined`。
实测（自签证书 `DNS:probe.test, DNS:alt.test`）：

```
subjectaltname  = "DNS:probe.test, DNS:alt.test"
subjectaltstring = undefined
```

所以 `sans` 恒为 `[]` → `sans.length` 为 0 → **SAN 覆盖检查一次都不会执行**。

**影响**：README 与 CHANGELOG 都把这个能力写成了卖点 ——
「TLS 抽检：看证书是否过期、**SAN 是否覆盖 SNI**」「能发现什么：**挂错证书**、证书过期」。
实际上"挂错证书"这一类（本版新增 SNI 一致性校验专门防的那种故障）探测不出来，
只剩"证书是否过期"一项有效。这是**宣称能力与实现不符**，比没有这个功能更糟。

**顺带**：就算改成 `subjectaltname`，代码把 SAN 里的 `IP Address:1.2.3.4` 条目只剥了 `DNS:` 前缀，
IP 证书（本版明确支持，smoke 里有"IP 证书的 SNI 填 IP 可以保存"）会被判成"证书域名不包含 SNI"。
修复时要一并处理：按 `DNS:` / `IP Address:` 分类型比对，IP 走字符串全等而不是通配符匹配。

**建议**：改字段名 + 分类解析 SAN，并补一条 smoke 用例（起一个 `CN=wrong.test` 的 TLS 监听，
断言探测结果是"证书域名不匹配"）。这条用例能同时守住 P1-2 和 P1-3。

---

### P1-3 "证书异常"这个状态永远显示不出来，被降级成"面板不可达"

**位置**：`server.js:1812`、`public/js/core.js:93/125`、`public/js/main.js:805`

```js
// server.js:1812 —— TLS 抽检失败直接把整体 ok 打成 false
if (out.tls && !out.tls.ok) out.ok = false;
```

前端是按**三态**设计的：

| 期望状态 | 代码位置 | 触发条件 |
| --- | --- | --- |
| 面板可达 | `probeBadge` 的 `probe.ok` 分支 | `ok=true` |
| **证书异常** | `probeBadge` 内层 `probe.ok && !probe.tls.ok` | 需要 `ok=true && tls.ok=false` |
| 面板不可达 | `probeBadge` 的 `else` | `ok=false` |

而服务端保证了 `ok=true ⇒ tls.ok=true`，所以**中间那一档永远进不去**：
`core.js:125` 的"但 TLS 抽检发现问题"、`main.js:805` 的"可达，但证书异常"全是死分支。

实际表现：节点证书过期时，徽标显示**「面板不可达」**，点开的详情也说"面板连不上这个节点"，
只有 title 提示里才带着证书过期的原因。这恰好把用户引向错误方向 —— 去查安全组、查端口，
而真正的问题是证书。

**建议**：`ok` 只表示"TCP 可达"，证书问题单独放在 `tls.ok`，前端三态即自然成立；
或者服务端加一个显式 `state: 'ok' | 'tls-error' | 'unreachable'` 字段，前后端都以它为准。
（这也是让 README 那句"`同步=已同步` 且 `探测=不可达` ≈ 安全组"成立的前提 ——
现在证书问题会误触发这个判断。）

---

### P1-4 `PANEL_TLS_CERT/KEY` 配错 → 面板进程静默退出、从未监听，退出码 0

**位置**：`server.js:5263`（`main()` 里直接调 `syncHttpsServer()`）、`server.js:5186`（`https.createServer` 无 try/catch）

`https.createServer({key, cert})` 在 PEM 非法 / 公私钥不匹配时**同步抛错**。实测（`PANEL_TLS_CERT` 指向一段坏 PEM）：

```
INFO   store  已初始化空数据库 ...
WARN   http  出厂默认密码未修改：业务接口已全部拦截
ERROR  http  未捕获异常（进程继续运行，建议尽快排查）
       err="Error: error:0680007B:asn1 encoding routines::header too long"
进程退出，退出码 0，HTTP 端口从未监听
```

三层问题叠在一起：

1. `syncHttpsServer()` 在 `main()` 里、`server.listen()` **之前**抛错 → 后面的 `listen` 根本没执行；
2. 全局 `uncaughtException` 兜住了异常，但**日志写的是"进程继续运行"** —— 实际事件循环空了，进程随即以 0 退出；
3. 退出码 0 让多数 supervisor 判定为"正常结束"（`systemd Restart=on-failure` 不会拉起，
   容器编排也容易误判）。管理员看到的现象是"面板打不开了，但服务显示 running"。

对比一下：设置页那条路径（引用证书实体）是安全的 —— `parseUploaded` 会校验 `keyMatches`，
且 `updateSettings` 的异常会被路由层 catch 成 500。**只有环境变量这条路径没有任何防护**，
而它恰恰是容器 / systemd 场景下的主路径。

**建议**：
- `applyHttpsCreds` 整体包 `try/catch`，失败时**回退纯 HTTP** 并打一条 `error` 级日志说明原因与恢复方式；
- `syncHttpsServer()` 的调用点（`main()`、`updateSettings`、定时器）各自兜底，任何一条都不能阻断 `server.listen`；
- 把"进程继续运行"这句改成按实际结果说话（兜底 handler 里区分"已恢复"与"即将退出"）。

---

### P1-5 HTTPS 端口被占用时仍强制跳转 → 面板 UI 被跳到一个死端口

**位置**：`server.js:5186`（`httpsServer` 创建即赋值）、`server.js:5062`（跳转判据 `if (httpsServer && ...)`）、
`server.js:4145/4193`（`httpsActive: !!httpsServer`）

`httpsServer.listen()` 是异步的，`error` 事件里只打日志、**不把 `httpsServer` 置空**。于是端口冲突
（8443 被别的服务占了、容器端口映射漏了、`PANEL_TLS_PORT` 与 `PORT` 写成同一个值）时：

```
$ curl -i -H "Accept: text/html" http://127.0.0.1:18084/
HTTP/1.1 301 Moved Permanently
Location: https://127.0.0.1:18445/      ← 这个端口上没有 HTTPS 服务
$ curl -k https://127.0.0.1:18445/api/health
HTTPS 端口不可用
```

浏览器从此**打不开面板**，而设置页会显示「HTTPS 已启用并生效」「监听中」（`httpsActive` 取的是
`!!httpsServer`，与是否真的 listen 成功无关）。恢复只能改环境变量。

**建议**：引入独立的 `httpsReady` 状态，只在 `listen` 回调里置 true、在 `error` 事件里置 false；
**跳转判据、`httpsActive`、启动横幅三处都读它**。端口冲突时应当降级为"不跳转 + 设置页红字提示"，
而不是把唯一入口跳死。

---

## 三、P2 中等问题

| # | 问题 | 位置 | 影响与建议 |
| --- | --- | --- | --- |
| P2-1 | 删除"正在给面板供 HTTPS"的证书没有拦截 | `server.js:2167` `deleteCert` | 只拦了节点引用（`certMode='ref'`），没拦 `settings.httpsCertId`。删掉后 5 分钟热加载定时器把监听关掉，正在用 HTTPS 的管理员当场失联。建议与节点同款 409 拦截。 |
| P2-2 | TOTP 无重放防护 | `lib/totp.js:70` `verify` | ±1 窗口（90 秒）内同一枚动态码可重复使用，没有记录 `lastUsedStep`。肩窥/中间人拿到一次码即可二次登录。建议记录已用时间步并拒绝回退。 |
| P2-3 | 开启 TOTP 不需要二次验证密码 | `server.js` `totpEnable` | 会话被劫持者可绑定**自己的**认证器，把真管理员锁在门外（典型 2FA 接管向量）。关闭要动态码或密码，开启却什么都不要，不对称。建议开启时校验当前密码。 |
| P2-4 | `admin.totp_secret` 明文落库 | `lib/store.js` | 库泄露 = 二开完全失效（密码是 scrypt 哈希，TOTP 密钥必须可还原）。至少要在 README 的安全边界里写明；有条件时用环境变量密钥做 AES-GCM 加密。 |
| P2-5 | 三个内存 Map 无过期清理 | `server.js` `totpPending` / `resetPending` / `resetSentAt` | `loginFails` 有 2000 条的清理逻辑，这三个没有；长期运行缓慢增长，且重启即丢（单实例可接受）。建议复用同一套清理。 |
| P2-6 | `subResetConfirm` 没校验 `user.enabled` | `server.js` `subResetConfirm` | 申请验证码之后账号被停用，仍能换发新 token。另外 `reset-request` 可被 token 持有者每 60 秒触发一次邮件（骚扰向量）。建议确认阶段补 `enabled` 检查。 |
| P2-7 | `report_state` 每行 `db.prepare()` | `lib/store.js:766` | 500 用户 × 每分钟 → 上千次语句编译。建议模块级惰性复用语句对象（`user_daily` 那套已是 upsert，可以照抄）。 |
| P2-8 | agent 侧 `totals` 永不裁剪 | `agent/agent.sh:1295` | 删掉的用户 / 节点 key 永远留在 `totals` 里，每轮都上报，面板每轮打一条"有未匹配用户"的 warn。建议面板在回包里下发"可回收的 key"，或按时间窗口裁剪。 |
| P2-9 | 401 时 `report()` 仍每轮打失败日志 | `agent/agent.sh:1342` | 与"日志收敛成一条"的目标冲突：宽限期 6 小时内每 60 秒仍有一条「✗ 流量上报失败」。建议 `NP_ORPHAN=1` 时静默跳过上报（累计值不丢，恢复后自动补）。 |

---

## 四、P3 低风险与仓库卫生

1. **演示站数据没重录**（按项目约定必须做）：`demo/api/settings.json` 缺 `httpsActive` / `httpsPort` /
   `admin.totpEnabled`，节点数据缺 `probe` 字段 → 演示站设置页会显示「**HTTPS 端口 undefined**」，
   点「开启二步验证」会请求到未录制的接口。需要起 `PANEL_SEED_DEMO=1` 实例重跑 `demo/record.js`。
2. **未跟踪文件**：`.r.json`（43 KB 的 GitHub API 转储，与产品无关，不应提交，建议删掉或进 `.gitignore`）；
   `docs/feature-gap-analysis.md` 未跟踪，但 CHANGELOG 引用了它的 R1–R5/R10 —— 要么一起提交，要么改掉引用。
3. **开放重定向**：跳转的 `Location` 用 `req.headers.host` 拼接，Host 头可控。只影响浏览器导航、
   且面板本身已信任 Host（`baseUrl` 同源），风险低；建议与 `subBase` 或已知地址做一次比对。
4. **sing-box 输出的两个健壮性缺口**（`lib/sub.js:373/377`）：
   - Reality 节点若 `fp` 为空则不输出 `tls.utls`，而 sing-box 的 `reality` 要求 uTLS → 整份配置可能被拒。
     建议 Reality 分支强制 `fingerprint: fp || 'chrome'`。
   - tag 来自 `displayName`，两个同名节点 / 同名入口会产生重复 tag，sing-box 会拒绝整份配置。
     建议出站时做一次去重后缀。
   （默认值 `fp:'chrome'` 让第一个缺口概率很低，但老库 / 手改数据仍可能触发。）

---

## 五、设计上做得好的地方（建议保持）

- **兼容期是双向的，不是单向的**：`NP_REPORT_V2` 由面板下发、agent 见到才切格式，旧面板+新 agent、
  新面板+旧 agent 四种组合都成立，且面板两种格式都收。这比"版本号比对"稳得多。
- **401 与 000 的语义区分**，以及"认得 401 但**不自杀**"的决策非常正确：`systemd Restart=always`
  会把自杀的进程再拉起来，cron 模式下又摘不掉自己的 crontab，而面板从备份恢复 / 换域名会让 token
  短暂对不上 —— 误停会把一整片活节点打下来。降频 + 收敛日志 + 给卸载出路，是这里唯一正确的解法。
- **卸载逻辑只有一份实现**：`uninstall.sh` 只做转发、`agent.sh --uninstall` 才是真身，
  跟着自更新一起变新；面板那条 `curl | sh` 也优先转交。避免了"两套清理逻辑各自腐化"这个经典坑。
- **订阅与配置层的可见性规则收敛到 `planCovers`**：以前订阅侧写死 `entry.planIds.includes(user.planId)`
  精确匹配、配置侧走等级继承，两端不一致 → "订阅里没有、配置里却注入了这个用户"。
  现在 `entryVisible()` 统一走注入的函数，`buildLinks` / `toClash` / `toSingBox` 三个入口一次改齐。
  这类"同一规则两处实现"的收敛，比新增功能更有长期价值。
- **探测的分层降级判断是对的**：Reality 是伪装握手、校验必误报 → 跳过；Hysteria2 是 UDP、
  TCP 不通是正常 → 只验解析并说明原因。这类"知道什么时候不该检测"的判断，比检测本身更难写对。
- **零依赖约定守住了**：TOTP 用 `node:crypto` 手写 HMAC-SHA1，没有为了二开引入依赖。

---

## 六、结构性建议（不阻塞本版，但要开始还）

1. **`server.js` 已经 5300 行，本版又 +712 行**，四块互不相关的能力（TLS 监听 / TOTP / 连通性探测 /
   自助重置）全部塞进同一个文件。`lib/` 已经有 13 个模块，说明拆分路径是通的。
   建议下次改动前先做机械拆分：`lib/panelHttps.js`、`lib/probe.js`、`lib/adminAuth.js`、
   `lib/subReset.js` —— 只搬函数不改逻辑，风险极低，收益是后续每次改动都不用在 5000 行里找位置。
2. **"内存态 + 单实例"是一个隐含假设**，本版又多了三处（`totpPending` / `resetPending` / `resetSentAt`）。
   目前架构确实是单实例（SQLite + 单实例锁），但建议在 README 里显式写明
   "面板不支持多副本"，否则将来上 k8s 多副本会踩"登录态随机失效 / 验证码发到 A 副本、B 副本校验不过"。
3. **"水位线"这类跨进程状态，应该带上产生它的实例标识**。P1-1 是这一类问题的第一个，
   以后凡是"对端上报累计值"的地方（未来可能的节点流量、证书剩余天数等）都要带 `gen`。

---

## 七、发布前 checklist

必须（P1）：

- [ ] 探测 SAN 字段改 `subjectaltname`，并区分 `DNS:` / `IP Address:`（P1-2）
- [ ] 探测结果三态化，`ok` 只表示可达（P1-3）
- [ ] `applyHttpsCreds` 包 try/catch，失败回退 HTTP，且不阻断 `listen`（P1-4）
- [ ] `httpsReady` 独立于 `httpsServer`，跳转 / `httpsActive` / 横幅都以它为准（P1-5）
- [ ] v2 上报加 `gen`，水位按 `(scope, gen)` 记；`gen` 变化只建基线（P1-1）
- [ ] 补三条测试：TLS 域名不匹配 → 证书异常态；坏证书 → 面板仍能起；重装 agent（seq 归零）→ 流量继续入账

建议（P2，可与本版一起或紧随其后）：

- [ ] `deleteCert` 拦 `settings.httpsCertId`（P2-1）
- [ ] TOTP 记已用时间步 + 开启需密码（P2-2 / P2-3）
- [ ] 401 时静默跳过上报（P2-9）
- [ ] 重跑 `demo/record.js`，检查演示站设置页不再出现 `undefined`

发版动作（按项目约定）：

- [ ] 版本号已由 `package.json` 唯一决定（0.1.16），`agent/agent.sh` 的 `VERSION` 已同步 ✔
- [ ] CHANGELOG 的 `## [0.1.16]` 段落已覆盖全部改动 ✔（但需按 P1 结论修正"探测能发现挂错证书"这句，
      或修完代码再保留）
- [ ] 提交前处理 `.r.json` 与 `docs/feature-gap-analysis.md` 的去留
- [ ] **推送前先确认**（会触发 CI 与 ghcr 镜像 tag，误推不可撤销）

---

## 附录 A：关键复现命令

```bash
# P1-2：确认 Node 的 SAN 字段名
openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 30 \
  -subj "/CN=probe.test" -addext "subjectAltName=DNS:probe.test,DNS:alt.test"
node -e "const tls=require('tls'),fs=require('fs');
const s=tls.createServer({key:fs.readFileSync('k.pem'),cert:fs.readFileSync('c.pem')},x=>x.end());
s.listen(19443,'127.0.0.1',()=>{const c=tls.connect({host:'127.0.0.1',port:19443,servername:'probe.test',rejectUnauthorized:false},()=>{
  const p=c.getPeerCertificate();console.log('subjectaltname=',p.subjectaltname);console.log('subjectaltstring=',p.subjectaltstring);c.destroy();s.close();});});"
# → subjectaltname="DNS:probe.test, DNS:alt.test" / subjectaltstring=undefined

# P1-4：坏证书 → 面板不监听、退出码 0
printf -- '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' > bad.pem
PANEL_TLS_CERT=bad.pem PANEL_TLS_KEY=k.pem PORT=18083 node server.js
curl -m 2 http://127.0.0.1:18083/api/health   # → 连不上

# P1-5：TLS 端口被占 → 仍跳转到死端口
node -e "require('net').createServer(s=>s.end()).listen(18445,'0.0.0.0')" &
PANEL_TLS_CERT=c.pem PANEL_TLS_KEY=k.pem PANEL_TLS_PORT=18445 PORT=18084 node server.js
curl -i -H "Accept: text/html" http://127.0.0.1:18084/   # → 301 https://...:18445/
curl -k https://127.0.0.1:18445/api/health               # → 不可用

# P1-1：重装后 seq 归零 → 面板整批丢弃
#   面板 @seq 已到 N；删掉 /opt/nodepanel 重跑部署 → agent 从 seq=1 起
#   面板回 200 {"ok":true,"duplicate":true}，agent 打印「↑ 已上报累计流量」
#   此后 usedBytes 不再增长，日志与界面均无异常
```

## 附录 B：评审覆盖的改动面

| 文件 | 增量 | 评审关注点 |
| --- | --- | --- |
| `server.js` | +712 | HTTPS 监听与跳转、TOTP 接口、探测、v2 对账、自助重置、卸载入口 |
| `agent/agent.sh` | +444 | 401 分流、v2 上报、`--uninstall`、`collect_stats` 修复 |
| `lib/store.js` | +125 | `report_state` 表与水位 API、admin 新列、users.email、nodes.probe |
| `lib/sub.js` | +189 | sing-box 出站、`entryVisible` 收敛 |
| `public/*` | +400 | 探测徽标三态、TOTP 两段式登录、HTTPS 卡片、订阅页自助重置 |
| `test/*` | +668 | 覆盖面评估（见第二节结论） |
| `CHANGELOG.md` / `README.md` | +304 | 宣称能力与实现的一致性核对（P1-2 由此发现） |
