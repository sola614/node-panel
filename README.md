# 节点管理面板

一个能跑起来的最小可用控制平面：**面板管数据，服务器上的 agent 管执行，用户看订阅页**。

零外部依赖，只用 Node.js 标准库，`node server.js` 就能跑。

```
┌─────────────┐   管理操作    ┌──────────────┐
│  管理面板    │ ───────────▶ │   面板服务    │
│  (浏览器)    │              │  server.js   │
└─────────────┘              │  plans       │
┌─────────────┐   订阅链接    │  users       │
│  用户订阅页  │ ◀─────────── │  nodes       │
└─────────────┘              │  servers     │
                             └──────┬───────┘
                                    │ ① 拉配置 (60s) + 上报公网 IP
                                    │ ② 报流量 (60s)
                             ┌──────▼───────┐
                             │  agent.js    │ ← 部署在每台节点服务器
                             │  Xray        │
                             │  Hysteria2×N │
                             └──────────────┘
```

---

## 一、快速开始

```bash
cd node-panel
node server.js          # 或 npm start
```

打开 http://localhost:8080 ，默认账号 **admin / admin888**（登录后请在「设置」里改掉）。

首次启动会自动写入一份演示数据（2 台服务器 / 6 个节点 / 3 个套餐 / 4 位用户），方便直接看效果。
想从空白开始：

```bash
PANEL_SEED=0 node server.js
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PANEL_ADMIN_USER` | `admin` | 初始管理员账号（仅首次生成数据时生效） |
| `PANEL_ADMIN_PASSWORD` | `admin888` | 初始密码 |
| `PANEL_DATA_DIR` | `./data` | 数据文件目录 |
| `PANEL_SEED` | `1` | 设为 `0` 时不写入演示数据 |

---

## 二、核心概念

### 套餐（权限组）

套餐只定义两件事：**流量额度**和**有效期**。节点反向声明归属哪些套餐，用户绑定套餐。

```
plan    → { 名称, 流量额度 GB, 有效期天数 }
node    → { planIds: [...] }   多选，可同属多个套餐
user    → { planId }           额度与到期自动继承套餐，用户侧不可修改
```

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
`/etc/hysteria/node-<id>.yaml`，并用 systemd 模板单元 `nodepanel-hysteria@node-<id>` 拉起独立实例，
所以**一台机器可以跑多个 Hysteria2 节点**。流量通过每实例的 `trafficStats` 接口按用户名归属。
部署脚本检测到 Hysteria2 节点时会顺带安装 hysteria。
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
curl -fsSL "http://面板/api/servers/<id>/install?token=<服务器token>" | sudo bash

# 独立节点
curl -fsSL "http://面板/api/nodes/<id>/install?token=<节点token>" | sudo bash
```

脚本会做这些事：

1. 检查 Node.js ≥ 18
2. 把 agent 装到 `/opt/nodepanel/agent.js`
3. 写入 `/opt/nodepanel/agent.env`
4. 注册 systemd 服务 `nodepanel-agent` 与模板单元 `nodepanel-hysteria@`
5. 如果该机有 Hysteria2 节点且未装 hysteria，顺手装上

**前置条件**：Xray 需要自己装，agent 只负责写配置和重启服务。

```bash
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
```

### 4. 之后的一切都是自动的

agent 每 60 秒执行一次：

- 探测公网 IP，`GET /api/agent/config?token=...&ip=...` 拉配置
- 配置哈希变了才落盘并重载；Hysteria2 多实例同步启停
- 从 Xray StatsService 和各 Hysteria2 实例读流量，`POST /api/agent/report` 上报

在面板里加节点、改端口、停用用户，**最多 60 秒自动生效，不用再登服务器**。

```bash
journalctl -u nodepanel-agent -f              # agent 日志
systemctl status nodepanel-hysteria@node-xxx  # 某个 Hysteria2 实例
```

---

## 四、流量与额度

### 统计口径

- Xray 用户 email 固定为 `u<用户ID>`，Hysteria2 用户名同样为 `u<用户ID>`（密码 = 用户 UUID）
- 统计 = 上行 + 下行（双向都算）
- agent 读取**增量**后上报，面板累加到 `usedBytes`

### 超额会发生什么

额度用完后状态变为「超量」，然后：

1. 下一次 agent 拉配置时，**该用户从所有节点的 clients / userpass 列表里消失**
2. 用户订阅返回空列表
3. 客户端下次重连直接失败

配置级硬隔离，不靠客户端自觉。过期、手动停用同理。

### 演示流量

「概览」页右上角「模拟流量」按钮可给用户注入随机流量，方便观察额度闸门。

---

## 五、用户订阅

| 地址 | 内容 |
| --- | --- |
| `/s/<token>` | 浏览器打开 → 订阅页面（流量环、节点列表、一键导入） |
| `/s/<token>?format=base64` | Base64 节点链接（通用订阅格式） |
| `/s/<token>?format=clash` | Clash / Mihomo YAML（含 reality-opts、hysteria2） |
| `/s/<token>?format=json` | 结构化数据 |

响应带 `Subscription-Userinfo` 头，Clash Verge 等客户端能直接读到已用/总量/到期时间。

「设置 → 订阅对外域名」留空则按当前访问 Host 生成；面板在反代后面时建议显式填写。

---

## 六、接口一览

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

GET  /api/nodes                            节点列表
POST /api/nodes                            新增节点
PUT  /api/nodes/:id                        修改节点
DELETE /api/nodes/:id                      删除节点
GET  /api/nodes/:id/preview                查看生成的配置（Xray / Hysteria2）
POST /api/nodes/:id/rotate                 重置独立节点 token
GET  /api/nodes/:id/install?token=         独立节点部署脚本

GET  /api/servers                          服务器列表
POST /api/servers                          新增服务器
PUT  /api/servers/:id                      修改服务器
DELETE /api/servers/:id                    删除服务器
POST /api/servers/:id/rotate               重置服务器 token
GET  /api/servers/:id/install?token=       服务器部署脚本

POST /api/reality/keys                     生成 Reality 密钥对
GET  /api/relay/script?to=&port=&proto=    生成中转（L4 转发）部署脚本
POST /api/demo/traffic                     注入演示流量
GET/PUT /api/settings                      站点设置
POST /api/admin/password                   修改管理员密码

GET  /api/agent/config?token=TOKEN&ip=IP   拉配置（服务器或独立节点 token）
POST /api/agent/report?token=TOKEN&ip=IP   上报流量
```

---

## 七、目录结构

```
node-panel/
├── server.js            HTTP 服务、路由、业务逻辑
├── lib/
│   ├── store.js         数据层（JSON 文件 + 原子写入 + 版本迁移）
│   ├── xray.js          节点 → Xray 配置（含 Reality / Vision 流控 / VLESS Encryption）
│   ├── hysteria.js      节点 → Hysteria2 配置
│   ├── cert.js          TLS 证书三种来源的路径解析
│   ├── sub.js           分享链接 / Base64 / Clash 订阅生成
│   ├── keys.js          x25519 密钥对生成
│   └── yaml.js          YAML 序列化
├── public/
│   ├── index.html       管理台外壳（菜单可收起）
│   ├── app.js           管理台单页应用
│   ├── sub.html/sub.js  用户订阅页
│   └── style.css        样式（深色）
├── agent/
│   └── agent.js         服务器端 agent（双服务管理）
├── test/
│   └── smoke.js         端到端冒烟测试（53 项）
├── .github/workflows/   GitHub Actions：测试 → 多架构构建 → 推 ghcr.io
├── Dockerfile
├── docker-compose.yml
└── data/db.json         运行时生成，全部数据都在这里
```

数据就是一个 JSON 文件，备份直接拷 `data/db.json`。

---

## 八、测试

```bash
node test/smoke.js http://127.0.0.1:8080
```

89 项断言，覆盖：健康检查 → 残留清理 → 存量数据自检 → 建服务器 → 五种节点 → 套餐（额度/有效期）→ 三类用户 →
额度与到期继承及套餐变更同步 → 订阅与配置双层套餐隔离 → Reality / Hysteria2 链接与配置 →
VLESS Encryption → uTLS 指纹 → 证书四态（路径 / 粘贴 / 自签 / ACME）→
中转入口多端点发布、入口级套餐、入口与节点独立显隐 → 超额自动剔除 →
部署脚本与鉴权 → 公网 IP 上报（手动不覆盖 / 自动生效）→ 自动清理。

测试是幂等的：启动时会先清理上次崩溃残留的 `SMOKE-*` 数据。

## 九、界面适配

管理台为宽屏优先设计，内容区不设上限，栅格自动流动：

- 统计卡片 `auto-fit minmax(196px, 1fr)`，宽屏自动横向铺开
- 两栏区在窄于约 1100px 时自动堆叠
- 侧边栏可收起（状态存 localStorage），移动端强制展开并横向滚动
- 表格区域横向滚动，不撑破布局

用户订阅页为阅读优先，内容区限制在 680px 并居中。

---

## 十、Docker 部署

```bash
# 直接拉镜像
docker run -d --name node-panel -p 8080:8080 \
  -e PANEL_ADMIN_PASSWORD='换成强密码' \
  -v node-panel-data:/app/data \
  ghcr.io/sola614/node-panel:latest

# 或用 compose
docker compose up -d
```

数据持久化在 `/app/data` 卷里。镜像已内置 `/api/health` 探针。

推送到 GitHub 后，`main` 分支的推送和 `v*` 标签会自动触发构建，
产出 `linux/amd64` 与 `linux/arm64` 双架构镜像到 `ghcr.io/sola614/node-panel`。
PR 只跑测试和构建，不推送。

```yaml
# .github/workflows/docker.yml 关键步骤
- uses: docker/setup-qemu-action@v3
- uses: docker/setup-buildx-action@v3
- uses: docker/login-action@v3      # ghcr.io + GITHUB_TOKEN
- uses: docker/metadata-action@v5
- uses: docker/build-push-action@v6
  with:
    platforms: linux/amd64,linux/arm64
```

---

## 十一、生产部署建议

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

- [ ] 改掉默认密码（`admin888`）
- [ ] 面板走 HTTPS，不要裸 HTTP 暴露在公网
- [ ] 部署脚本 URL 里带 token，属于敏感信息，别贴到公开渠道
- [ ] 重置服务器/节点 token 后，对应 agent 立即失效，需要重新部署
- [ ] `data/db.json` 含所有用户 UUID 和 token，注意备份权限

---

## 十二、已知限制

1. **SS 节点是单用户模式**：Xray 的 shadowsocks 入站不支持多用户，所有用户共用同一密码，无法按用户计费。要精确计费请用 VLESS / VMess / Trojan。
2. **流量上报是增量式**：上报请求丢了这一分钟的流量就丢了。要对账严格需改成累积值 + 服务端去重。
3. **会话存在内存**：面板重启后管理员需要重新登录。
4. **单管理员**：没有多账号和权限体系。
5. **TLS 证书要自己准备**：面板不签发证书，只把路径写进配置（Reality 除外）。
6. **公网 IP 探测依赖外部服务**：agent 全部 provider 失败时会沿用上一次的结果；机器在 NAT 后且需要内网穿透时，请改回手动填写。
7. **VLESS Encryption 需要两端都是 Xray 25.6.0+**：客户端不支持时该节点连不上，建议按需开启而不是全局打开。
8. **证书路径默认由面板计算**：agent 用 `CERTS_ROOT` 可覆盖，但改完需要等下一轮配置同步才会重写引用。
9. **ACME 走 standalone 模式**：会占用 80 端口，且机器必须能访问外网；80 被占用或域名没解析到本机会申请失败，日志里会说明原因。

需要更多的话，往上加的方向：多管理员与审计日志、节点级限速、月结流量重置、在线 IP 数限制、Telegram 通知。
