# 中转管理方案（relay management）

> 2026-11-14 · v6（0.1.47 增量：入口机视角诊断 + iptables 自动安装）· 状态：已实施
>
> 需求：① 新增「中转服务器」管理，可往中转机上用主流工具（gost / iptables）添加端口转发实现节点中转；② 节点新增/编辑时中转入口可下拉选择中转管理中已有的规则；③ **中转机与落地机统一在「服务器」页管理（tab 分组），装 agent 后规则自动同步**；④ **一个入口支持多个目标地址，按顺序故障切换；规则列表可一键诊断目标连通性与延迟**。

## 1. 现状与差距（v3/v4 已关闭）

- v2 的中转机是独立台账 `relay_servers`，与落地机 `servers` 两套记录、两套 UI，同一个地址要维护两次
- v2 只支持手动脚本（生成 → 复制执行 → curl 回执），规则变更必须重新生成并执行
- v3 起：中转机 = `servers.type='relay'`，与落地机共用 token / 心跳 / 安装脚本框架；
  规则由 agent 每 60s 拉取并幂等收敛，手动三态脚本保留作为未装 agent 时的兜底
- v4 起：一条规则可配置最多 8 个目标（顺序即切换顺序），gost / iptables 都在每轮收敛时
  按顺序探测选优（60 秒粒度）；列表提供「诊断」按钮，TCP 握手测延迟与可用性

## 2. 总体设计

机器统一在「服务器」页（tab 分组），规则在「中转」页；中转机装了 agent 就自动同步，
没装则沿用「生成脚本 → 手动执行 → curl 回执」：

```
服务器页（tab：节点服务器 / 中转服务器）        中转页（规则）
┌──────────────────────────────┐     ┌──────────────────────────┐
│ 中转服务器 A（198.51.100.10）│ ←── │ 规则 R1 gost  :8443→N1:443 │
│  [部署命令] [卸载命令] [在线] │     │ 规则 R2 iptables:443→N2:443│
│  （与落地机同一套 agent 通道）│     │ [添加规则] [三态脚本]      │
└──────────────────────────────┘     └──────────────────────────┘
```

- **下发分流**：落地机拿到的是 Xray / Hysteria2 / 证书配置包；中转机拿到的是
  relay-only 配置包（只有规则收敛脚本）。两者共用 `/api/agent/bundle` 与同一份
  `agent.sh`，靠 token 解析出的 `scope.type` 分流，中转机 bundle 额外带 `RELAY_ONLY=1`。
- **落地机零影响**：relay 字段不进入落地机 payload 与 hash 输入，升级后不会触发全量重下发。

- **转发工具按规则选择**：`tool: gost | iptables`。gost 为用户态转发（systemd 托管进程，无需改内核转发，适配 NAT/受限环境）；iptables 为内核态 DNAT（零进程、性能最优）。字段预留扩展位（后续可加 realm / socat 等，生成器按 tool 分发）。
- **节点联动**：`node.entries` 元素新增可选 `relayId`。选中中转规则后 host/port 自动以规则为准；手填模式保留（兼容旧数据）。

## 3. 数据模型（lib/store.js TABLE_SPECS，schema 14 → 15，只加法迁移）

```js
// servers：统一机器台账（0.1.44）
{
  id, type,             // 'node' = 落地机 | 'relay' = 中转机（创建后不可改）
  name, host, token, note, ipMode, reportedIp,
  createdAt, lastSeen, agentVersion, sync,
}

// relays：端口转发规则（serverId → servers.id，要求该 server 的 type='relay'）
{
  id, serverId,
  name,                  // 如「香港入口 → 日本节点」
  tool: 'gost',          // gost | iptables
  proto: 'both',         // tcp | udp | both
  listenPort: 443,       // 中转机监听端口
  targets: [],           // [{ host, port }]，顺序即故障切换顺序，最多 8 个（0.1.46）
  targetHost: '',        // targets[0] 的镜像：兼容旧脚本 / 旧前端 / 旧 API
  targetPort: 443,       // 同上

  nodeId: '',            // 可选：关联落地节点（仅台账展示用）
  status: 'planned',     // planned | applied | unknown
  deployToken: '',       // 手动脚本回执鉴权，rotate 能力
  appliedAt: null, note: '',
  // 入口流量（0.1.47）：agent 读 iptables 计数器上报原值，面板按差值累计
  trafficBytes: 0,       // 累计入站字节（客户端 → 入口机方向）
  trafficRaw: 0,         // 上次读到的计数器原值
  trafficAt: null,       // 最近一次采集时间（null = 从未采集，通常是没装 agent）
  lastUsedAt: null,      // 最近一次流量增长时间（判断「有没有人用」）
  // 入口机视角诊断（0.1.47）
  diagRequestedAt: null, // 面板点「从入口机检测」后写入；agent 下一轮带探针下来
  agentProbe: null,      // agent 回传的探测结果 JSON：{ at, targets:[{host,port,ok,ms,error}] }
}
```

- **迁移（入口流量）**：旧规则没有流量列，加载时补 0 / null；非数字一律归零，避免 NaN 污染累计

- **迁移（旧 `relay_servers` → `servers`）**：每条旧台账转成 `type='relay'` 的 servers 行，
  补设备级 `token`、`ipMode='manual'` 与心跳字段；id 与既有 servers 冲突时重新分配并同步
  `relays.serverId`；迁移后 `DROP TABLE relay_servers`（不允许两份台账并存）
- **迁移（单目标 → 多目标）**：旧规则没有 `targets`，加载时用 `targetHost:targetPort` 生成一项；
  新规则始终以 `targets` 为准，`targetHost/targetPort` 作为第一项镜像同步写回
- **中转机地址约束**：必须是 IPv4 / 域名（过 `relayTarget`），`ipMode` 强制 `manual` ——
  入口地址会进订阅，自动上报会让客户端连接地址漂移
- **冲突校验（保存规则时）**：同一 serverId 下 listenPort 重复 → 400（跨工具也查）
- `node.entries` 元素保留可选 `relayId`；带 relayId 时保存节点自动以 relay 的
  `listenPort` + 所属中转机 host 覆盖 entry.host/port

## 4. API（沿路由表 + Bearer + 审计模式，server.js:97-211）

| 路由 | 说明 |
|------|------|
| `GET/POST/PUT/DELETE /api/servers`（`type=relay`） | 中转机台账统一走服务器接口；删除时若有规则 → 400 提示先清规则；批量删除会跳过有规则的机器 |
| `GET /api/relay-servers` | **兼容只读端点**（一个版本）：列出 type=relay 的服务器，不回显 token；写入端点已移除 |
| `GET/POST/PUT/DELETE /api/relays` | 规则 CRUD（校验见 §3）；关键字段变更后 status 重置 planned；DELETE 时若 status=applied 响应带 `needsUninstall: true` |
| `GET /api/relays/:id/script?mode=install\|uninstall\|check` | 按 tool 分发生成三态脚本，并 rotate deployToken（手动通道） |
| `POST /api/relays/:id/diag` | 默认 `source=panel`：从面板逐个 TCP 握手所有目标，返回 `{ ok, ms, error }` 与「按顺序第一个可达」的 `active`；`source=agent`（0.1.47）改为**请求入口机探测**，返回 `{ pending, requestedAt }` |
| `GET /api/relays/:id/probe` | 读取入口机视角诊断结果：`{ diagRequestedAt, agentProbe }`，前端轮询用 |
| `POST /api/relay/ack` | **免登录回执**：relayId + deployToken（恒时比较）→ status=applied/unknown + appliedAt。沿袭免登录 POST 1.5MB 限额与限流（http-util.js readBody 机制） |
| `POST /api/agent/receipt`（relay token） | 除同步状态外，额外接受 `traffic: { ruleId: 计数器原值 }`（0.1.47，按差值累计）与 `probe: { ruleId: { at, targets } }`（入口机诊断结果） |
| `GET /api/servers/:id/install`（relay 型） | relayOnly 安装脚本：只部署 agent，不安装 Xray / Hysteria2 |
| `GET /api/agent/bundle`（relay token） | relay 配置包：只含规则收敛脚本，不读 nodes / users / certs |

旧 `GET /api/relay/script` 保留（兼容既有工作流）。

## 5. 脚本生成（deploy-scripts.js，全部过 shellSafe / relayTarget / bash -n）

### 5.1 iptables（升级现有 buildRelayScript）

- install：sysctl ip_forward → **依赖检查 / 自动安装**（缺 iptables 时按 apk / apt / dnf / yum / pacman / zypper 自动装；`-m comment` 缺失降级为无标签并提示）→ **目标探测**（按顺序 nc / /dev/tcp，取第一个可达）→ 幂等插入**带标签** `np-relay:<id>` 的 DNAT + MASQUERADE → 持久化（netfilter-persistent / OpenRC `iptables save` / iptables-save）→ 末尾 curl 回执（失败不影响规则生效）
- uninstall：按标签 `iptables -t nat -S PREROUTING | grep "np-relay:<id>"` 逐条 `-D`（不依赖行号）→ 无标签时按监听端口删 → 回执
- check：只读列出本机全部 `np-relay:*` 规则 + 本规则存活状态 → 回执
- 多目标：静态规则只能指向一个目标，安装时探测选优；已装 agent 的中转机每轮收敛重选，纯手动模式需重跑 install

### 5.2 gost（新增 buildGostScript，基于 gost v3 / go-gost）

- install：
  1. 架构检测（uname -m → amd64/arm64）+ `GOST_VER` 版本变量（默认锁定一个稳定版，**白名单 `^\d+\.\d+\.\d+$`**，防注入）
  2. `/usr/local/bin/gost` 不存在则从 GitHub release 下载解压（已存在则跳过，不覆盖用户自装版本）
  3. 写 `/etc/gost/relay-<id>.env`（LISTEN / TARGET，**单个可达目标**）
  4. 写 systemd unit `/etc/systemd/system/gost-relay-<id>.service`：`ExecStart=/usr/local/bin/gost -L "tcp://:${NP_LISTEN}/${NP_TARGET}" ...`（按 proto 裁剪）→ `daemon-reload` → `enable --now`（幂等：unit 覆盖写）
  5. `ss -lntu` 端口自检 → curl 回执
- uninstall：`disable --now` + 删 unit + 删 env + daemon-reload；`--purge` 才删二进制
- check：`systemctl is-active gost-relay-<id>` + 端口监听自检 → 回执
- 多目标：不用 gost 的 `strategy` / `max_fails` 参数（不同版本兼容性不一致，unit 可能直接起不来），
  改为脚本按顺序探测、只下发一个可达目标；切换粒度 = 收敛周期（60s），与 iptables 行为一致
- 默认版本 **3.3.3**（与 GitHub Release 资产名一致；3.5.1 不存在会 404），下载前打印最终 URL，
  404 与「连不上」能分开判断
- 服务管理：优先 systemd；**Alpine / OpenRC 写 `/etc/init.d/gost-relay-<id>`**（`command_background` + pidfile），
  不再硬写 `/etc/systemd/system`（Alpine 上该目录不存在，会直接报 nonexistent directory）
- GitHub 反代：面板设置项 `githubProxy`。中转机下载时先查 `cdn-cgi/trace` 的 `loc`，
  `CN` 或判断不出来 → URL 前缀加上反代（`https://ghproxy.com/https://github.com/...`）；
  `GOST_DL_BASE` 自定义镜像不叠加反代
- 小磁盘兼容：下载改为**流式解压**（`curl | tar -xzO gost`），峰值只占最终二进制一份；
  可用空间 < 60MB 时直接报错并建议改用 iptables。旧逻辑「压缩包 + 解压 + install 复制」
  峰值是 3 份，90MB 根分区必爆（`No space left on device`）

### 5.3 端口占用预检

install 脚本开头检测 listenPort 是否已被占用（`ss -lntu | grep`）：iptables 模式查 DNAT 重复；gost 模式查监听冲突，被非本面板进程占用 → 明确报错退出，避免静默不通。

### 5.4 relay 收敛包（agent 通道，0.1.44）

`buildRelaySyncScript({ rules })` 生成 POSIX sh 收敛脚本，由 relay bundle 每轮执行：

1. 枚举 `gost-relay-*.service` 与带 `np-relay:` / `np-relay-count:` 标签的 NAT 规则，**删除面板已不存在的**（删规则 / 改端口 / 换 tool 自动生效）
2. 期望规则逐条写入：gost 按顺序探测目标、写单目标 env + 服务（systemd unit 或 OpenRC init）并启动；iptables 每轮按顺序探测目标，**期望规则已在位时跳过重建**（否则计数器每秒归零），目标变化才删旧标签重写
3. 清理段同时识别 `gost-relay-*.service` 与 `/etc/init.d/gost-relay-*`，卸载时把 OpenRC 服务、pidfile、计数链一起清掉
4. gost 没有 DNAT 规则可挂计数器，收敛时在固定计数链 `NP_RELAY_COUNT` 里插一条 `RETURN` 规则（标签 `np-relay-count:<id>`），只建一次、不重建
5. gost 二进制按需下载（版本走 `GOST_VER` 白名单；`GOST_DL_BASE` 可指镜像）
6. 端口自检交给 agent 的 `probe_ports`（`NP_LISTEN_PORTS` 由 bundle 写入，只统计 gost 规则），失败通过 receipt 暴露
7. **入口机诊断**（0.1.47）：bundle 里只有面板点了「从入口机检测」的规则才生成探测段。
   在入口机上用 `curl --connect-timeout 3 -w '%{time_connect}'` 逐个目标测 TCP 握手，
   结果写 `/opt/nodepanel/relay-probe.json`，agent 随下一次回执带回后删除文件；
   请求时间参与 payload hash，所以 agent 一定会为此拉新包

与手动三态脚本共用同一套命名的好处：两条通道可以互相接手，不留第二套规则。

### 5.5 目标诊断（0.1.46）

`POST /api/relays/:id/diag` 从**面板所在机器**发起 TCP 握手（3s 超时，目标并发），返回每个目标的
`ok / ms / error`，以及按填写顺序第一个可达的下标。前端弹窗按行展示，明确标注探测来源是面板
（入口机到目标的链路可能不同），并给出「当前首选目标」。

## 6. 前端

- 「服务器」视图按 **tab 分组**：节点服务器 / 中转服务器（互斥展示，新增按钮跟着当前 tab）
  - 新建弹窗先选类型：节点服务器（跑 Xray / Hysteria2）或中转服务器（入口机）
  - 中转卡片显示「转发规则」数而不是节点 / 用户数；部署 / 卸载弹窗文案按类型分叉
- 「设置 → 站点信息」新增 **GitHub 反代加速**：只影响中转机下载 gost；留空直连。
  中转机检测到中国大陆 IP 时自动拼接，格式 `反代前缀 + GitHub 地址`
- 「中转」视图只管规则：改为添加规则时若还没有中转机，提示并跳到服务器页的中转 tab
  - 规则表在机器名旁提示「入口机离线」；服务器 CRUD 入口已移除（统一在服务器页）
  - 规则状态区分三种：`等待同步`（agent 在线、等下一轮）、`同步失败`（回执 ok=false，
    悬停看原因，如 iptables 没装 / gost 起不来）、`已部署`（hash 匹配）
  - 目标地址改为**大文本框**（一行一个 `host:port`，最多 8 个），列表转发方向显示首个目标 + `+N`
  - 每行新增「诊断」按钮：弹窗分两块 —— **面板视角（即时）** 与 **入口机视角（agent 上报）**。
  入口机视角点「从入口机检测」后写入请求，弹窗轮询结果（最多 90 秒；agent 下一轮同步回传）
  - 规则表新增「使用」列（0.1.47）：累计入口字节 + 最近使用时间；从未采集时显式提示「需要 agent」
- 部署到中转机后，规则由 agent 自动同步；每行仍保留三态脚本按钮（未装 agent / 排查用）

## 7. 安全考量

- 所有目标地址逐个过 `relayTarget` 白名单（server/deploy-scripts.js:43-52）+ `shellSafe` 转义（0.1.34 注入修复两道闸），条数上限 8
- 诊断接口是登录态 POST，只发起 TCP 连接（不执行远端命令），超时 3s
- `GOST_VER` 白名单校验；下载 URL 仅由面板生成
- `/api/relay/ack` 免登录：deployToken 恒时比较 + 1.5MB 限额 + IP 限流
- 生成脚本 root 自检 + 幂等 + 端口占用预检三件套
- 入口流量只用于展示（判断入口是否有人使用），**不参与用户额度计费**：计费仍以落地机 Xray 的真实转发为准，避免同一份流量被重复计入

## 8. 测试

- `test/generators.js`：gost / iptables 三态脚本 + relayOnly 安装/卸载 + relay 收敛包 `bash -n` 真解析；
  标签、GOST_VER 白名单、shellSafe 转义、中转机不装 Xray/Hysteria 断言
- `test/relay.js`：schema 12→15 迁移（id 冲突重映射、relays.serverId 跟随、旧表删除、
  旧规则自动补 targets / 流量默认值）、落地机 payload 字段集合不变、中转机 payload 带 targets
- `test/smoke.js`：servers(type=relay) CRUD、多目标规则创建与解析、目标诊断（可达/不可达/延迟/
  当前首选）、IPv6 目标拦截、入口流量回执（累计 / 差值 / 计数器归零）、同机端口冲突 400（跨工具）、
  ack 鉴权（错 token / 重放）、status 流转、节点入口联动（选 relay → host/port 覆盖；
  relay 删除 → entry 保留手填值）、中转机安装/卸载脚本分叉、兼容只读端点
- 回归：`npm test`（含 smoke 全量）与 `npm run test:ui`

## 9. 影响分析

| 维度 | 影响 |
|------|------|
| 数据 | schema 12→15：`servers` 增 `type`、`relays` 增 `targets` 与流量字段；旧 `relay_servers` 行迁入并 DROP 旧表；自动备份后迁移 |
| 兼容 | `node.entries` 仅增可选 `relayId`；旧规则单目标自动补 `targets`；`targetHost/targetPort` 保留为第一项镜像；`GET /api/relay-servers` 保留只读一个版本；写入端点已移除 |
| 落地机 agent | **零影响**：payload 字段集合与 hash 输入不变，不触发重下发（test/relay.js 锁死） |
| 中转机侧 | 装 agent 后新增 `gost-relay-<id>.service` / `np-relay:<id>` 的 60s 自动收敛；多目标切换：gost / iptables 都每轮探测重选（gost 单目标下发；iptables 未变化不重建、保留计数器）；入口流量随回执上报 |
| 安全面 | 中转机获得设备级 token（可被下发 root shell），relay bundle 只由固定模板生成，不接受自由字段；流量数字仅作展示 |
| 风险点 | 入口流量只统计单向（客户端 → 入口机），且依赖 `iptables` + `comment`；计数器在目标切换 / 规则重建时归零，面板按「原值下降视为重置」处理；无 `nc` 时目标探测退化为取第一个；gost 下载依赖 GitHub 连通性（反代 / `GOST_DL_BASE` 兜底）；同机双角色（既入口又落地）不支持 |
| bundle 版本 | relay payload hash 额外包含 `RELAY_BUNDLE_REV`：生成逻辑有行为修复时 +1，agent 下一轮就会拉新包，不必为此单独发版本号 |

## 10. 分期

- **一期（0.1.43，已完成）**：中转台账 + API + gost/iptables 三态脚本 + 中转视图 + 节点下拉联动 + 测试
- **二期（0.1.44，已完成）**：中转机并入 servers 台账（type=relay）+ relay-only agent（规则 60s 自动收敛）+ 服务器页 tab 分组 + 手动脚本保留为兜底
- **三期（0.1.46，已完成）**：单入口多目标（最多 8 个，按顺序故障切换）+ 目标诊断（TCP 延迟 / 当前首选）
- **四期（0.1.47，已完成）**：入口流量统计（判断入口是否有人使用）+ 前端错误提示与静态资源版本化修正
- **后续（评估）**：同一台机器同时承担入口与落地（需要 capabilities 多角色模型）；tool 扩展（realm / socat）；入口机侧诊断回执

## 11. 0.1.47 附带修复的两个前端问题

1. **429 被误报成「页面状态可能已过期」**：`showError` 以前把 `Failed to fetch` 这类网络错误
   混进了技术错误分支。现在网络失败单独提示「无法连接面板（可能正在重启或网络中断）」；
   `api()` 对 429 优先使用后端 `data.error`，拿不到时提示「可能是反向代理限流 / 面板重启」，
   并保留 `err.status` / `retry-after`。
   > 排查提示：面板自身没有给 `/api/relays` 加限流。若 DevTools 里看到 429 且响应体是 HTML，
   > 检查前面的 nginx `limit_req` / frp 或云厂商 WAF，而不是面板。
2. **升级后新旧前端混跑**：静态 JS/CSS 以前缓存 5 分钟且 URL 不带版本，升级后旧页面继续提交
   旧字段会表现为「页面状态过期」。现在 HTML 里的 `?v=__V__` 由服务端替换成 `APP_VERSION`，
   升级后资源 URL 变化，浏览器不会再拿上一版前端配这一版后端。3. **gost 下载 404**：默认版本写成 3.5.1，但 GitHub Release 并不存在该 tag/资产，实际最新稳定版为 3.3.3。
   现在版本常量带注释，下载前打印最终 URL，404 与网络不通能一眼区分。
4. **Alpine 上 gost 服务建不起来**：OpenRC 机器没有 `/etc/systemd/system`，以前会报
   `nonexistent directory`。现在自动识别 systemd / OpenRC，OpenRC 写 `/etc/init.d/gost-relay-<id>`。
5. **GitHub 下载被墙**：设置页新增「GitHub 反代加速」，中转机按 IP 归属决定是否拼接前缀
   （`CN` 或判断失败 → 使用反代），自定义镜像地址不叠加。