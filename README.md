# 节点管理面板

一个能跑起来的最小可用控制平面：**面板管数据，服务器上的 agent 管执行，用户看订阅页**。

零外部依赖：面板只用 Node.js 标准库（数据存 SQLite，走内置 `node:sqlite`），
节点上的 agent 是纯 shell 脚本，**不需要装 Node / Python / jq**。

面板自己巡检到期、超额、离线、agent 落后这几类问题，出事推到 webhook / Telegram / 邮箱；
用量按「用户 × 天」「节点 × 天」逐日留档，能看出谁在吃带宽、哪台机器在吃力。

三五十人的合租场景需要的琐事也都在：**批量建号**、**邀请链接自助领号**、**节点同步回执**、
**一键备份与恢复**、**审计日志**，以及订阅页上的**按设备推荐客户端**。

```
┌─────────────┐   管理操作    ┌──────────────┐
│  管理面板    │ ───────────▶ │   面板服务    │
│  (浏览器)    │              │  server.js   │
└─────────────┘              │  panel.db    │
┌─────────────┐   订阅链接    │  (SQLite)    │
│  用户订阅页  │ ◀─────────── │              │
└─────────────┘              └──────┬───────┘
                                    │ ① 拉配置包 (60s) + 上报公网 IP
                                    │ ② 报流量 (60s，纯文本)
                             ┌──────▼───────┐
                             │  agent.sh    │ ← 部署在每台节点服务器
                             │  Xray        │    POSIX shell，零运行时
                             │  Hysteria2×N │
                             └──────────────┘
```

---

## 一、快速开始

```bash
cd node-panel
node server.js          # 或 npm start
```

> 需要 **Node.js 22.13+**（内置 `node:sqlite` 从该版本起免 flag 可用）。
> 镜像用的是 24（Active LTS），自建部署留 22.13 作地板——两件事互不影响。

打开 http://localhost:8080 ，默认账号 **admin / admin888**。

> **首次登录会强制改密**：还着出厂密码时，登录后停在改密页，其余接口一律 403，
> 改成 ≥8 位的新密码（不能还是 `admin888`）并用新密码重新登录后才能进管理台。
> 用 `PANEL_ADMIN_PASSWORD` 指定了密码的实例不受影响。

**首次启动是空库**：只有超级用户 `admin`、同名的默认管理员用户（用户列表首行，带「管理员」标记）
和默认站点设置，没有任何演示数据 —— 套餐、服务器、节点、其它用户都由你自己建。
默认管理员用户不限套餐、不限流量、长期有效，且不可删除（不用就在编辑里停用）。
想先看看有数据长什么样：

```bash
PANEL_SEED_DEMO=1 node server.js
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PANEL_ADMIN_USER` | `admin` | 初始管理员账号（仅首次建库时生效） |
| `PANEL_ADMIN_PASSWORD` | `admin888` | 初始密码 |
| `PANEL_DATA_DIR` | `./data` | 数据目录（`panel.db` 所在处） |
| `PANEL_DB_FILE` | `$PANEL_DATA_DIR/panel.db` | 直接指定 SQLite 文件路径 |
| `PANEL_SEED_DEMO` | 空 | 设为 `1` 才写入演示数据（正式部署别开） |
| `PANEL_TRUST_PROXY` | 空 | 设为 `1` 时无条件采信 `X-Forwarded-For`；不设则只在前置代理来自本机/内网时采信 |

数据文件：`data/panel.db`（SQLite，WAL 模式）。老的 `data/db.json` 会在首次启动时
自动导入并改名为 `db.json.imported`，不会丢数据。

---

## 二、核心概念

### 套餐（权限组）

套餐只定义两件事：**流量额度**和**有效期**。节点反向声明归属哪些套餐，用户绑定套餐。

```
plan    → { 名称, 流量额度 GB, 有效期 { type, num, endAt }, 自动续期 }
node    → { planIds: [...] }   多选，可同属多个套餐
user    → { planId, cycleStartAt, renewCount, expireAt }
          额度与到期自动继承套餐，用户侧不可修改
```

有效期有五种形态，都在套餐里配：

| type | 含义 | 到期时间怎么算 |
| --- | --- | --- |
| `day` | 按天 | 加入时间 + `num` 天 |
| `month` | 按月 | 加入时间 + `num` 个**自然月**（1 月 31 日加一个月落到 2 月 28/29 日） |
| `quarter` | 按季度 | 加入时间 + `num` × 3 个自然月 |
| `year` | 按年 | 加入时间 + `num` 个自然年 |
| `custom` | 自定义 | 固定的 `endAt`，该套餐所有用户统一在这一刻到期 |
| `none` | 永久 | 不设到期 |

老的 `days` 字段仍然接受（等价于 `day` 类型），接口响应里也会把 `validity` 折算出 `days` 一起返回，
所以第三方脚本不用改。

### 自动续期

套餐默认**自动续期**：到期那一刻自动把该用户的已用流量清零，并把有效期顺延一个周期，
用户无感知，不需要管理员手动续费。

```
按月付费（有效期 = 1 个月）
  用户 A：起租 10-23 → 到期 11-23 → 11-23 自动续 → 流量归零，到期变 12-23 → …
管理员关掉续期的套餐
  用户 B：到期后状态变「已过期」，订阅与节点配置立刻剔除，需要手动处理才恢复
```

规则细节：

- **默认开启**：新建套餐不传 `autoRenew` 就是开启；老库升级上来的套餐同样默认开启
- **永久 / 自定义到期不能续**：这两种没有「下一个周期」，开关会自动关掉并置灰
- **从起租时间按整数倍推进**：不会一期一期往上叠，1 月 31 日起租、按月续，第三期仍是 4 月 30 日而不是滚成 4 月 28 日
- **停机不白送**：面板停了几天没跑，恢复时一次性推进到「未来」那个周期点，只重置一次流量
- **换套餐重新起租**：给用户换绑套餐视为新一期开始，起租时间重置为当下，续期计数清零
- **触发时机**：agent 心跳（60 秒）、用户列表 / 概览 / 订阅 / 配置下发时都会先扫一遍，
  另有服务端每 60 秒的兜底巡检，面板没人打开也不会漏

接口：`POST /api/plans` 与 `PUT /api/plans/:id` 都接受 `autoRenew: true|false`；
`GET /api/plans` 与 `/api/users` 会返回 `autoRenew`，用户对象另带 `renewCount`（已续期次数）、
`cycleStartAt`（起租时间）、`lastRenewAt`（上次续期时间）。

三层过滤依次生效：

```
用户绑定套餐 → 订阅只输出该套餐内的节点
            → 节点配置只注入该套餐的用户
            → 超额/过期/停用用户再被剔除
```

在「节点」页用多选下拉把节点加入套餐；用户不选套餐 = 「不限套餐」，可见全部节点，
此时额度与到期才允许手动填写（适合管理员自用）。

修改套餐的额度或有效期，会立即同步到所有归属该套餐的用户。

### 两种部署方式

| 方式 | 说明 | 部署命令在哪 |
| --- | --- | --- |
| 跟随服务器 | 一台机器一个 agent，管理该机器全部节点 | 「服务器」页 |
| 独立部署 | 节点自带 token，单机单节点也能跑 | 「节点」页，列表里多出「部署」按钮 |

两种方式用的是**同一套 agent 和同一个接口**，只是 token 的作用域不同：
服务器 token 拉取这台机器上所有节点，节点 token 只拉取它自己。

### 协议支持

| 协议 | 传输 | 说明 |
| --- | --- | --- |
| VLESS | tcp / ws / grpc / httpupgrade | 支持 Reality + Vision 流控，可选 VLESS Encryption |
| VMess | tcp / ws / grpc / httpupgrade | 兼容性好 |
| Trojan | tcp / ws / grpc | 需 TLS |
| Shadowsocks | tcp | 单用户模式，节点级共享密码 |
| Hysteria2 | QUIC | 独立进程，每节点一个实例 |

#### Reality 与 uTLS

Reality 无需证书：新增节点时点「生成」按钮，面板会现场生成 x25519 密钥对和 shortId，
私钥只下发给服务器，公钥自动写进订阅的 `pbk` 参数。流控默认 `xtls-rprx-vision`，可关。

**uTLS 是客户端侧能力**，服务端无从开启——它改的是客户端 TLS ClientHello 的指纹特征。
面板能做的就是在订阅链接里带上正确的 `fp` 参数（chrome / firefox / safari / randomized / 关），
Reality 下建议 chrome。VLESS Encryption（`mlkem768x25519plus`）则是服务端与客户端双向特性：

- 需要 **Xray 25.6.0+**，两端都要支持
- 它解决的正是 vision 流控当年解决的 TLS-in-TLS 问题，所以**与 Reality 二选一即可**
- 同时开启在部分传输组合下有已知问题，默认关闭

### Hysteria2

由独立的 `hysteria` 二进制承载（不是 Xray 协议）。agent 会为每个节点写一份
`node-<id>.yaml`（老机器在 `/etc/hysteria/`，0.1.9 起新机器在 `/etc/streamd/`），
并**自己用 pid 文件托管实例**（`/run/nodepanel/<实例>.pid`），
所以**一台机器可以跑多个 Hysteria2 节点**，而且不依赖 systemd / OpenRC 的模板单元 ——
Alpine 这类没有 systemd 的系统也能跑。流量通过每实例的 `trafficStats` 接口按用户名归属。
部署脚本检测到 Hysteria2 节点时会按 CPU 架构下载官方静态二进制。
混淆密码在节点表单里点「生成」即可随机产生，也可手填。

### TLS 证书的四种来源

| 模式 | 说明 |
| --- | --- |
| 服务器路径 | 填服务器上已有的证书/私钥路径（原有行为） |
| 粘贴证书内容 | 面板里贴 PEM，agent 落盘到 `/etc/nodepanel/certs/<节点ID>/`，权限 0600 |
| 自动生成自签 | agent 用 openssl 生成 10 年自签证书，CN 取 SNI |
| ACME 自动申请 | agent 安装 acme.sh 向 Let's Encrypt 申请，之后由 acme.sh 定时任务自动续期 |

**自签证书节点依然能连通**——TLS 握手本身不校验证书链可信度，只要客户端接受它就能建连。
代价是客户端必须关闭证书校验，所以面板在自签时会自动给订阅带上
`allowInsecure=1` / Clash 的 `skip-cert-verify: true`，开箱即用。
生产环境建议用 ACME：需要域名已解析到该机、80 端口可用、机器能访问外网。

agent 可用 `CERTS_ROOT` 覆盖证书目录：面板下发的路径前缀与本机不一致时，
agent 会自动重写配置里的引用，保证「文件写在哪」和「配置引用哪」永远一致。

### 中转节点（入口）

在节点上添加入口地址，**一个入口在订阅里发布为一条独立节点**，客户端可以自动选路与故障转移：

```
用户 ──▶ 入口 A:443 ──DNAT──▶ 节点所在机器 C:443
       └─▶ 入口 B:8443 ─┘
```

入口机器上执行「节点 → 部署 → 中转脚本」，agent 会写好 iptables NAT 规则（幂等）并持久化。
这是 **L4 层中转**：入口不解析协议，因此 TLS / Reality / Hysteria2 全部适用，
而且**流量仍记在落地节点上**，计费与统计不受影响。

如果需要在入口终止 TLS、加自己的认证或转发明文协议，那才需要 L7 中转
（在入口上跑一个 Xray，inbound 对用户、outbound 指向落地节点），代价是双重加密，
并且要在落地节点上为入口准备一个专用账号。

#### 入口与原始节点可以分别控制套餐和显隐

| 维度 | 原始节点 | 中转入口 |
| --- | --- | --- |
| 套餐 | 节点加入哪些套餐 | 入口可单独勾选套餐；**不选则继承节点套餐** |
| 显隐 | 「在订阅中隐藏直连」 | 「在订阅中隐藏此入口」 |

两者的显隐完全独立：**原始节点被隐藏时，只要入口自身没隐藏，中转链路依然可用**——
所以你可以只卖中转、不暴露落地 IP。agent 侧本就与显隐无关，隐藏只作用于订阅输出。

> 一致性保证：如果某个用户是通过「入口自有套餐」获得访问权的，
> 那么该节点下发给 agent 的配置里也会注入这个用户——否则中转把用户送进来，
> 节点却不认，链路是通的但连不上。

### 公网地址上报

服务器和独立节点都有两种地址来源：

- **手动填写**：管理员填域名或 IP，agent 上报的 IP 会被忽略
- **由服务器上报**：agent 启动后自行探测公网 IP（ipify / ifconfig.me / ip.sb / icanhazip.com 多路备选，5 分钟缓存），
  随配置请求一起带给面板；面板只在该机器为「自动」模式时记录它

换 IP 的机器不用再登面板改地址，订阅链接会自动跟着变。

不想让机器主动出网探地址的话，在 `/opt/nodepanel/agent.env` 里加一行就行：

```bash
REPORT_IP=0
```

之后 agent 照常拉配置、报流量，只是不再带 `ip=` 参数，面板也不会记录上报地址。
把服务器/节点的地址来源改回「手动填写」即可。默认是 `REPORT_IP=1`（上报）。

---

## 三、完整使用流程

### 1. 添加服务器

「服务器」页 → 新增服务器。地址来源选「由服务器上报」的话，地址可以先空着。

### 2. 添加节点

「节点」页 → 新增节点 → 选部署方式（跟随服务器 / 独立部署）与协议。
一台服务器可以挂任意多个节点。

### 3. 执行部署命令

服务器页或独立节点页点「部署命令」，复制到目标机器终端（root）：

```bash
# 跟随服务器
curl -fsSL "http://面板/api/servers/<id>/install?token=<服务器token>" | sh

# 独立节点
curl -fsSL "http://面板/api/nodes/<id>/install?token=<节点token>" | sh
```

脚本会做这些事（输出按 `[n/m]` 分步，每步都把版本、体积、路径、服务状态打出来）：

1. 把 agent 装到 `/opt/nodepanel/agent.sh`，`sh -n` 校验后打印版本与体积
2. **检测并安装 Xray 本体**（`xray-core` 官方发行包 + `geoip.dat` / `geosite.dat` + 服务单元）；
   机器上已经有 `xray` / `xray-core` / `x-ui` 服务时整段跳过，一个字节都不动；
   **全新安装落地为伪装名**（见下方「安装伪装」）
3. 有 Hysteria2 节点且未装 hysteria 时，按架构下载官方二进制（同样落地为伪装名）
4. 写入 `/opt/nodepanel/agent.env`（含 token，权限 600；值统一加引号，`RELOAD_CMD` 里有空格也不会被拆成命令）
5. 按系统注册开机自启：`systemd` → 服务单元；`OpenRC`（Alpine）→ init 脚本；都没有则退回 crontab
6. 等 agent 首轮同步（最多 12s），打印 Xray 实际运行状态，最后给一份汇总

```
星链 · 节点部署
      目标      示例节点机 (1.2.3.4)
      面板      http://面板地址
      系统      Debian GNU/Linux 12 (bookworm) · x86_64 · 6.1.0-13-amd64
      服务管理  systemd

[1/4] agent 脚本 → /opt/nodepanel/agent.sh
      版本 0.1.9 · 34 KB · sh -n 通过
      · 日志目录 /var/log/nodepanel，运行时目录 /run/nodepanel

[2/4] Xray 本体 → /usr/local/bin/webcore
      本机没有 Xray，下载官方发行包
      · 来源 https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip
      · 已下载 23.4 MB，解压中
      已安装 Xray 25.9.11 · 27.1 MB
      · 数据文件 geoip.dat / geosite.dat → /usr/local/share/webcore
      服务单元 /etc/systemd/system/webcore.service（已 enable，配置下发后启动）

[3/4] 运行配置 → /opt/nodepanel/agent.env
      PANEL_URL=http://面板地址
      INTERVAL=60s · XRAY_CONFIG=/usr/local/etc/webcore/config.json
      RELOAD_CMD="systemctl restart webcore"
      · 权限 600（内含 token）

[4/4] 开机自启 → nodepanel-agent
      systemd 单元 /etc/systemd/system/nodepanel-agent.service
      · Restart=always · RestartSec=10 · KillMode=process
      等待 agent 首轮同步（最多 12s）
      服务 webcore 运行中（pid 1234）

✓ 部署完成 · 耗时 8s

  agent      v0.1.9 · systemd · 每 60s 一轮
  xray       Xray 25.9.11 · 运行中
  hysteria2  不需要（本机没有 Hysteria2 节点）
  配置       /usr/local/etc/webcore/config.json
  状态       /opt/nodepanel/state.env

  日志       journalctl -u nodepanel-agent -f
  重启       systemctl restart nodepanel-agent
  手动一轮   sh /opt/nodepanel/agent.sh --once
```

agent 的版本号只有一处来源：面板 `package.json` 的 `version`。部署脚本下发时会把脚本里的
`VERSION=` 替换成当前面板版本，所以面板上看到的 agent 版本永远和面板一致。

**关于 Xray**：0.1.5 起部署脚本会自己装，新机器开箱即用。几种特殊情况：

| 情况 | 脚本行为 |
| --- | --- |
| 全新机器 | 下载官方 `Xray-linux-<arch>.zip`（x86_64 / arm64 / armv7 / 386 / mips / ppc64 / riscv64 / s390x），**落地为伪装名 `webcore`**（见下），注册 `webcore.service` |
| 已有 `xray` / `xray-core` / `x-ui` 服务 | 跳过安装，沿用原有单元与官方路径（老机器不受伪装改造影响） |
| 只有 `xray` 二进制、没有服务单元 | 只补一份服务单元，不重新下载 |
| 想完全自己管 Xray | `curl -fsSL "…/install?token=…" \| SKIP_XRAY=1 sh` |
| GitHub 拉不动 | `curl -fsSL "…/install?token=…" \| XRAY_DOWNLOAD_BASE=<镜像地址> sh` |
| 想换伪装名 | `curl -fsSL "…/install?token=…" \| XRAY_ALIAS=自定义名 sh` |

### 安装伪装（0.1.9）

部分服务商会对主机做特征扫描（`ps` 枚举、`find` 特征文件名、systemd 单元枚举）。
全新安装的机器上，Xray 不再以本名落地，而是统一伪装成 **`webcore`**：

| 项目 | 官方安装（老机器沿用） | 伪装安装（0.1.9 起新机器） |
| --- | --- | --- |
| 二进制 | `/usr/local/bin/xray` | `/usr/local/bin/webcore` |
| 服务单元 | `xray.service`（Description=Xray Service） | `webcore.service`（Description=WebCore Service） |
| 配置 / geo 数据 | `/usr/local/etc/xray`、`/usr/local/share/xray` | `/usr/local/etc/webcore`、`/usr/local/share/webcore` |
| 进程名（`ps` / `pgrep`） | `xray` | `webcore` |
| Xray error 日志 | `/var/log/xray/error.log` | 不落盘（走 stderr → journald，配置里 `error: 'none'`） |

Hysteria2 同理落地为 **`streamd`**（二进制 `/usr/local/bin/streamd`，配置 `/etc/streamd/`）。
agent 的一切探测（重载命令、存活自检、端口自检、卸载清理）都按 `agent.env` 里记录的
实际名称与路径工作，所以伪装不需要任何额外配置。**兼容规则**：机器上已有官方名安装时，
重新执行部署命令会沿用原布局，不会出现两套并存。

> 伪装只能降低主机侧特征扫描的命中率，**挡不住流量层检测**（netflow / 主动探测）；
> 是否可用取决于服务商条款，请自行评估。

纯 Hysteria2 的独立节点不会装 Xray，省这份空间。Xray 的 error 日志不落盘（`error: 'none'`，
错误走 stderr → journald：`journalctl -u webcore`），省掉了「目录不存在 xray 启动即退出」这一类坑。

### 4. 之后的一切都是自动的

agent 每 60 秒执行一轮：

- 探测公网 IP，带本地 hash 请求 `GET /api/agent/bundle?token=...&hash=...`
- hash 没变只回一行 `#UNCHANGED`，省流量；变了就下发**配置包**（一段 shell 脚本，base64 内嵌配置文件）
- agent 执行配置包 → 文件有变化才重载 Xray / 重启对应 Hysteria2 实例
- 从 Xray StatsService 和各 Hysteria2 实例读流量，`POST /api/agent/report` 以纯文本上报

在面板里加节点、改端口、停用用户，**最多 60 秒自动生效，不用再登服务器**。

#### agent 的资源占用

| 项目 | 占用 |
| --- | --- |
| 运行时依赖 | 无（`sh` + `sed` + `awk` + `base64`，busybox 全都有） |
| 常驻内存 | 约 2–3 MB（一个 shell 循环 + 每轮 fork 的子进程，跑完即释放） |
| 磁盘 | 脚本约 20 KB + 配置 + 日志（单实例日志超过 5 MB 自动清空） |

64 MB 内存的 Alpine 小鸡也能长期跑。agent 被 OOM 或误杀后由 systemd `Restart=always`
（OpenRC 由 `supervise`、cron 由下一分钟）自动拉起。

Hysteria2 实例**不依赖 systemd 模板单元**：agent 用 `/run/nodepanel/<实例>.pid` 自己托管，
每轮检查进程是否还活着，挂了就重启，节点删了就停掉并清理配置。

```bash
journalctl -u nodepanel-agent -f        # agent 日志（systemd）
tail -f /var/log/nodepanel/agent.log    # agent 日志（OpenRC / cron）
ls /run/nodepanel/                      # Hysteria2 实例 pid
tail -f /var/log/nodepanel/node-*.log   # 单个 Hysteria2 实例日志
sh /opt/nodepanel/agent.sh --once       # 手动跑一轮，排查用
sh /opt/nodepanel/agent.sh --version    # 看 agent 版本（与面板版本号一致）
```

### 5. 卸载 / 下线机器

服务器页、独立节点页都有「卸载命令」。在机器上（root）执行后 agent 停机注销，**节点端口也不再监听**：

```bash
# 默认就卸干净：agent + 节点监听 + 面板下发的配置
curl -fsSL "http://面板/api/servers/<id>/uninstall?token=<token>" | sh

# 连日志与配置备份一起删
curl -fsSL "http://面板/api/servers/<id>/uninstall?token=<token>" | sh -s -- --purge
```

| 默认清理 | 默认保留 |
| --- | --- |
| `nodepanel-agent` 服务（systemd 单元 / OpenRC 脚本 / crontab 三种都认）与残留进程 | `config.json.nodepanel.bak`（面板覆盖前的配置备份） |
| agent 托管的 Hysteria2 实例与配置（`/etc/hysteria` 或 `/etc/streamd`） | `/var/log/nodepanel` 日志（`--purge` 时删除） |
| `/opt/nodepanel`、`/run/nodepanel`、`/etc/nodepanel`（自签证书） | Xray 二进制与 geo 数据（`webcore` 或 `xray`，可能是你自己装的） |
| **Xray 服务（停掉 + 取消开机自启）与面板生成的 `config.json`**（先备份；只认带 `StatsService` 的那份） | 面板里的服务器 / 节点记录（要清就在列表里删除） |

脚本幂等，重复执行不报错；想重新接入，执行一遍部署命令即可 —— 记录、token、订阅都不用重建。

> 排查提示：agent 报「Xray 重载失败」时会把服务管理器的原始错误一起打出来。
> 如果本机服务名不是 `webcore` / `xray`（如 `x-ui`、`xray-core`），部署脚本会自动匹配；
> 手工装的机器把 `RELOAD_CMD="systemctl restart <服务名>"` 写进 `/opt/nodepanel/agent.env` 即可。

### 6. agent 自更新

面板版本变了，agent 会自己把脚本换掉，不用再登机器重跑部署命令：

1. 面板在配置包的 `state.env` 里写上 `NP_AGENT_VERSION=<面板版本>`
2. agent 每轮比对本地 `VERSION`，发现不一致就 `GET /api/agent/script?token=…&v=<当前版本>`
   （`v` 只用于面板日志，真正的版本校验在下一步的脚本内容里）
3. 下载到的脚本先过三道校验：首行是 `#!/bin/sh`、`sh -n` 语法通过、`VERSION='<目标版本>'` 完全对得上
4. 全通过才备份成 `agent.sh.bak`、原子 `mv` 替换，然后 `exec sh "$0"` —— 同一个 PID 重进主循环，
   systemd / OpenRC 看到的还是原来那个进程，不算重启也不算重连
5. 任何一步失败都不替换，失败次数记在 `/opt/nodepanel/.agent-update`；**同一个目标版本连失败 3 次就停手**，
   免得脚本本身有问题时每分钟重试一次把节点刷成日志机

想立刻生效（不等到下一轮）：

```bash
sh /opt/nodepanel/agent.sh --once      # 跑一轮就会顺手把脚本换掉
sh /opt/nodepanel/agent.sh --version   # 换完再看一眼版本
cat /opt/nodepanel/.agent-update       # 「目标版本 失败次数」，成功换版后会删掉
```

> 自更新只换 `agent.sh` 本身，**不动** `agent.env`（token、`INTERVAL`、`RELOAD_CMD` 都在里面）。
> 只有面板地址变了（换域名 / 换端口）才需要重跑一次部署命令。

面板「通知」里有一类事件 `agent 版本落后`：机器上的 agent 长时间没跟上版本时提醒你 ——
通常意味着那台机器连不上面板了，而不是自更新坏了。


---

## 四、流量与额度

### 统计口径

- Xray 用户 email 固定为 `u<用户ID>`，Hysteria2 用户名同样为 `u<用户ID>`（密码 = 用户 UUID）
- 统计 = 上行 + 下行（双向都算）
- agent 读取**增量**后上报，面板累加到 `usedBytes`

### 流量明细（用户 × 天 / 节点 × 天）

侧栏「流量」页按天看用量，7 / 14 / 30 天可切，页面顶部是每日柱状图：

| 维度 | 数据来源 | 用在哪 |
| --- | --- | --- |
| 用户 × 天 | Xray 里 email 为 `u<用户ID>` 的上下行增量 | 计费口径；用户列表「更多 → 查看用量明细」只看一个人 |
| 节点 × 天 | 跟随服务器的节点按 Xray 入站 tag `node-<节点ID>`；独立节点的 Hysteria2 按实例汇总 | 看哪台机器在吃力，决定下次把新用户放哪 |

明细落在 `user_daily` / `node_daily` 两张表（`(ID, 日期)` 唯一），上报时逐条 `bytes += 增量`，
不参与整表重写 —— 天数再多也不会拖慢保存。默认保留 400 天，启动时顺手清理更早的行。

> 节点维度的用量**不计入用户额度**，也不进站点的 `daily_stats` —— 否则同一份流量会被算两次。
> 只有用户维度才是计费口径，节点维度纯看负载。

升级到带明细采集的版本后，节点维度要等 agent 换完脚本（通常一轮心跳内自更新）才陆续有数；
在那之前「流量」页会提示「节点的每日用量还没上来」。执行一次
`sh /opt/nodepanel/agent.sh --once` 可以立刻让它开始报。

### 超额会发生什么

额度用完后状态变为「超量」，然后：

1. 下一次 agent 拉配置时，**该用户从所有节点的 clients / userpass 列表里消失**
2. 用户订阅返回空列表
3. 客户端下次重连直接失败

配置级硬隔离，不靠客户端自觉。过期、手动停用同理。

### 管理员手工调整已用流量

「用户」页 → 编辑 → **已用流量（GB）** 可以直接改，用于补偿、对账、给客户加量：

- 额度 100 GB、已用 90 GB 时改成 50 GB → 剩余可用立刻变回 50 GB，状态从「超量」回到「正常」，
  下一轮 agent 拉配置时用户重新出现在节点里
- 改成一个超过额度的值 → 立刻转为「超量」，订阅与节点配置同步剔除
- 编辑弹窗里会实时显示「已用 / 剩余 / 共多少」，改之前就能看到结果

### 演示流量

「概览」页右上角「模拟流量」按钮可给用户注入随机流量，方便观察额度闸门（纯演示，不影响真实统计口径）。

---

## 五、通知与告警

面板自己盯着几类问题，出事往你选的地方推一条消息 —— 不用天天开面板刷新。
配置全在「设置 → 消息通知」，状态存在本地 SQLite，不依赖任何第三方服务。

### 会通知什么

| 事件 | 触发条件 |
| --- | --- |
| 用户即将到期 | 距到期 ≤「到期前提醒」天数（默认 3）。开了自动续期的用户不提醒 |
| 用户已过期 | 到期且没开自动续期，该用户已被节点剔除 |
| 用户流量超额 | `已用 ≥ 额度`，同样已被剔除 |
| 服务器离线 | 超过「离线判定」分钟（默认 10）没有心跳 |
| 独立节点离线 | 同上，独立部署的机器 |
| agent 版本落后 | 机器上的 agent 版本与面板不一致超过 7 天 |

「关注的事件」一个都不勾 = 全部关注；勾了之后只发勾上的那几类。
管理员账号自己不参与（不会天天提醒你「你到期了」）。

### 三种渠道

| 类型 | 要填什么 | 备注 |
| --- | --- | --- |
| Webhook | 地址 + 载荷格式（可选鉴权头） | 通用 JSON / 企业微信 / 钉钉 / 飞书 / Slack 五种格式，机器人字段名不一样，选对就行 |
| Telegram | Bot Token + Chat ID（可选反代地址） | 直连不了 `api.telegram.org` 时填自己的反代，只替换域名部分 |
| 邮件 | SMTP 服务器 / 端口 / 加密 / 账号 / 密码 / 收件人 | 465 选「TLS」；587、25 选「STARTTLS」；内网自建 MTA 可选「不加密」 |

邮件是**手写的 SMTP 客户端**（`lib/smtp.js`，跑在 `node:net` / `node:tls` 上）：
支持 AUTH LOGIN 与 PLAIN、多收件人、中文标题（RFC 2047 编码）、HTML + 纯文本双段。
不上 nodemailer 是为了保住「零依赖」这条底线。

> QQ / 163 / Gmail 要填**授权码**而不是登录密码。填错了「最近发送记录」里会看到
> `SMTP 535：…` 这样的原始报错，照着改就行；webhook 404、连不上、超时也一样能定位。

每个渠道可以单独订阅事件（不勾 = 全部），比如「运维群收离线，自己邮箱收超额」。
新建渠道后点一次「测试」，确认那条消息真的到了再往下用。

### 重复提醒怎么控

告警按稳定 key 去重（`user:<id>:over`、`server:<id>:offline` …），同一个问题不会每轮巡检都发一遍：

- 首次触发**立刻**发一条，不等间隔
- 之后按「重复提醒间隔」（默认 12 小时）再发，服务器/节点离线是 2 小时、agent 落后是 7 天
- 问题消失时发一条恢复通知（`问题恢复时也通知`，可关）；再出现算新的一轮，立刻发
- 发送失败也算「发过了」—— 否则 webhook 挂了会每 60 秒重试一次，把日志和对方接口都打爆

巡检每 60 秒跑一次（启动 15 秒后先跑一次），也可以在设置页点「立即检查」手动触发。
没开总开关、或一个启用的渠道都没有时，巡检直接返回，不做任何事。

### 发送记录

设置页底部保留最近 200 条发送记录（时间 / 渠道 / 成败 / 失败原因），
`notify_log` 表里也是这些数据。排查「为什么没收到消息」先看这里，八成是渠道配置或对方接口的问题。

### 安全性

- 面板返回渠道时会把 `botToken` / `pass` / `secret` 脱敏成 `••••••`；编辑时留空或保持脱敏值都不会覆盖已存的值
- webhook 的鉴权头以 `Authorization: Bearer <token>` 发送
- 所有请求都有 15 秒超时，失败不会阻塞巡检，也不会抛到调用方

---

## 六、批量建号与邀请

三五十人的规模，一个个手点「新增用户」太慢。这里给两条路：**自己批量建号**，或者**把链接丢给对方自助领号**。

### 批量建号

「用户」页右上角「批量建号」，两种填法：

| 方式 | 填什么 | 得到什么 |
| --- | --- | --- |
| 按数量 | 前缀 + 个数 + 起始序号（如 `租客` / 5 / 1） | `租客01` … `租客05`，序号自动补零 |
| 按名单 | 每行一个名字，也可用中英文逗号、顿号、分号分隔 | 名单里逐个建号 |

- 一次最多 200 个，超过会提示分批
- 重名（本批次里重复、或库里已有同名）跳过并列出原因，不会建出两个同名账号
- 名字超过 60 字跳过；空格不当作分隔符（`Li Ming` 是人名）
- 可同时指定套餐与备注，不指定就是「不限套餐」
- 建完弹窗给出「名字 + 订阅链接」清单，两个复制按钮：全都要，或只要链接

### 邀请链接

不想自己起名字？生成一条邀请链接发群里，对方填个名字就拿到账号。

「用户」页 → 「邀请链接」→ 填套餐 / 名额 / 有效期 / 备注 → 生成，
得到形如 `https://panel.example.com/i/3f2518` 的地址。

| 字段 | 说明 |
| --- | --- |
| 套餐 | 领到的人自动带上这个套餐；不选就是「不限套餐」 |
| 名额 | 1–500，用掉一个少一个 |
| 有效期 | 留空 = 长期有效；过期后链接自动失效 |
| 备注 | 只给管理员看，也写进审计日志 |

对方打开页面看到的是**套餐、额度、有效期、剩余名额**，填名字点「领取并生成订阅」，
成功后直接给出订阅地址与一键导入按钮。某条邀请可以随时在弹窗里停用或删除。

- 邀请码是 6 位十六进制，短到贴群里不会被截断；公开页面**不暴露用户 token 或用户列表**
- **按 IP 限流**：同一 IP 每小时最多领 10 次，防止有人拿脚本刷着批量建号
- 名字重复返回 409，页面就地提示换一个
- 名额用尽 / 过期 / 停用时，页面直接显示「名额已用完 / 邀请已过期」，不会再创建账号
- 每次领取都进审计日志（`invite.claim`，操作人就是领取人）

### 检索与批量操作

用户列表顶部有三件东西：搜索框、状态筛选、套餐筛选。

- 搜索匹配 **名字 / 备注 / 订阅 token**（记得 token 前几位就能找到人）
- 状态：正常 / 超量 / 已过期 / 已停用；套餐可筛「不限套餐」
- 计数显示「筛选后 / 全部」
- 勾选左侧复选框（或表头全选当前筛选结果）后浮出批量操作条：

| 操作 | 说明 |
| --- | --- |
| 启用 / 停用 | 停用后立即从节点配置与订阅中剔除 |
| 重置流量 | 已用归零，状态回到正常 |
| 续期 | 按套餐有效期顺延并清零已用流量；欠费多期的会自动补齐到未来（不会「续完还是过期」）；永久 / 自定义到期的会被跳过 |
| 改套餐 | 相当于开新一期：起租时间重置为现在，已用流量保留 |
| 删除 | 订阅链接立即失效 |

默认管理员账号不会被批量删除或停用（单个操作里也一样），会出现在「跳过」清单里。

---

## 七、回执 · 备份 · 审计

这三样都只在出事时才被想起来，所以做得尽量不用配置。

### 节点回执

agent 每轮拉完配置、重载完服务，会回一条执：**这一轮应用的是哪个版本、Xray 重载成没成、
Hysteria2 几个实例在跑、当前 agent 版本**。

「节点」「服务器」列表多了一列「同步」：

| 状态 | 含义 | 该做什么 |
| --- | --- | --- |
| 已同步 | hash 与面板一致，且节点端口确实在本机监听 | 什么都不用管 |
| 待同步 | 面板改过配置，agent 还没来拉（最多 60 秒） | 等一会儿；一直不变就查 agent 是否在跑 |
| 同步失败 | 配置应用或服务重载失败 | 点开看原始报错（如 `Xray 重载失败：status=failed`） |
| 端口未监听 | 配置已落盘、hash 也对得上，但本机监听表里找不到节点端口 | 代理连不上就是这个：先看 Xray / Hysteria2 是否在跑，再查防火墙与安全组 |
| 离线 | 超过判定时间没有心跳 | 查机器 / 网络 / 面板地址 |
| 待重载 | 配置已落盘，但没有自动重载：本机没有 systemd / OpenRC，或有服务管理器却没找到 xray 服务单元 | 手动重启一次；或把真实的重载命令写进 `agent.env` 的 `RELOAD_CMD` |
| 未回执 | 从来没有上报过 | agent 可能刚部署，或者一直连不上面板 |

> **「配置已生效」不等于「端口通」**：配置文件内容和面板一致，只说明文件写对了。
> agent 每轮还会用 `ss -lntu`（没有就用 `netstat`）核对面板下发的节点端口
> （`tcp:42000`、`udp:8443`）是否真的有人在监听，没听就回执「端口未监听」并点名端口，
> 同时在日志里打一行 `! 端口未在监听：tcp:42000`。
> 没有这道自检时，Xray 崩了 / 开机没自启 / 装错配置文件，面板会一直显示「已同步」，
> 只能靠登机器 `lsof -i:42000` 才发现。
>
> 另外 agent 现在会兜底拉起 Xray：配置没变但 `xray` 服务不在 `active`（重启后没自启、
> 被 OOM 杀掉），下一轮就会 `systemctl enable --now`，不用等配置变更才重载。

点徽标看详情：应用版本 hash、面板当前 hash、重载结果、Hysteria2 实例数、原始错误，
以及一条强制拉取命令 `sh /opt/nodepanel/agent.sh --once`。

回执只在**状态变化**或超过 10 分钟时发一次，不会每分钟一条把面板刷满；
跟随服务器的节点不单独回执，直接沿用所属服务器的状态。

### 备份与恢复

「设置 → 备份与恢复」：

- **立即备份**：`VACUUM INTO` 出一份完整库（`panel-manual-<时间>.db`），不停机、不锁读
- **下载**：拿到 `.db`，可以扔进任何 SQLite 工具里查
- **恢复**：选一份已有备份，或者**上传**一个 `.db` 文件
- **升级前自动备份**：schema 变更前自动存一份 `panel-v<旧版本>-<时间>.db`，只保留最近 5 份

恢复是「先体检、再兜底、最后覆盖」：

1. **体检**：写到一边只读打开，确认文件头是 SQLite、`users` / `settings` / `meta` 三张表都在、
   `PRAGMA integrity_check` 通过 —— 随便拿一个别的 `.db` 会被挡在门外，线上库一个字节都不动
2. 把**当前**的库再备份一份 `panel-prerestore-<时间>.db`
3. 旧库改名留底 → 临时文件原子 rename 上位 → 重新加载；
   新库万一在加载阶段出错，自动把旧库换回来（不会出现「db 为 null、全站 500」）
4. 清空所有会话：备份里的管理员密码可能和现在这个不一样

所以恢复错了还能再恢复回来。唯一需要注意的是 **`audit_log` 会一起回滚**到备份时点，
只有「恢复」这条会写进新库 —— 这是恢复语义本身决定的，不是漏记。

### 审计日志

侧栏「日志」页，记录**谁、什么时候、对什么、做了什么**：

- 覆盖登录、改密、用户（含批量）、套餐、节点、服务器、设置、通知渠道、邀请、备份
- 每条带操作人、目标、详情、IP、时间；登录失败（`login.fail`）也会留一条
- 支持关键字搜索（用户名 / 节点名 / 备注 / IP）与类型筛选，可翻页
- 计数跟着筛选条件走：过滤后显示「筛选出 N 条」，不会拿全库条数糊弄人
- 只保留最近 2000 条，超出自动裁掉最旧的；日志只增不改

合租最常见的三个问题——谁把某人的套餐改了、谁删了节点、谁动了订阅域名——都能在这里找到答案。

---

## 八、用户订阅

| 地址 | 内容 |
| --- | --- |
| `/s/<token>` | 浏览器打开 → 订阅页面（流量环、节点列表、一键导入） |
| `/s/<token>?format=base64` | Base64 节点链接（通用订阅格式） |
| `/s/<token>?format=clash` | Clash / Mihomo YAML（含 reality-opts、hysteria2） |
| `/s/<token>?format=json` | 结构化数据 |

响应带 `Subscription-Userinfo` 头，Clash Verge 等客户端能直接读到已用/总量/到期时间。

「设置 → 订阅对外域名」留空则按当前访问 Host 生成；面板在反代后面时建议显式填写。

该字段会做格式校验（前后端各一道，直接打 API 也绕不过去）：

- 只接受 `http://` / `https://`，不写协议时自动补 `https://`
- 主机名必须是合法 IP 或带点号的域名（`111`、`abc`、`1.2.3` 都会被拒）
- 可以带端口，但不能带路径、查询参数、`#` 片段或账号密码
- 保存时会去掉尾部斜杠，并回填规范化后的地址

---

## 九、接口一览

管理接口需要 `Authorization: Bearer <session token>`。

```
GET  /api/health                           健康检查（容器探针）
POST /api/login                            登录
GET  /api/overview                         概览统计

GET  /api/plans                            套餐列表
POST /api/plans                            新增套餐（额度 / 有效期）
PUT  /api/plans/:id                        修改套餐（自动同步到归属用户）
DELETE /api/plans/:id                      删除套餐（用户降级为不限）

GET  /api/users                            用户列表
POST /api/users                            新增用户（可绑套餐）
PUT  /api/users/:id                        修改用户（resetTraffic 重置流量）
DELETE /api/users/:id                      删除用户
POST /api/users/:id/rotate                 重置 UUID 与订阅 token
POST /api/users/bulk                       批量建号（names 名单 或 count+prefix+startAt）
POST /api/users/batch                      批量操作（enable/disable/reset/renew/plan/delete）

GET  /api/invites                          邀请列表（含套餐、剩余名额、状态）
POST /api/invites                          生成邀请（套餐 / 名额 / 有效期 / 备注）
PUT  /api/invites/:id                      启用或停用
DELETE /api/invites/:id                    删除邀请
GET  /api/invite/:code                     邀请公开信息（无需登录）
POST /api/invite/:code/claim               用邀请码自助建号（按 IP 限流）

GET  /api/nodes                            节点列表
POST /api/nodes                            新增节点
PUT  /api/nodes/:id                        修改节点
DELETE /api/nodes/:id                      删除节点
GET  /api/nodes/:id/preview                查看生成的配置（Xray / Hysteria2）
POST /api/nodes/:id/rotate                 重置独立节点 token
GET  /api/nodes/:id/install?token=         独立节点部署脚本
GET  /api/nodes/:id/uninstall?token=       独立节点卸载脚本（加 --purge 深度清理）

GET  /api/servers                          服务器列表
POST /api/servers                          新增服务器
PUT  /api/servers/:id                      修改服务器
DELETE /api/servers/:id                    删除服务器
POST /api/servers/:id/rotate               重置服务器 token
GET  /api/servers/:id/install?token=       服务器部署脚本
GET  /api/servers/:id/uninstall?token=     服务器卸载脚本（加 --purge 深度清理）

POST /api/reality/keys                     生成 Reality 密钥对
GET  /api/relay/script?to=&port=&proto=    生成中转（L4 转发）部署脚本
POST /api/demo/traffic                     注入演示流量
GET/PUT /api/settings                      站点设置
POST /api/admin/password                   修改管理员密码

GET  /api/stats?days=14                    流量明细（用户 × 日、节点 × 日、每日总计）
GET  /api/users/:id/traffic?days=30        单个用户的每日用量

GET  /api/audit?limit=200&q=&action=&before= 审计日志（关键字 / 类型 / 翻页）

GET  /api/backups                          备份列表 + 库大小
POST /api/backups                          立即备份（VACUUM INTO）
POST /api/backups/restore                  恢复（JSON {file} 或 octet-stream 上传 .db）
GET  /api/backups/:file/download           下载备份
DELETE /api/backups/:file                  删除备份

GET  /api/notify/channels                  渠道列表（含事件定义、默认格式、最近日志、未恢复告警）
POST /api/notify/channels                  新增渠道
PUT  /api/notify/channels/:id              修改渠道（密钥字段留空/脱敏值 = 不修改）
DELETE /api/notify/channels/:id            删除渠道
POST /api/notify/test                      给指定渠道发一条测试消息
PUT  /api/notify/settings                  通知开关 / 关注事件 / 阈值
POST /api/notify/sweep                     立刻巡检一次（等同定时任务）

GET  /api/agent/config?token=TOKEN&ip=IP   拉配置（JSON，调试用）
GET  /api/agent/bundle?token=TOKEN&ip=IP   拉配置包（shell 脚本；带 hash 且未变时只回 #UNCHANGED）
GET  /api/agent/script?token=TOKEN&v=版本  拉 agent 脚本（自更新用，会校验版本号）
POST /api/agent/report?token=TOKEN&ip=IP   上报流量（JSON 或纯文本「email 上行 下行」/「node:ID 上行 下行」）
POST /api/agent/receipt?token=TOKEN        回执：这一轮应用的 hash、重载结果、实例数与 agent 版本
```

`/api/agent/bundle` 是 shell agent 的主通道：把证书、Xray 配置、Hysteria2 配置、
运行状态全部编译进一段可执行脚本，agent 侧只做 base64 解码和写文件 ——
所以节点上不需要 Node，也不需要 jq 这类 JSON 工具。

---

## 十、目录结构

```
node-panel/
├── server.js            HTTP 服务、路由、业务逻辑
├── lib/
│   ├── store.js         数据层（SQLite，内置 node:sqlite + 内存读缓存）
│   ├── agentBundle.js   把配置编译成 shell 配置包下发给 agent
│   ├── xray.js          节点 → Xray 配置（含 Reality / Vision 流控 / VLESS Encryption）
│   ├── hysteria.js      节点 → Hysteria2 配置
│   ├── cert.js          TLS 证书三种来源的路径解析
│   ├── sub.js           分享链接 / Base64 / Clash 订阅生成
│   ├── notify.js        通知渠道（webhook / Telegram / 邮件）+ 载荷格式 + 发送日志
│   ├── smtp.js          手写 SMTP 客户端（TLS / STARTTLS / AUTH LOGIN / PLAIN）
│   ├── alerts.js        告警巡检与去重（按 key + 冷却时间 + 恢复通知）
│   ├── keys.js          x25519 密钥对生成
│   └── yaml.js          YAML 序列化
├── public/
│   ├── index.html       管理台外壳（菜单可收起）
│   ├── theme.js         日间/夜间皮肤切换（CSS 变量 + localStorage）
│   ├── js/              管理台脚本（经典脚本，按视图拆分，仍然零构建）
│   │   ├── core.js        工具 / 请求封装 / 弹窗 / 登录 / 导航
│   │   ├── overview.js    概览（统计卡片 + 流量曲线 + 告警）
│   │   ├── users.js       用户（列表、额度继承、已用流量）
│   │   ├── plans.js       套餐（额度 / 有效期 / 自动续期）
│   │   ├── nodes.js       节点（协议 / Reality / 证书 / 中转入口）
│   │   ├── servers.js     服务器 + 卸载命令
│   │   ├── stats.js       流量明细（每日柱状图 + 用户/节点排行 + 单人曲线）
│   │   ├── audit.js       审计日志（检索 / 类型筛选 / 翻页）
│   │   └── main.js        设置（站点 / 安全 / 通知 / 备份）/ 事件委托 / 启动
│   ├── sub.html/sub.js  用户订阅页（按 UA 推荐客户端 + 一键导入）
│   ├── invite.html/js   邀请领取页（填名字 → 建号 → 给订阅地址）
│   └── style.css        样式（主题变量在文件顶部）
├── agent/
│   └── agent.sh         服务器端 agent（纯 shell，零运行时依赖）
├── test/
│   ├── smoke.js        端到端冒烟测试（后端接口 + 通知 + 明细，零依赖）
│   ├── renew.js        自动续期单元测试（临时库）
│   ├── security.js     强制改密 / 登录限流 / 升级前备份（自带独立实例）
│   ├── notify.js       通知通道（假 SMTP + 假 HTTP，含告警去重与恢复）
│   ├── agent.js        agent 自更新（假面板 + 真 agent.sh）
│   └── ui.js           前端行为测试（需要 jsdom）
├── .github/            CI（测试 → 多架构构建 → 推 ghcr.io）、Issue / PR 模板
├── LICENSE / CHANGELOG.md / CONTRIBUTING.md / SECURITY.md
├── Dockerfile
├── docker-entrypoint.sh 容器入口：修数据目录属主后降权到 node 用户
├── docker-compose.yml
└── data/panel.db        运行时生成，全部数据都在这里（SQLite）
```

数据全在 `data/panel.db` 一个文件里。热备份用 SQLite 自带命令最稳（会一并处理 WAL）：

```bash
sqlite3 data/panel.db ".backup /path/backup-$(date +%F).db"
```

直接拷文件时要连同 `panel.db-wal`、`panel.db-shm` 一起拷，或者先停服务。
更省事的是面板自带的「设置 → 备份与恢复」，它用 `VACUUM INTO`，WAL 会一并处理。

---

## 十一、测试

```bash
# 单元 / 端到端（不需要先起服务，用临时库，不碰正式数据）
node test/hosts.js                      # 前后端共享的域名校验（require 与 <script> 两条加载路径）
node test/renew.js                      # 自动续期
node test/security.js                   # 强制改密 / 登录限流 / 升级前备份（自带独立实例）
node test/notify.js                     # 通知通道（假 SMTP + 假 HTTP）
node test/agent.js                      # agent 自更新（假面板 + 真 agent.sh）

# 接口冒烟 + 前端行为（需要先起面板）
#   注意：用非出厂密码启动，否则业务接口会被强制改密拦住
PANEL_DATA_DIR=./.test PORT=8080 PANEL_ADMIN_PASSWORD=test-pass-123 node server.js &
PANEL_ADMIN_PASSWORD=test-pass-123 node test/smoke.js http://127.0.0.1:8080
PANEL_ADMIN_PASSWORD=test-pass-123 node test/ui.js    http://127.0.0.1:8080   # 需要 jsdom
PANEL_ADMIN_PASSWORD=test-pass-123 node test/browser.js http://127.0.0.1:8080 # 需要本机 Chrome/Edge
```

`browser.js` 起一个 headless Chrome，用调试协议打真实鼠标/键盘事件（不是 jsdom 模拟）：
登录、用户检索与批量、批量建号、邀请生成与落地页领取、订阅页、节点回执、备份、
审计过滤、上传 `.db` 恢复，并顺带收集控制台报错与失败请求。
找不到 Chrome 会自动跳过（可用 `CHROME_PATH` 指定路径）。

`smoke.js` 覆盖：健康检查 → 残留清理 → 存量数据自检 → 建服务器 → 五种节点 → 套餐（额度/有效期/自动续期）→ 三类用户 →
额度与到期继承及套餐变更同步 → 订阅与配置双层套餐隔离 → Reality / Hysteria2 链接与配置 →
VLESS Encryption → uTLS 指纹 → 证书四态（路径 / 粘贴 / 自签 / ACME）→
中转入口多端点发布、入口级套餐、入口与节点独立显隐 → 超额自动剔除 →
部署脚本与鉴权 → agent 自更新脚本（版本替换 / token 校验）→ 公网 IP 上报（手动不覆盖 / 自动生效）→
节点维度流量明细 → 通知渠道（增删改、脱敏回填、非法地址 400、测试发送、发送日志）→
批量建号（数量 / 名单、去重、超长跳过、套餐继承）→ 批量操作（启停 / 改套餐 / 重置 / 删除、管理员保护）→
邀请（生成 / 公开信息 / 领取 / 重名 409 / 名额用尽 410 / 停用）→
回执（未回执 → 已同步 → 待同步 → 同步失败、节点继承服务器状态、token 校验）→
备份（创建 / 列表 / 下载 / 路径穿越 400 / 恢复 / 恢复前兜底 / 会话失效 / 上传非 SQLite 拒绝 / 删除）→
审计（关键字、类型、翻页、操作者与 IP）→ 自动清理。

`renew.js` 覆盖自动续期的边界：默认开启、永久与自定义到期强制关闭、未到期不打扰、
到期重置流量并顺延、重复扫描不重复续、改套餐额度不覆盖续期结果、落库重载一致、
停机多期一次推进到未来、关闭续期的用户到期即停、自然月锚点（1-31 → 2-28 → 3-31）。

`ui.js` 用 jsdom 真实跑一遍前端：日间/夜间皮肤切换（管理台 + 订阅页、刷新后保持）、
接口 loading 锁（连点只发一次请求、弹窗按钮显示「处理中」）、订阅对外域名校验（填错不发请求）、
套餐自动续期开关（默认勾选、自定义/永久时禁用、提交体正确）、侧栏版本号、
通知设置卡片（六个事件、总开关、参数回填、渠道表单随类型切换字段、
点「测试」真的打出一个 webhook 并校验载荷与发送记录）、
用户检索与筛选（名字 / 状态 / 空态、计数）、勾选与批量条（累加、全选、取消、批量停用真的落库）、
邀请弹窗（生成、列表、操作按钮、参数落到后端）、节点同步徽标与回执详情、
设置页备份卡片（立即备份后多一行）、审计页（动作徽标、中文动作名、搜索与类型筛选）、
邀请领取页（展示名额、填名字领取、成功后给订阅地址、无效码提示）、
拆分后八个页面都能渲染。

`notify.js` 起一对**假服务**（SMTP 服务器 + HTTP 接收端），覆盖：SMTP 明文/TLS 分支的
AUTH LOGIN 与 PLAIN、535 认证失败的错误透传、多收件人解析、RFC 2047 中文标题、
base64 正文可解码、点号转义（`\r\n.` → `\r\n..`）不会提前结束 DATA、
五种 webhook 载荷格式、Telegram 路径与 HTML 转义、发送失败会记日志并返回原因、
告警去重与冷却、恢复通知、复现后再触发、离线服务器告警、从未上报的机器不误报、总开关关闭时不动。

`agent.js` 用**真 agent.sh** 对一个假面板跑四轮：拿到新版本后替换脚本、留 `.bak`、
记事到日志、清掉失败计数、不重复下载、`--version` 自报新版本；
回执内容（hash / ok / 版本 / 节点数）正确且状态没变时不重复发；
坏包（版本对不上）被拒且计数 +1；计数到 3 后不再尝试。

所有测试都幂等：`smoke.js` 启动时先清理上次崩溃残留的 `SMOKE-*` / `UI-*` 数据，
`ui.js` 会把自己建的渠道删掉并还原通知参数。

`security.js` 会自己拉起一个**独立实例**（临时库 + 出厂密码），覆盖：出厂密码登录后被要求改密、
改密前业务接口 403、改密校验（长度 / 不能是出厂密码）、改密后旧会话与旧密码立即失效、
登录失败 5 次后 429 且带 `Retry-After`、老库重新启动时生成升级前备份。

三套测试都是幂等的：`smoke.js` 启动时先清理上次崩溃残留的 `SMOKE-*` / `UI-*` 数据。

## 十二、界面适配

管理台为宽屏优先设计，内容区不设上限，栅格自动流动：

- 统计卡片 `auto-fit minmax(196px, 1fr)`，宽屏自动横向铺开
- 两栏区在窄于约 1100px 时自动堆叠
- 侧边栏可收起（状态存 localStorage），移动端强制展开并横向滚动
- 表格区域横向滚动，不撑破布局

用户订阅页为阅读优先，内容区限制在 680px 并居中。

### 日间 / 夜间皮肤

全站可切换皮肤，**默认夜间（黑底白字）**，可切成日间（白底黑字）。管理台和用户订阅页共用同一个
选择，存 `localStorage` 的 `np_theme`，换设备不会同步但也不会互相覆盖。

- 管理台：右上角工具栏的 ☀ / ☾ 按钮（未登录时登录页右上角也有一个）
- 订阅页：标题栏右侧

实现方式是「一套变量、两套取值」：所有颜色都收在 `style.css` 顶部的 CSS 变量里，
切换只改 `<html data-theme="dark|light">`，**不重排、不闪烁**，
订阅页的环形图也改用 `var(--accent)` 之类的变量上色，所以跟着自动变。
首屏配色由 `<head>` 里一小段内联脚本先定好，避免打开时闪一下默认色。

```css
:root { --bg: #070a0f; --text: #e9eff8; }              /* 夜间 */
:root[data-theme='light'] { --bg: #f4f6fb; --text: #17202e; }  /* 日间 */
```

新加样式时请只写变量，不要再写死色值——否则换肤会漏出破绽。

---

## 十三、Docker 部署

```bash
# 直接拉镜像（beta 版本线 0.1.x）
docker run -d --name node-panel -p 8080:8080 \
  -e PANEL_ADMIN_PASSWORD='换成强密码' \
  -v node-panel-data:/app/data \
  ghcr.io/sola614/node-panel:0.1

# 或用 compose（默认也是 :0.1，可用 PANEL_IMAGE_TAG=0.1.1 精确锁定）
PANEL_IMAGE_TAG=0.1.1 docker compose up -d
```

数据持久化在 `/app/data` 卷里（`panel.db` + WAL）。镜像已内置 `/api/health` 探针。
镜像基线是 `node:24-alpine`（Active LTS，维护到 2028-04）。
自建部署需要 **Node.js 22.13+**（内置 `node:sqlite` 从该版本起免 flag 可用）。

#### 数据目录：命名卷 vs 绑定挂载

两种写法都可以，入口脚本会自行处理属主，不必手动 chown：

```bash
# 命名卷：最省心，Docker 自动沿用镜像里的属主
docker run -d -v node-panel-data:/app/data ...

# 绑定挂载：数据落在宿主机 ./data，方便直接 sqlite3 备份
mkdir -p ./data
docker run -d -v "$PWD/data:/app/data" ...
```

绑定挂载有个坑：Docker **不会**把镜像里的属主复制到宿主机目录，`./data` 会是 root 所有，
而容器默认以 `node` 用户运行，于是 SQLite 报 `unable to open database file`。
所以 `docker-entrypoint.sh` 会以 root 起步，把数据目录 chown 给 node 后再用 `su-exec` 降权跑面板
（官方 postgres/mysql 镜像也是这个套路）。如果你用 `--user` 覆盖了运行身份、导致目录不可写，
入口脚本会直接给出可操作提示，而不是甩一句看不懂的 SQLite 报错。

#### 排错：`unable to open database file`

就是这个属主问题。三种解法：

```bash
# 1. 让入口脚本自己修（推荐，换个带 docker-entrypoint.sh 的镜像版本即可）
docker compose pull && docker compose up -d

# 2. 手动把宿主机目录交给容器里的 node 用户（uid 1000）
mkdir -p ./data && sudo chown -R 1000:1000 ./data

# 3. 改用命名卷，属主由 Docker 自动处理
```

可以用这条命令确认容器里的实际身份和目录权限：

```bash
docker run --rm -v "$PWD/data:/app/data" --entrypoint sh ghcr.io/sola614/node-panel:0.1 \
  -c 'id; ls -ld /app/data; touch /app/data/.w && echo "可写 ✓"'
```

### 镜像版本号

版本号**只有一处来源**：`package.json` 的 `version`。每次 `main` 推送都会打上对应 tag：

| tag | 含义 |
| --- | --- |
| `0.1.0` | 完整版本号 |
| `0.1` | 次版本线，浮动跟踪（`docker run` 推荐用这个） |
| `latest` | 最近一次 `main` 构建 |
| `main` | 分支 tag，便于调试 |

发版时打 Git tag（`git tag v0.1.1 && git push origin v0.1.1`）会额外产出 semver tag。
版本号同时写进镜像的 `org.opencontainers.image.version` label、`/api/health` 的 `app` 字段，
以及管理台侧栏底部的「v0.1.0」字样——三处看到的永远一致。

推送到 GitHub 后，`main` 分支的推送和 `v*` 标签会自动触发构建，
产出 `linux/amd64` 与 `linux/arm64` 双架构镜像到 `ghcr.io/sola614/node-panel`。
PR 只跑测试和构建，不推送。

```yaml
# .github/workflows/docker.yml 关键步骤
- name: 读取版本号              # 从 package.json 解析，读不到就中止
- uses: docker/metadata-action@v5
  with:
    tags: |
      type=raw,value=${{ steps.pkg.outputs.version }}   # 0.1.0
      type=raw,value=${{ steps.pkg.outputs.minor }}     # 0.1
- uses: docker/build-push-action@v6
  with:
    build-args: |
      APP_VERSION=${{ steps.pkg.outputs.version }}
```

### 升级到新版本

版本线是 `0.1.x`，每次发布递增末位。升级只换镜像，**数据不用动**。

```bash
docker compose pull && docker compose up -d
```

裸机部署则是：

```bash
git pull && npm test && systemctl restart node-panel
```

升级时会发生什么：

| 动作 | 说明 |
| --- | --- |
| 自动备份 | 检测到库的 schema 版本落后，先用 `VACUUM INTO` 导出 `data/backups/panel-v<旧版本>-<时间戳>.db`，只留最近 5 份 |
| 自动迁移 | 启动时补列、补默认值（**只做加法**），`meta.version` 随之更新 |
| 会话 | 存在内存里，重启后需要重新登录（密码不变） |
| agent | 配置变化随下一轮心跳（≤60 秒）自动生效。若 agent 脚本本身有更新，重跑一次部署命令即可 —— 脚本幂等，不会丢配置、不用重建记录 |

想更稳妥就手动再备一份：

```bash
sqlite3 data/panel.db ".backup backup-$(date +%F).db"
```

**回滚**：停容器 → 把备份文件拷回 `data/panel.db`（同时删掉同目录的 `-wal` / `-shm`）→ 换回旧镜像启动。

---

## 十四、生产部署建议

### systemd 常驻面板

```ini
# /etc/systemd/system/node-panel.service
[Unit]
Description=Node Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/node-panel
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=8080
Environment=PANEL_ADMIN_PASSWORD=换成你的强密码

[Install]
WantedBy=multi-user.target
```

### Nginx 反代 + HTTPS

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

`X-Forwarded-Proto` 会被用来生成订阅链接的协议头，别忘了。

### 安全清单

- [x] 出厂密码会**强制**改掉（≥8 位、不能还是 `admin888`），改密前业务接口全拦
- [x] 登录失败限流：同一 IP 10 分钟内 5 次失败锁 10 分钟
- [ ] 面板走 HTTPS，不要裸 HTTP 暴露在公网
- [ ] 尽量别把面板直接暴露在公网，前面加一层反代 + 访问控制（IP 白名单 / Basic Auth / VPN）
- [ ] 部署脚本 URL 里带 token，属于敏感信息，别贴到公开渠道
- [ ] 重置服务器/节点 token 后，对应 agent 立即失效，需要重新部署
- [ ] `data/panel.db` 含所有用户 UUID 和 token，注意备份权限（连同 `-wal`/`-shm` 一起备份，或用 `sqlite3 panel.db ".backup out.db"`）

> 登录限流按 `X-Forwarded-For` 判断来源。面板**直接**暴露在公网时这个头可以被伪造，
> 请在前置反代里**覆盖**该头（`proxy_set_header X-Forwarded-For $remote_addr`），而不是追加。

---

## 十五、日志与排查

面板、agent 都**只往 stdout / stderr 打日志**，不写文件 —— 轮转交给 systemd / journald / Docker。

### 一行日志长什么样

```
2026-10-24 00:19:50.161 +08:00  WARN   http  请求被拒绝 rid=0470b8 method=GET path=/api/users status=401 ms=3 ip=127.0.0.1
2026-10-24 00:23:18.770 +08:00  INFO   alerts 告警通知已触发 events=2 sent=2 kinds=server.offline,agent.old
```

- **时间带时区偏移**：看日志不用心算 UTC。
- **级别**：`ERROR` / `WARN ` / `INFO ` / `DEBUG`。只有 `ERROR` 走 stderr，
  所以 `journalctl -p err` 能干净地只捞出真出错的行（`PANEL_LOG_LEVEL` 详见下）。
- **scope**：`http`（请求）/ `auth`（登录改密）/ `agent`（上报、回执、配置包）/
  `data`（备份恢复、批量操作）/ `store`（数据库）/ `notify` / `alerts` / `bundle`。
- **`rid`**：六位请求号。同一次请求里 handler、慢请求、异常三条日志靠它串起来，
  排查时先 grep 一个 rid 就能看到完整链路。

### 调级别

```bash
PANEL_LOG_LEVEL=debug node server.js          # 默认 info，debug 会打开请求级细节
```

也可以写数字 `0=error … 3=debug`。**不要**常态开 debug：每个请求都会多打一行。

慢请求阈值默认 1000ms，可用 `PANEL_SLOW_MS=300` 调。

### 会记什么

| 场景 | 级别 | 关键字段 |
| --- | --- | --- |
| 请求 5xx / 4xx / 慢 | error / warn / warn | `rid` `path` `status` `ms` `ip` |
| 登录失败、被限流、改密 | warn | `rid` `user` `ip` `left` |
| 出厂密码未改，拦截业务请求 | warn | `rid` `path` `user` |
| agent token 无效 | warn | `rid` `ip` `agentVersion` |
| 配置包下发 / 回执状态变化 | info | `scope` `hash` `from` `nodes` `unbound` |
| 流量上报一条都没匹配上 | warn | `scope` `rows` `sample` |
| 备份 / 恢复每一步 | info / error | `from` `safety` `users` `ms` |
| 续期、schema 升级前备份 | info / error | `users` `from` `to` |
| 通知发送失败 | error | `channel` `type` `title` `error` |
| 未捕获异常 / 未处理拒绝 | error | `err`（含堆栈首行） |

刻意**不**高频记的东西：agent 心跳（只记「状态变了」）、每轮成功的回执、
每次 `save()`（只在 >200ms 时 warn）。

### 不会记什么

每条日志在输出前都要过一遍脱敏（日志经常被整段贴进 issue）：

- key 名命中 `token` / `password` / `secret` / `private` / `authorization` … → 整段 `***`
- 值里嵌的 `token=xxx`、`Bearer xxx`、`"password":"xxx"` → 替换成 `***`
- 订阅 / 邀请链接里的凭证段 → `/s/***`、`/i/***`

所以**批量建号只记数量不记 token、邀请只记前 4 位码、默认不在启动横幅里打订阅链接**
（要完整链接就 `PANEL_LOG_LEVEL=debug`）。加新日志时沿用同一条规矩：
记「发生了什么」而不是「数据本身」。

agent 侧同理：`state.env`、配置内容、私钥都不进日志，只记 hash 与变更项
（`✓ 配置已更新（hash 496ce804…，变更：Xray）`）。

### 常用排查命令

```bash
journalctl -u node-panel -p err -n 50              # 只看错误
journalctl -u node-panel --since '10 min ago' | grep rid=9f2c1a
journalctl -u node-panel --since today | grep -i 'unbound\|端口未监听'
docker logs --tail 200 node-panel 2>&1 | grep WARN
```

端口不通这类问题另见 [docs/troubleshoot-port.md](docs/troubleshoot-port.md)。

---

## 十六、已知限制

1. **SS 节点是单用户模式**：Xray 的 shadowsocks 入站不支持多用户，所有用户共用同一密码，无法按用户计费。要精确计费请用 VLESS / VMess / Trojan。
2. **流量上报是增量式**：上报请求丢了这一分钟的流量就丢了。要对账严格需改成累积值 + 服务端去重。
3. **会话存在内存**：面板重启后管理员需要重新登录。
4. **单管理员**：没有多账号和权限体系。
5. **TLS 证书要自己准备**：面板不签发证书，只把路径写进配置（Reality 除外）。
6. **公网 IP 探测依赖外部服务**：agent 全部 provider 失败时会沿用上一次的结果；机器在 NAT 后且需要内网穿透时，请改回手动填写。
7. **VLESS Encryption 需要两端都是 Xray 25.6.0+**：客户端不支持时该节点连不上，建议按需开启而不是全局打开。
8. **自签证书依赖 openssl**：`certMode: self` 时由 agent 在目标机用 openssl 现场生成；Debian/Ubuntu/CentOS 自带，
   Alpine 需要 `apk add openssl`。其他证书模式（path / content / acme）不需要。
9. **ACME 走 standalone 模式**：会占用 80 端口，且机器必须能访问外网；80 被占用或域名没解析到本机会申请失败，日志里会说明原因。
10. **agent 每轮会 fork 若干子进程**：`sed`/`awk`/`base64` 用完即退，不会常驻；极端低配（32MB 以下）建议把 `INTERVAL` 调大到 120。
11. **通知只有三种通道**：webhook / Telegram / 邮件。没有短信、没有 App 推送；邮件只支持账号密码认证，
    Gmail 这类要 OAuth2 的得改用「应用专用密码」，不能直接走网页登录授权。
12. **告警巡检是单进程的**：面板只能起一个实例（本来也只该起一个），多实例共用一个库会重复发通知。
13. **节点维度用量依赖 agent 版本**：面板升级后要等 agent 自更新完成（一轮心跳）才开始上报 `node:` 行，
    那之前「流量」页的节点排行是空的。

### 非目标

不是「还没做」，是**想清楚了不做**。这个项目的定位是「三五十人合租用的最小控制平面」，
下面这些方向会把维护成本抬到一个自用项目撑不住的高度：

| 不做 | 原因 |
| --- | --- |
| 支付 / 订单 / 优惠码 / 邀请返利 | 熟人合租转账即可。引入订单流会把「共享资源」变成「商业服务」，责任边界反而更复杂 |
| 多租户（一套面板卖多家） | 与「最小控制平面」直接冲突，外部已有成熟方案 |
| 内建 L7 中转、DNS 分流管理 | 同上。现有 L4 中转已覆盖绝大多数场景，且流量仍记在落地节点 |
| 在线 IP / 设备数限制 | 需要 agent 采集在线 IP、依赖较新 Xray 接口，误判会误杀正常用户；几十人合租也无防共享动机 |
| 用户级 / 节点级带宽限速 | Xray **没有**原生 per-user 带宽限速，只能靠 `tc`/eBPF，脏且易误伤。这个规模下「看得见用量」比「限速」更有效 |
| 白标 / 多语言 | 单站点自用没有价值 |
| 短信 / App 推送 | 要走第三方网关或自建推送服务，成本与可靠性都不如一个群机器人；现有 webhook 已能接进任何告警平台 |
| 工单系统 | 有问题在群里说一句更快 |

如果你确实需要其中某项，说明你要的其实是另一个产品（V2Board 那类），本项目不适合改造成它。

---

## 许可

MIT，见 [LICENSE](LICENSE)。安全问题请按 [SECURITY.md](SECURITY.md) 走私密渠道，参与开发先看 [CONTRIBUTING.md](CONTRIBUTING.md)。
