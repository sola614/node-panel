# 中转管理方案（relay management）

> 2026-11-13 · v2（按澄清需求重写）· 状态：已实施（0.1.43）
>
> 需求：① 新增「中转服务器」管理，可往中转机上用主流工具（gost / iptables）添加端口转发实现节点中转；② 节点新增/编辑时中转入口可下拉选择中转管理中已有的规则。

## 1. 现状与差距

- 现有中转只有 `node.entries`（订阅发布端点，手填 host/port）+ `GET /api/relay/script` 一次性 iptables 脚本（server/servers.js:256-280 → deploy-scripts.js:924-1000）
- 没有「中转服务器」概念：入口机信息散落在各节点 entries 里，无法按机管理
- 只支持 iptables 一种工具；无卸载脚本、无状态回执、无端口冲突校验
- agent 只管落地机，入口机不在管控范围

## 2. 总体设计

纯面板侧改动（一期不要求入口机装 agent），沿用「生成脚本 → 手动执行 → curl 回执」模式：

```
中转管理（新视图）                      节点编辑（联动）
┌────────────────────────┐            ┌─────────────────────────┐
│ 中转服务器 A（1.2.3.4） │            │ 中转入口：[下拉选择规则 ▾] │
│  ├ 规则 R1 gost  :8443→N1:443       │  香港入口 → 日本节点       │
│  ├ 规则 R2 iptables:443→N2:443      │  （选中后 host/port 自动带出│
│  └ [添加规则] [脚本] [状态]          │    并记录 relayId）        │
└────────────────────────┘            └─────────────────────────┘
```

- **转发工具按规则选择**：`tool: gost | iptables`。gost 为用户态转发（systemd 托管进程，无需改内核转发，适配 NAT/受限环境）；iptables 为内核态 DNAT（零进程、性能最优）。字段预留扩展位（后续可加 realm / socat 等，生成器按 tool 分发）。
- **节点联动**：`node.entries` 元素新增可选 `relayId`。选中中转规则后 host/port 自动以规则为准；手填模式保留（兼容旧数据）。

## 3. 数据模型（lib/store.js TABLE_SPECS，schema 11 → 13，只加法迁移）

```js
// relayServers：中转服务器台账（一期纯信息，二期可直接挂 agent token）
{ id, name, host, note, createdAt }

// relays：端口转发规则
{
  id, serverId,          // → relayServers
  name,                  // 如「香港入口 → 日本节点」
  tool: 'gost',          // gost | iptables
  proto: 'both',         // tcp | udp | both
  listenPort: 443,       // 中转机监听端口
  targetHost: '',        // 落地地址（IPv4/域名）
  targetPort: 443,       // 落地端口（= 节点监听端口）
  nodeId: '',            // 可选：关联落地节点（仅台账展示用）
  status: 'planned',     // planned | applied | unknown
  deployToken: '',       // 回执鉴权，rotate 能力
  appliedAt: null, note: '',
}
```

- **冲突校验（保存规则时）**：同一 serverId 下 listenPort 重复 → 400（跨工具也查：iptables DNAT 与 gost 监听同端口会互相劫持）。同 listenPort 不同 server 合法。
- `node.entries`：元素增加可选 `relayId`；带 relayId 时保存节点自动以 relay 的 host/listenPort 覆盖 entry.host/port（防手改不一致）；relay 已删除则保留手填值并清 relayId。订阅发布链路（lib/sub.js endpointsOf）**零改动**。hopError 互斥校验不变（下拉选择后 entryHosts 依旧非空，天然保持互斥）。

## 4. API（沿路由表 + Bearer + 审计模式，server.js:97-211）

| 路由 | 说明 |
|------|------|
| `GET/POST/PUT/DELETE /api/relay-servers` | 中转服务器 CRUD；删除时若有规则 → 400 提示先清规则 |
| `GET/POST/PUT/DELETE /api/relays` | 规则 CRUD（校验见 §3）；关键字段变更后 status 重置 planned；DELETE 时若 status=applied 响应带 `needsUninstall: true` |
| `GET /api/relays/:id/script?mode=install\|uninstall\|check` | 按 tool 分发生成三态脚本，并 rotate deployToken |
| `POST /api/relay/ack` | **免登录回执**：relayId + deployToken（恒时比较）→ status=applied/unknown + appliedAt。沿袭免登录 POST 1.5MB 限额与限流（http-util.js readBody 机制） |

旧 `GET /api/relay/script` 保留（兼容既有工作流）。

## 5. 脚本生成（deploy-scripts.js，全部过 shellSafe / relayTarget / bash -n）

### 5.1 iptables（升级现有 buildRelayScript）

- install：sysctl ip_forward → 依赖检查（含 `-m comment` 可用性，缺失降级为无标签并提示）→ 幂等插入**带标签** `np-relay:<id>` 的 DNAT + MASQUERADE → 持久化（netfilter-persistent / iptables-save）→ 末尾 curl 回执（失败不影响规则生效）
- uninstall：按标签 `iptables -t nat -S PREROUTING | grep "np-relay:<id>"` 逐条 `-D`（不依赖行号）→ MASQUERADE 按目标地址删 → 回执
- check：只读列出本机全部 `np-relay:*` 规则 + 本规则存活状态 → 回执

### 5.2 gost（新增 buildGostScript，基于 gost v3 / go-gost）

- install：
  1. 架构检测（uname -m → amd64/arm64）+ `GOST_VER` 版本变量（默认锁定一个稳定版，**白名单 `^\d+\.\d+\.\d+$`**，防注入）
  2. `/usr/local/bin/gost` 不存在则从 GitHub release 下载解压（已存在则跳过，不覆盖用户自装版本）
  3. 写 `/etc/gost/relay-<id>.env`（LISTEN / TARGET，单规则单环境文件）
  4. 写 systemd unit `/etc/systemd/system/gost-relay-<id>.service`：`ExecStart=/usr/local/bin/gost -L "tcp://:${LISTEN}/${TARGET}" -L "udp://:${LISTEN}/${TARGET}"`（按 proto 裁剪；Restart=always）→ `daemon-reload` → `enable --now`（幂等：unit 覆盖写）
  5. `ss -lntu` 端口自检 → curl 回执
- uninstall：`disable --now` + 删 unit + 删 env + daemon-reload；`--purge` 才删二进制
- check：`systemctl is-active gost-relay-<id>` + 端口监听自检 → 回执

### 5.3 端口占用预检

install 脚本开头检测 listenPort 是否已被占用（`ss -lntu | grep`）：iptables 模式查 DNAT 重复；gost 模式查监听冲突，被非本面板进程占用 → 明确报错退出，避免静默不通。

## 6. 前端

- 新「中转」视图（public/index.html 菜单 + public/js/relays.js，沿视图拆分惯例）：
  - 顶部中转服务器切换/管理（CRUD 弹窗）
  - 规则表格：名称、tool 徽标、proto、`listen:port → target:port`、关联节点、状态徽标（planned/applied/unknown + appliedAt）
  - 新建/编辑弹窗：tool 下拉（gost/iptables，proto 选项联动）、serverId 下拉、nodeId 下拉（可选）
  - 每行三态脚本生成（install/uninstall/check，一键复制）
- 节点视图（public/js/nodes.js:787-834 入口编辑区）：入口行改为「下拉选择中转规则（显示 `名称 host:port [tool]`）+ 未选择时手填」；旧数据无 relayId 自动落手填模式

## 7. 安全考量

- host / targetHost 全部过 `relayTarget` 白名单（server/deploy-scripts.js:43-52）+ `shellSafe` 转义（0.1.34 注入修复两道闸）
- `GOST_VER` 白名单校验；下载 URL 仅由面板生成
- `/api/relay/ack` 免登录：deployToken 恒时比较 + 1.5MB 限额 + IP 限流
- 生成脚本 root 自检 + 幂等 + 端口占用预检三件套

## 8. 测试

- `test/generators.js`：gost / iptables 三态脚本 `bash -n` 真解析；标签、GOST_VER 白名单、shellSafe 转义断言
- `test/smoke.js`：relayServers / relays CRUD、同机端口冲突 400（跨工具）、ack 鉴权（错 token / 重放）、status 流转、节点入口联动（选 relay → host/port 覆盖；relay 删除 → entry 保留手填值）
- 回归：既有中转入口用例（smoke.js:1506-1622）必须全绿；agent 侧零改动

## 9. 影响分析

| 维度 | 影响 |
|------|------|
| 数据 | schema 11→13 新增 relayServers / relays 两表，自动备份后迁移，无存量数据改写 |
| 兼容 | `node.entries` 仅增可选 `relayId` 字段；无 relayId 的旧数据 = 手填模式，行为不变；订阅链路零改动 |
| 安全面 | 新增 1 个免登录接口（ack），token + 限额 + 限流收敛 |
| 入口机侧 | gost 模式新增 systemd 常驻进程（`gost-relay-<id>.service`，每规则一个）与 `/etc/gost/`、`/usr/local/bin/gost`；iptables 模式仅多一条 comment 标签 |
| 回归范围 | `npm run test:generators` + `npm test`（smoke 全量） |
| 风险点 | 极精简系统无 `comment` match → iptables 降级无标签（卸载精度略降）；gost 下载依赖 GitHub 连通性（版本变量可指向自托管 URL 的扩展位） |

## 10. 分期

- **一期（本方案）**：两新表 + API + gost/iptables 三态脚本 + 中转视图 + 节点下拉联动 + 测试
- **二期（评估）**：中转服务器 agent 化（relay-only bundle：只应用转发规则 + 回执/心跳，复用现有下发链路），实现 60s 自动同步；tool 扩展（realm / socat）