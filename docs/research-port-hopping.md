# 调研：Hysteria2 端口跳跃（Port Hopping）的实现方案

> 调研时间 2026-11-07。结论基于官方文档、hysteria 源码（`app/internal/firewall/firewall_linux.go`）
> 与各客户端实现；标注「待实测」的部分需要上线前在真机验证。

## 结论（先看这段）

1. **服务端不存在「真的监听一整段 UDP 端口」这回事**。所有方案的实质都是：
   进程只 bind 一个端口 → 防火墙把范围内其余端口的入站流量**重定向**到这个端口。
   `ss -lunp` 永远只能看到一个端口，看不到「跳跃」。
2. 端口跳跃是**服务端转发 + 客户端轮换**两件事，缺一不可。只做服务端，客户端仍连单端口，
   等于白开一段防火墙；只改客户端，跳到未放行的端口就断流。
3. **本次按方案 B 实现**：agent 自管一张 `nodepanel_hyhop` 表，而不是用 hysteria 2.8.0 起的
   内置 `listen: :20000-30000`（方案 A）。理由不是功能，而是**生命周期**：内置方案的规则
   跟随进程清理，`kill -9` / OOM 后规则残留会让下一次启动直接失败（见第五节坑 4），
   而面板本来就有「每轮 reconcile」的机制，规则归 agent 管天然自愈。
4. 方案 A 留给「手工部署 / 单节点」场景，代码里没有版本假设。
5. 客户端那一侧（每 30 秒换端口）是订阅里的一行参数，服务端规则**装一次就静态生效**，
   与客户端跳多少次无关。

## 一、它到底解决什么问题，边界在哪

运营商对**单个 UDP 端口**上的持续大流量做 QoS / 限速 / 阻断时，换端口能恢复。
端口跳跃让客户端在一个区间里周期性换目标端口，单端口被限时自动漂到别的端口。

官方文档明确写了两条边界，别对外承诺过头：

- **限制针对「UDP 整体」而不是某个端口时，端口跳跃无效** —— 这时要用 `mimic`（伪装成 TCP）。
- **`mimic` 与端口跳跃不能同时使用**（官方原文）。obfs（salamander）可以与跳跃共存。
- 客户端只换了**目标端口**，QUIC 连接靠 connection migration 迁移，理论上不丢数据；
  但**跳到一个不可达的端口就是断一个 hop 周期**（默认 30 秒），体验上非常明显。

推论：**范围内每个端口都必须真实放行**（系统防火墙 + 云安全组），否则跳跃是负优化。

## 二、服务端：三条实现路径

| | 方案 A：hysteria 内置范围 | 方案 B：agent 自管 nftables（推荐） | 方案 C：手工 iptables |
| --- | --- | --- | --- |
| 做法 | `listen: :20000-30000` | 配置里 `listen` 仍是单端口，agent 单独装规则 | `iptables -t nat -A PREROUTING -p udp --dport 20000:30000 -j REDIRECT --to-ports 443` |
| 谁建规则 | hysteria 进程自己 | agent（面板下发） | 人 / 脚本 |
| 最低版本 | **2.8.0**（Linux only） | 无要求 | 无要求 |
| 依赖 | `nft` 或 `iptables`/`ip6tables`，root 或 `CAP_NET_ADMIN` | 同左 | `iptables`，需 `nat` 表 |
| 规则命名 | 每个实例一张 `hysteria_<8位hash>` 表 | 面板固定一张表，每节点一条 rule | 直接挂在 `PREROUTING` 上 |
| 多实例同机 | 各建各的表（hash 含监听地址 + 端口并集），**范围重叠即启动失败** | 一张表内多条 rule，按 dport 区间区分 | 容易互相干扰，手工维护 |
| 清理 | 进程正常退出时 `delete table` | agent reconcile，幂等 | 手工 `-D`，重启易丢 |
| 主要风险 | 残留规则导致下次启动失败；版本差异 | 需要自己处理 nft/iptables 探测与降级 | 持久化、顺序、误伤出站 |

### 方案 A 的实现细节（源码确认）

`app/cmd/server.go` 的 `resolveServerListenAddr()` 解析出端口并集后，**只 bind 并集的第一个端口**，
然后调 `firewall.SetupUDPPortRedirect()`：

- 表名 `hysteria_<sha256前8位>`，hash 输入是 `"nft|"+family+"|"+listenAddr+"|"+端口并集`；
  iptables 则是链 `HYSTERIA-PR-<hash>`。
- 同时建 **prerouting 和 output 两条链**（output 是为了本机自己发起的连接也能命中，
  比如同机 DNS / 本机客户端）。
- wildcard 绑定时（`:20000-30000`）匹配条件带 `fib daddr type local` / `-m addrtype --dst-type LOCAL`，
  避免把发往外部服务器的出站 UDP 也重定向 —— **这个 bug 在 2.12.3 才修**（见坑 1）。
- 清理靠 `io.Closer`，只在**正常退出路径**执行。

### 方案 B 的规则长这样（推荐形态）

一张表、每节点一条 rule、可以看 counter：

```nft
table inet nodepanel_hyhop {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "eth0" udp dport 40000-40499 counter redirect to :443
    iifname "eth0" udp dport 40500-40999 counter redirect to :8443
  }
}
```

注意三点：

- **`priority dstnat`（-100）**，与 docker / ufw 的规则同优先级，按添加顺序匹配；`iifname` 显式限制入口网卡，
  避免多网卡机器上把内网流量也劫持进来。
- 不要用 `dnat to` 到本机地址（多一次路由），`redirect` 到本机端口更省。
- 规则要能**幂等重建**：`nft delete table` 吞掉错误 → `nft -f -` 整表重建，比逐条 `add/delete` 好维护。

## 三、客户端：五家语法完全不同（这是最容易踩的地方）

服务端配好只是前提，**客户端不认范围的话，它会静默地用第一个端口连**，不报错。

| 客户端 | 写法 | 备注 |
| --- | --- | --- |
| hysteria 官方 CLI / Happ / NekoBox | `server: host:20000-30000`<br>`transport.udp.hopInterval: 30s` | 官方 URI 就支持把多端口写在 port 位：`hysteria2://user:pass@host:443,5000-6000/` |
| mihomo / Clash Meta / Verge / FlClash | `ports: "40000-40499"`<br>`hop-interval: 30` | `port` 与 `ports` 互斥；interval 最小 5 |
| sing-box（1.11+） | `"server_ports": ["40000:40499"]`<br>`"hop_interval": "30s"` | **分隔符是冒号不是连字符**；1.14+ 才有 `hop_interval_max` |
| v2rayN | URI 查询串 `?mport=40000-40499` | 非标扩展，官方 URI 规范里没有；走官方多端口格式 v2rayN 不认 |
| Surge | `port-hopping=40000-40499, port-hopping-interval=30` | |
| v2rayNG / 部分 iOS 客户端 | 社区反馈不支持范围 | 待实测；不支持时只能用单端口 |

**随机间隔只在部分客户端可用**：官方客户端 2.8.0+ 支持 `minHopInterval`/`maxHopInterval`，
sing-box 1.14+ 支持 `hop_interval_max`，mihomo 目前只有固定 `hop-interval`。

## 四、本次实现（方案 B）

### 4.1 数据模型

```js
node.hy2 = {
  // ...
  hop: '40000-40499',   // 空字符串 = 关闭；多段用逗号：'40000-40499,41000-41099'
  hopInterval: 30,      // 秒，只影响订阅（服务端不参与跳跃）
}
```

- 解析与校验统一在 `lib/hysteria.js`：`parsePortRange` / `hopOf` / `formatPortRange`。
  面板校验、订阅方言、agent 下发三处共用一套，避免各写一遍正则。
- 约束：1024 ≤ 端口 ≤ 65534（**不含 65535**）、段内起点 ≤ 终点、段间不重叠、
  总端口数 ≤ 1000。规范化后按起点排序，所以 `41000,40000-40499` 会存成 `40000-40499,41000`。
- **节点自己的 `port` 不变**，仍是真实监听端口；跳跃范围是「额外入口」，不是替代。

### 4.2 下发与生效

配置生成（`lib/hysteria.js`）里 `listen` 保持 `:${port}`，**不把范围写进 listen**（那是方案 A）。
`buildAgentPayload` 给每个 hy2 节点带上 `hop`，`lib/agentBundle.js` 拼成：

```
NP_HY_HOP='node-a1b2c3:443:40000-40499 node-c3d4e5:8443:40500-40999'
             实例     监听端口 客户端轮换范围
```

`hop` 同时进了配置 hash（`payloadForHash`）—— 它不在 yaml 里，漏掉就会出现
「面板上改了范围、agent 那边规则一直没变」这种查不出来的不同步。

agent 侧由 `hop_apply` 落地，一张表、一条规则一个节点：

```nft
table inet nodepanel_hyhop {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    udp dport { 40000-40499 } counter redirect to :443      # 节点 A，port=443
    udp dport { 40500-40999 } counter redirect to :8443     # 节点 B，port=8443
    udp dport { 41000-41499 } counter redirect to :2053     # 节点 C，port=2053
  }
}
```

一台机器多个 hy2 节点就是这么并列的：各实例 bind 自己的端口，各占一段互不重叠的范围。
`40500-40999` 这段 **不能**包含 8443，否则本该直连 B 的流量会被改写到别处（保存时就拦）。

几个刻意的选择：

- **只挂 `prerouting`，不挂 `output`**。hysteria 内置方案两条链都挂，2.12.3 之前正是
  output 链误伤同机出站 UDP（Realms、dnsmasq 全中）。我们的场景（客户端在外网）不需要 output。
- **不写 `iifname`**。写死 `eth0` 在网卡改名 / 多网卡机器上会静默失效；范围是独占的，
  匹配面大一点没有副作用。
- **幂等**：目标内容写进 `$STATE_DIR/hyhop.spec`，内容相同**且** `nft list table` 能探到表
  才跳过。只比文件不够 —— nft 表不持久，重启后规则没了而 spec 还在，光比 spec 会让
  「重启后跳跃静默失效」。
- **整表替换**：`nft delete table`（忽略不存在）→ `nft -f` 一次性加载。失败时表是空的，
  客户端退化成单端口可用，比留一半旧规则更好判断。
- **全关时删表**：面板上所有节点都关掉跳跃后，残留的表会把端口继续劫持到已经不存在的实例。
- **iptables 回退**：本机没有 `nft` 时用自定义链 `NODEPANEL_HYHOP`（插到 PREROUTING 第 1 条，
  以免被 docker 塞的 ACCEPT 提前放行），逗号组合拆成多条 `--dport a:b`。
- **缺后端时自己装**（0.1.39）：Alpine 的 minirootfs、各种 slim 镜像两个都没有，
  而这是唯一「少一个包就整段失效」的功能 —— 订阅已经把范围发下去了，客户端跳到哪都不通，
  实例却活得好好的。按 `nftables` → `iptables` 顺序用系统包管理器装（`apk add --no-cache`
  / `apt-get install` / `dnf` …），装完先 `nft list tables` / `iptables -t nat -S` **探一次
  能不能真用**：容器里内核没有 `nf_tables`/`nf_nat` 时命令在、规则写不进去，把「命令存在」
  当成「装好了」只会让后面整段下发失败。失败写 `.hop-pkg-fail` 退避 30 分钟，
  `HOP_AUTO_INSTALL=0` 可彻底关掉。
- **`HOP_BACKEND` 环境变量**：`nft` / `iptables` / `none` 强制指定，测试用它走降级分支，
  免得在跑测试的机器上真去改防火墙。

### 4.3 回执口径

`NP_LISTEN_PORTS` 不用改（监听端口没变），新增回执字段 `hop: "4/4"`：

```
Hysteria2 实例     4 个在跑
端口跳跃规则       4/4 段已装
```

规则装不上时 `RC_OK=0` + `RC_ERR` 带上原因（本机没有 nft/iptables 且自动安装失败、
nft 报错原文），面板上直接是「同步失败」。**不能只 warning**：订阅已经按范围发下去了，规则没装就是整段不可达，
而实例本身跑得好好的、端口也在监听 —— 这是最难自己发现的一类故障。

### 4.4 冲突校验（保存节点时挡住）

一条范围会一次性占掉上千个端口，事后才发现冲突的代价很高。`server/nodes.js` 的 `hopError`
按顺序检查，命中就 400：

- 格式 / 边界：1024–65534、起点 ≤ 终点、段间不重叠、总数 ≤ 1000、不含 65535；
- 包含**本节点端口**：跳进来会被改回原端口，白占一个号；
- 包含**同机其它节点端口**：那个节点的客户端会被转发到错误的实例（server 模式按 `serverId`
  归并，独立节点独占一台机器）；
- 与**同机其它节点的范围重叠**：两条 redirect 抢同一批 dport，谁先匹配谁赢；
- 包含 **22 / 面板 8080 / HTTPS 8443 / 统计端口段 29000-29899**
  （后者撞上会让 trafficStats bind 失败，实例直接 FATAL）。

**32768-60999 的临时端口区只提示不拦**：`prerouting` 只看目的端口，同机出站连接的源端口
落在范围内不会被误改写（那是 hysteria 内置方案带 output 链才有的问题）。

### 4.5 订阅三格式（`lib/sub.js` 三处）

| 格式 | 写法 | 备注 |
| --- | --- | --- |
| base64 / URI | `?mport=40000-40499` | port 位保持单端口；逗号不编码成 `%2C`（个别客户端是土解析） |
| Clash / mihomo | `ports: 40000-40499` + `hop-interval: 20` | 同时保留 `port`：老内核不认 `ports` 时退回单端口 |
| sing-box | `server_ports: ["40000:40499"]` + `hop_interval: "20s"` | **冒号不是连字符**；保留 `server_port` 让 <1.11 的内核降级而不是报错 |

URI 里**不要**把范围写进 port 位：官方客户端认（`host:40000-40499`），但 mihomo 的 URI
解析按整数取端口，带连字符会解析失败或被截断；`mport` 是 v2rayN 的既有扩展，
不认它的客户端只会忽略未知查询参数。

**走中转入口的节点不下发范围**：客户端连的是入口机的一个端口，落地机的 redirect 规则
看不到这批流量 —— 带上范围只会让客户端跳到一个没人接的端口，比不开更糟。
判定在 `hopFor(node, entry)`，三处生成点共用。

这条不是「提示一下就放过」，而是**保存时就互斥**：`hopError()` 发现节点还有中转入口就直接
400，表单里填了范围会禁用「+ 添加入口」。理由是两个模型根本不相容 —— 跳跃的前提是
「客户端直连落地机的任意端口」，而中转的前提是「客户端只认识入口机的那个端口」。允许并存
只会得到一种结果：用户在界面上看见范围填着、以为生效了，订阅里却连 `mport` 都不带。
真想让走中转的用户也跳，需要入口机自己再装一套「范围 → 入口端口」，属于二期
（入口机常是多节点共用，得按入口端口分段），届时入口与直连的范围要各存一份。

### 4.6 界面与测试

- 节点表单（`public/js/nodes.js`）：「端口跳跃」范围 + 跳变间隔，含安全组 / 中转不生效的提示；
- 同步详情（`public/js/core.js`）：`端口跳跃规则 4/4 段已装`，不等时红字；
- `test/hop.js`（新增，纯函数、不需要面板）：范围解析、三种方言、`NP_HY_HOP` 下发；
- `test/smoke.js`：四类非法范围 400、三种订阅格式、bundle 带范围、关闭后退场；
- `test/agent.js`：`HOP_BACKEND=none` 时回执 `ok=false` 且不谎报计数。

## 五、坑清单

1. **版本断层**。内置方案 2.8.0 起；2.8.1 加 `HYSTERIA_FIREWALL_BACKEND` 并修 iptables 锁竞争；
   2.8.2 修老 nftables 兼容；2.9.3 修绑特定 IPv6 地址时重定向失败；
   **2.12.3 修「跳跃规则误重定向出站 UDP」，会破坏同机 Realms 连接和其它 UDP 服务**。
   agent 只在「二进制不存在」时安装，**不会升级老二进制** —— 老机器可能正跑着会误伤出站的版本。
   方案 B 自己写规则就不受这些影响，这是选它的第二个理由。
2. **云安全组必须放行整段**。本机 `iptables` 的 INPUT 反而只需放行真实监听端口
   （PREROUTING 已把 dport 改写掉了），但云厂商在更外层，必须按 UDP 端口范围放行。
   阿里云安全组每 200 条上限，用**连续范围**一条规则即可，别拆成上千条。
3. **范围内端口被别的服务占用** → 跳过去就断一个周期。范围要独占，不能与其它服务共用。
4. **残留规则**（方案 A 特有）。规则清理只在正常退出时执行；`kill -9`、OOM、断电后
   `hysteria_<hash>` 表还在，下次启动 `nft add table` 报 `File exists`，
   表现为「配置明明没错但实例起不来」（待实测，源码路径成立）。
   面板场景的兜底：agent 启动实例前先 `nft delete table inet hysteria_*` 清残留，
   或干脆走方案 B 不用内置。
5. **conntrack 压力**。每次跳跃是新的 `(src,sport,dport)` 五元组，旧条目按
   `nf_conntrack_udp_timeout`（默认 30s，established 120s）老化；30 秒一跳 ≈ 每用户 2–4 条常驻。
   三五十人规模无所谓，但 `nf_conntrack_max` 要留意（默认 65536 起，够用）。
6. **Docker 里跑 hy2 时方案 A/B 都不成立**。容器有自己的 netns，宿主机 PREROUTING 命中不了
   容器的 UDP 端口；要么 `network_mode: host` + 宿主机规则，要么在容器里加 `CAP_NET_ADMIN`
   并在容器 netns 内建规则。面板的 agent 是宿主脚本拉裸二进制，不受影响 —— 但文档要写清楚，
   免得有人照抄 docker-compose 部署 hy2。
7. **客户端静默降级**。范围不被支持时客户端用第一个端口连，**不报错也不提示**。
   排障时先看客户端是否真的在跳（官方客户端日志有 hop 记录；mihomo 看不到，只能靠
   服务端 `tcpdump` 看 dport 是否在变）。
8. **中转入口不生效**。入口机只转发一个端口，落地机的范围它看不到，所以 `hopFor()` 在
   有入口时不下发范围，`hopError()` 干脆把「范围 + 入口」的组合拦在保存这一步。
   想让走中转的用户也跳，得在入口机上再装一套「范围 → 入口端口」，
   属于二期（且入口机往往是多节点共用，要按入口端口分范围）。
9. **iptables 回退没有 counter**。nft 路径每条规则带命中计数，`nft list table` 就能看出
   客户端在不在跳；iptables 只能 `iptables -t nat -L NODEPANEL_HYHOP -vn`。排障时优先找
   有 `nft` 的机器。
10. **iptables 回退只覆盖 IPv4**。`iptables` 的 `nat` 表对 IPv6 流量完全不可见 —— 内核是
   两套协议栈、各有一张 nat 表。只写 v4 时，v6 客户端跳到范围内任何端口都不会被重定向，
   而所有表象都正常：面板显示 `x/x 已装`、`tcpdump` 能看到范围内的入站包、实例也活得好好的，
   只有 v4 那张表的 counter 恒为 0（实际踩过：`ip6tables -t nat -L PREROUTING` 一片空白）。
   0.1.31 及之前 agent 的 iptables 分支就是只写 v4；现在会镜像一份 v6 规则，并用
   `ip -6 addr show scope global` 判断「本机到底有没有 v6」，纯 v4 机器不必强求。
   自查时 `iptables` 和 `ip6tables` 两边都要看 —— 只看一边会得出完全相反的结论。
11. **nft 匿名集合的元素必须用逗号分隔**：`{ 40000-40499, 41000-41099 }`。
    `{ 40000-40499 41000-41099 }`（只有空格）是 syntax error —— 实测报
    `unexpected number, expecting comma or '}'`，而 `nft -f` 是整文件原子的
    —— 一条写错整张表都不落地。多段范围因此会**全部**失效，客户端看到订阅里有范围、
    agent 只留一行下发失败日志，表现为「配置对但只有单端口能用」。0.1.29 首版踩过：
    生成规则时 `tr ',' ' '`，单段范围看不出来，一填多段就全灭。
    连带两条防护：下发前跑 `nft -c -f` 预检（不过就保留上一版规则，别先删表），
    且 `hyhop.spec` 只在全部装上时落盘，否则下一轮会命中幂等跳过、把残留规则报成成功。
12. **端口段选择**。官方示例 20000-50000 只是示意，30001 个端口收益并不比 500 个大，
   反而让安全组难配、被扫描面变大。**100–1000 个连续端口足够**，避开 443 附近的
   高关注段更容易绕开单端口 QoS。

## 六、验证手册

```sh
# 1. 规则在不在（方案 B）
nft list table inet nodepanel_hyhop
# 方案 A 是每个实例一张表
nft list tables | grep hysteria_

# 2. 规则有没有命中（counter 增长 = 客户端确实在跳）
nft list table inet nodepanel_hyhop | grep -A1 counter

# 2b. iptables 后端 + 本机有 v6 地址：v4/v6 是两张独立的表，两边都要有这条链。
#     只查 iptables 会看到「规则在、counter 0」，容易误判成规则没命中
iptables -t nat -L NODEPANEL_HYHOP -vn
ip6tables -t nat -L NODEPANEL_HYHOP -vn

# 3. 外部是否真的打到范围内端口（在服务器上抓）
tcpdump -ni eth0 'udp and portrange 40000-40499' -c 20

# 4. 监听端口仍然只有一个，这是正常的
ss -lunp | grep hysteria

# 5. 客户端侧：官方 CLI 手动指定范围内某个端口，能连上 = 规则生效
hysteria client -c client.yaml   # server: host:40037
```

判定口径：**规则真的在（nft 看表；iptables 后端要 v4/v6 两张表都有）+ `tcpdump` 能看到
范围内的 dport + `ss` 只有一个监听端口**，三者同时成立才算通。只看 `ss` 会误判成「没生效」，
只看 `iptables` 会把「v6 规则缺失」误判成「规则没命中」。

## 七、不建议做的事

- 不要期望用它对抗 UDP 整体封锁（该上 `mimic`，两者互斥）。
- 不要给一台机器上多个 hy2 节点共用一个范围（互相抢 dport，且无法区分）。
- 不要把 `listen` 写成范围之后又手工加一遍 iptables 规则（重复重定向，counter 双份，排障混乱）。
- 不要在订阅里只给范围不给单端口：客户端不支持范围时，连第一个端口都不存在（范围里首个端口通常是 443 之外的号）。
