# 中转管理方案（relay management）

> 2026-11-14 · v4（0.1.46 增量：多目标故障切换 + 目标诊断）· 状态：已实施
>
> 需求：① 新增「中转服务器」管理，可往中转机上用主流工具（gost / iptables）添加端口转发实现节点中转；② 节点新增/编辑时中转入口可下拉选择中转管理中已有的规则；③ **中转机与落地机统一在「服务器」页管理（tab 分组），装 agent 后规则自动同步**；④ **一个入口支持多个目标地址，按顺序故障切换；规则列表可一键诊断目标连通性与延迟**。

## 1. 现状与差距（v3/v4 已关闭）

- v2 的中转机是独立台账 `relay_servers`，与落地机 `servers` 两套记录、两套 UI，同一个地址要维护两次
- v2 只支持手动脚本（生成 → 复制执行 → curl 回执），规则变更必须重新生成并执行
- v3 起：中转机 = `servers.type='relay'`，与落地机共用 token / 心跳 / 安装脚本框架；
  规则由 agent 每 60s 拉取并幂等收敛，手动三态脚本保留作为未装 agent 时的兜底
- v4 起：一条规则可配置最多 8 个目标（顺序即切换顺序），gost 进程内 fifo 切换、
  iptables 每轮收敛时探测重选；列表提供「诊断」按钮，TCP 握手测延迟与可用性

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

## 3. 数据模型（lib/store.js TABLE_SPECS，schema 13 → 14，只加法迁移）

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
}
```

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
| `POST /api/relays/:id/diag` | **目标诊断**（0.1.46）：从面板逐个 TCP 握手所有目标，返回 `{ ok, ms, error }` 与「按顺序第一个可达」的 `active` 下标；`source=panel` |
| `POST /api/relay/ack` | **免登录回执**：relayId + deployToken（恒时比较）→ status=applied/unknown + appliedAt。沿袭免登录 POST 1.5MB 限额与限流（http-util.js readBody 机制） |
| `GET /api/servers/:id/install`（relay 型） | relayOnly 安装脚本：只部署 agent，不安装 Xray / Hysteria2 |
| `GET /api/agent/bundle`（relay token） | relay 配置包：只含规则收敛脚本，不读 nodes / users / certs |

旧 `GET /api/relay/script` 保留（兼容既有工作流）。

## 5. 脚本生成（deploy-scripts.js，全部过 shellSafe / relayTarget / bash -n）

### 5.1 iptables（升级现有 buildRelayScript）

- install：sysctl ip_forward → 依赖检查（含 `-m comment` 可用性，缺失降级为无标签并提示）→ **目标探测**（按顺序 nc / /dev/tcp，取第一个可达）→ 幂等插入**带标签** `np-relay:<id>` 的 DNAT + MASQUERADE → 持久化（netfilter-persistent / iptables-save）→ 末尾 curl 回执（失败不影响规则生效）
- uninstall：按标签 `iptables -t nat -S PREROUTING | grep "np-relay:<id>"` 逐条 `-D`（不依赖行号）→ 无标签时按监听端口删 → 回执
- check：只读列出本机全部 `np-relay:*` 规则 + 本规则存活状态 → 回执
- 多目标：静态规则只能指向一个目标，安装时探测选优；已装 agent 的中转机每轮收敛重选，纯手动模式需重跑 install

### 5.2 gost（新增 buildGostScript，基于 gost v3 / go-gost）

- install：
  1. 架构检测（uname -m → amd64/arm64）+ `GOST_VER` 版本变量（默认锁定一个稳定版，**白名单 `^\d+\.\d+\.\d+$`**，防注入）
  2. `/usr/local/bin/gost` 不存在则从 GitHub release 下载解压（已存在则跳过，不覆盖用户自装版本）
  3. 写 `/etc/gost/relay-<id>.env`（LISTEN / TARGETS，多目标逗号分隔）
  4. 写 systemd unit `/etc/systemd/system/gost-relay-<id>.service`：`ExecStart=/usr/local/bin/gost -L "tcp://:${NP_LISTEN}/${NP_TARGETS}" ...`（按 proto 裁剪；多目标时监听地址后带 `?strategy=fifo&max_fails=1&fail_timeout=30s`）→ `daemon-reload` → `enable --now`（幂等：unit 覆盖写）
  5. `ss -lntu` 端口自检 → curl 回执
- uninstall：`disable --now` + 删 unit + 删 env + daemon-reload；`--purge` 才删二进制
- check：`systemctl is-active gost-relay-<id>` + 端口监听自检 → 回执
- 多目标：gost 进程内 fifo 策略 —— 首选第一个目标，连接失败按 `max_fails/fail_timeout` 剔除并切下一个

### 5.3 端口占用预检

install 脚本开头检测 listenPort 是否已被占用（`ss -lntu | grep`）：iptables 模式查 DNAT 重复；gost 模式查监听冲突，被非本面板进程占用 → 明确报错退出，避免静默不通。

### 5.4 relay 收敛包（agent 通道，0.1.44）

`buildRelaySyncScript({ rules })` 生成 POSIX sh 收敛脚本，由 relay bundle 每轮执行：

1. 枚举 `gost-relay-*.service` 与带 `np-relay:` 标签的 NAT 规则，**删除面板已不存在的**（删规则 / 改端口 / 换 tool 自动生效）
2. 期望规则逐条写入：gost 写 env + systemd unit（多目标直接写全量）并 `enable --now`；iptables **每轮按顺序探测目标**，先删本规则旧标签再写当前可达目标（切换粒度 = 轮询周期）
3. gost 二进制按需下载（版本走 `GOST_VER` 白名单；`GOST_DL_BASE` 可指镜像）
4. 端口自检交给 agent 的 `probe_ports`（`NP_LISTEN_PORTS` 由 bundle 写入），失败通过 receipt 暴露

与手动三态脚本共用同一套命名的好处：两条通道可以互相接手，不留第二套规则。

### 5.5 目标诊断（0.1.46）

`POST /api/relays/:id/diag` 从**面板所在机器**发起 TCP 握手（3s 超时，目标并发），返回每个目标的
`ok / ms / error`，以及按填写顺序第一个可达的下标。前端弹窗按行展示，明确标注探测来源是面板
（入口机到目标的链路可能不同），并给出「当前首选目标」。

## 6. 前端

- 「服务器」视图按 **tab 分组**：节点服务器 / 中转服务器（互斥展示，新增按钮跟着当前 tab）
  - 新建弹窗先选类型：节点服务器（跑 Xray / Hysteria2）或中转服务器（入口机）
  - 中转卡片显示「转发规则」数而不是节点 / 用户数；部署 / 卸载弹窗文案按类型分叉
- 「中转」视图只管规则：改为添加规则时若还没有中转机，提示并跳到服务器页的中转 tab
  - 规则表在机器名旁提示「入口机离线」；服务器 CRUD 入口已移除（统一在服务器页）
  - 目标地址改为**大文本框**（一行一个 `host:port`，最多 8 个），列表转发方向显示首个目标 + `+N`
  - 每行新增「诊断」按钮：弹窗展示每个目标的可达性、TCP 延迟与当前首选目标，可重新测试
- 部署到中转机后，规则由 agent 自动同步；每行仍保留三态脚本按钮（未装 agent / 排查用）

## 7. 安全考量

- 所有目标地址逐个过 `relayTarget` 白名单（server/deploy-scripts.js:43-52）+ `shellSafe` 转义（0.1.34 注入修复两道闸），条数上限 8
- 诊断接口是登录态 POST，只发起 TCP 连接（不执行远端命令），超时 3s
- `GOST_VER` 白名单校验；下载 URL 仅由面板生成
- `/api/relay/ack` 免登录：deployToken 恒时比较 + 1.5MB 限额 + IP 限流
- 生成脚本 root 自检 + 幂等 + 端口占用预检三件套

## 8. 测试

- `test/generators.js`：gost / iptables 三态脚本 + relayOnly 安装/卸载 + relay 收敛包 `bash -n` 真解析；
  标签、GOST_VER 白名单、shellSafe 转义、中转机不装 Xray/Hysteria 断言
- `test/relay.js`：schema 12→14 迁移（id 冲突重映射、relays.serverId 跟随、旧表删除、
  旧规则自动补 targets）、落地机 payload 字段集合不变、中转机 payload 带 targets
- `test/smoke.js`：servers(type=relay) CRUD、多目标规则创建与解析、目标诊断（可达/不可达/延迟/
  当前首选）、IPv6 目标拦截、同机端口冲突 400（跨工具）、ack 鉴权（错 token / 重放）、
  status 流转、节点入口联动（选 relay → host/port 覆盖；relay 删除 → entry 保留手填值）、
  中转机安装/卸载脚本分叉、兼容只读端点
- 回归：`npm test`（含 smoke 全量）与 `npm run test:ui`

## 9. 影响分析

| 维度 | 影响 |
|------|------|
| 数据 | schema 12→14：`servers` 增 `type`、`relays` 增 `targets`；旧 `relay_servers` 行迁入并 DROP 旧表；自动备份后迁移 |
| 兼容 | `node.entries` 仅增可选 `relayId`；旧规则单目标自动补 `targets`；`targetHost/targetPort` 保留为第一项镜像；`GET /api/relay-servers` 保留只读一个版本；写入端点已移除 |
| 落地机 agent | **零影响**：payload 字段集合与 hash 输入不变，不触发重下发（test/relay.js 锁死） |
| 中转机侧 | 装 agent 后新增 `gost-relay-<id>.service` / `np-relay:<id>` 的 60s 自动收敛；多目标切换：gost 进程内、iptables 每轮重选；未装 agent 仍可手动执行脚本 |
| 安全面 | 中转机获得设备级 token（可被下发 root shell），relay bundle 只由固定模板生成，不接受自由字段 |
| 风险点 | 极精简系统无 `comment` match → iptables 降级无标签（过期规则无法自动清理）；无 `nc` 时 iptables 目标探测退化为取第一个；gost 下载依赖 GitHub 连通性（`GOST_DL_BASE` 可指镜像）；同机双角色（既入口又落地）不支持，需后续 capabilities 模型 |

## 10. 分期

- **一期（0.1.43，已完成）**：中转台账 + API + gost/iptables 三态脚本 + 中转视图 + 节点下拉联动 + 测试
- **二期（0.1.44，已完成）**：中转机并入 servers 台账（type=relay）+ relay-only agent（规则 60s 自动收敛）+ 服务器页 tab 分组 + 手动脚本保留为兜底
- **三期（0.1.46，已完成）**：单入口多目标（最多 8 个，按顺序故障切换）+ 目标诊断（TCP 延迟 / 当前首选）
- **后续（评估）**：同一台机器同时承担入口与落地（需要 capabilities 多角色模型）；tool 扩展（realm / socat）；入口机侧诊断回执