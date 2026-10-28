# 证书管理：面板机签发 / DNS-01 / 多机分发

> **0.1.14 已实现**。本文档是设计与取舍记录，不是实现清单 ——
> 与当前代码的差异集中列在第十四节，读之前建议先看那一节。
> 核心决策：**证书由面板所在机器统一签发，节点机器只接收与重载。**

## 零、这一版相对上一版改了什么

上一版让「某个 agent 机器」当签发机，证书签发后要**回传**面板才能分发。
改成面板机签发之后，整个回传通道消失了：

| | 上一版（agent 机器签发） | 本版（面板机签发） |
| --- | --- | --- |
| 签发执行者 | 指定一台 agent 机器 | 面板所在机器 |
| 证书如何进面板 | agent 回传 PEM（新增上报字段 + 校验） | 面板自己生成，直接读文件 |
| DNS 凭据在哪 | 签发机 `~/.acme.sh`，**出面板** | 只在面板机，**不出面板** |
| 节点要装 acme.sh | 是 | **否** |
| 新增概念 | 签发机、回传通道、签发机离线告警 | 无 |
| 续期感知 | 等 agent 下一轮上报 | 面板自己知道，当场落库 |

一句话：**少一个概念、少一条通道、少一堆节点依赖，安全面还更小。**
凭据和私钥都收敛在面板机一处，节点侧只剩「落盘 + 重载」这一件事。

代价是三条硬约束（见第二节），都可以接受。

## 一、三条硬约束（决定架构，不是可选项）

### 1. 通配符 ⇒ 只能用 DNS-01

Let's Encrypt 对含 `*` 的域名只签发 DNS-01 校验的证书。所以「申请通配符」和「接入 DNS 校验」
是同一件事，不是两个功能。UI 上不该让用户选校验方式，而是按域名自动判定：

| 用户填的域名 | 判定 | 校验 | 需要 80 端口 |
| --- | --- | --- | --- |
| `*.example.com` | 通配符 | **只能** DNS-01 | 不需要 |
| `hk1.example.com` | 单域名 | DNS-01（面板机）/ http-01（节点机） | http-01 需要 |

通配符必须**同时带裸域**：`-d '*.example.com' -d example.com`。
`*.example.com` 不覆盖 `example.com` 本身，漏了会在客户端报
`certificate is valid for *.example.com`。

### 2. 面板机签发 ⇒ 实际只支持 DNS-01

面板机通常不对外开 80 端口（Docker 只映射 8080），http-01 的验证请求进不来。
所以面板签发的证书一律走 DNS-01 —— 而这恰好就是通配符要求的校验方式，正好对齐。

存量节点上的 http-01 ACME（`certMode=acme`）**保留可用**，作为兼容路径，新流程不再新增。

### 3. 面板机必须能跑 sh + 能出网 + 数据目录要持久化

- acme.sh 是纯 shell 脚本，Linux / Alpine 容器都没问题；**Windows 上跑不了**（本地开发需优雅报错）。
- 面板机要能访问 DNS 提供商 API 与 Let's Encrypt API。
- acme.sh 的 home 必须落在持久卷里，否则容器升级后账号密钥和证书全丢。

## 二、架构

```
面板机（唯一的签发方）
├── acme.sh  home = $PANEL_DATA_DIR/acme        ← 在持久卷里，升级不丢
├── 签发队列（串行，一次一张）                    ← acme.sh 不适合并发
├── 签发/续期 → 读 fullchain+privkey → 解析 notAfter → 写 certs 表
└── 定时扫描：剩余 < 30 天 → 自动续期（复用 sweepRenewals 的 tick）

分发（完全复用现有 content 路径，agent 侧几乎零改动）
buildAgentPayload → certs[]（按 certId 去重，只含本机需要的）
   → agentBundle: np_put 0600 落盘
   → 证书变了 → 标记变更 → 重载 Xray / Hysteria2
```

### 为什么分发能「几乎零改动」

`lib/agentBundle.js:85-93` 现在就有这段：

```js
const contentCerts = certs.filter((c) => c.mode === 'content');
for (const c of contentCerts) {
  push(`np_put ${shq(c.certPath)} 600 ${shq(b64(c.certPem))}`);
  push(`np_put ${shq(c.keyPath)} 600 ${shq(b64(c.keyPem))}`);
}
```

面板签发的证书，对节点来说就是「一份 PEM 要落盘」，和 `content` 模式完全一样。
需要改的只有两处：**按 certId 去重**（同机多节点共用一张证书只落一份文件）、
**证书变更要触发重载**（见第四节最后一条，这是个容易漏的坑）。

### 证书落盘路径

从「按节点」改成「按证书」：

```
/etc/nodepanel/certs/<certId>/fullchain.pem
/etc/nodepanel/certs/<certId>/privkey.pem
```

一台机器上 5 个节点引用同一张通配符证书 → 只落 1 份文件，而不是 5 份。

## 三、数据模型

```sql
CREATE TABLE certs (
  id            TEXT PRIMARY KEY,
  name          TEXT,              -- 显示名，默认取主域名
  domains       TEXT,              -- JSON：["*.example.com","example.com"]
  wildcard      INTEGER DEFAULT 0,
  challenge     TEXT,              -- 'dns-01'（面板签发固定这个）
  provider      TEXT,              -- 'cloudflare'|'aliyun'|'dnspod'|'huaweicloud'|'manual'
  creds         TEXT,              -- JSON，只写不读（见第五节）
  status        TEXT,              -- draft|issuing|issued|failed|expiring|expired
  cert_pem      TEXT,
  key_pem       TEXT,
  fingerprint   TEXT,              -- sha256，判断是否续期过
  not_after     TEXT,              -- ISO 时间
  last_attempt  TEXT,
  last_error    TEXT,
  auto_renew    INTEGER DEFAULT 1,
  extra_targets TEXT,              -- JSON：手动追加的分发目标（没有节点引用的机器）
  created_at    TEXT
);
```

节点表加一列 `cert_id`，`certMode` 语义收窄：

| certMode | 含义 | 谁签发 | 有无生命周期 |
| --- | --- | --- | --- |
| `self` | agent 现场 openssl 自签 | 节点机 | 无（10 年、节点私有） |
| `path` | 管理员自己维护的路径 | 人工 | 面板不感知 |
| `ref` | 引用 `certs` 表 | **面板机** | 有 |
| `acme`（存量） | 节点机 acme.sh http-01 | 节点机 | 有，仅兼容保留 |

**分发目标 = 引用它的节点所在机器 ∪ `extra_targets`**，不单独建关联表 ——
目标集合永远能从引用关系推导，多存一份就多一处会不一致的地方。

**没有 `issue_host` 字段了**，因为签发方恒等于面板机。

## 四、面板侧的 acme 执行器（新增 `lib/acme.js`）

这是本方案唯一的新模块，职责很窄：装 acme.sh、签发、续期、读结果。

### 4.1 安装

```
home 固定在 $PANEL_DATA_DIR/acme
首次签发时按需安装：
  1. get.acme.sh 官方引导脚本
  2. 失败则退到 GitHub 源码归档（解压后 --install --home）
```

和 `agent/agent.sh:acme_install` 同一套双路兜底逻辑，可以直接把那段的思路搬过来。
**不要把 acme.sh 装进 `/root/.acme.sh`** —— 容器里那是非持久层，升级即丢；
而且 `docker-entrypoint.sh` 会降权到 `node` 用户，root 目录根本不可写。

镜像侧需要补两个包（当前 `node:24-alpine` 里没有）：

```dockerfile
RUN apk add --no-cache openssl curl
```

- `openssl`：acme.sh 生成 EC 私钥要用它，缺了 `--keylength ec-256` 直接失败；
- `curl`：acme.sh 下载与部分 DNS 插件要用（busybox wget 能用但不稳）。

### 4.2 签发

```sh
CF_Token=xxx "$ACME_SH" --issue --dns dns_cf \
  -d '*.example.com' -d example.com \
  --keylength ec-256 --server letsencrypt \
  --accountemail admin@example.com \
  --home "$PANEL_DATA_DIR/acme"
```

DNS 传播等待：默认 `--dnssleep` 比较保守，建议 Cloudflare 这类支持自动探测的交给 acme.sh 自查，
其余给 `--dnssleep 30`，可配。

### 4.3 异步：签发是长任务，接口不能同步等

DNS-01 一次签发要等传播，30 秒到 2 分钟很正常。所以：

```
POST /api/certs/:id/issue
  → 立即返回 202 { status: 'issuing' }
  → 入队，后台串行执行
  → 前端轮询 GET /api/certs/:id 看状态
```

**串行队列**是必须的：acme.sh 有全局锁，并发跑会互相阻塞或报错。
一个进程内队列即可（单实例部署，不需要跨进程）。

### 4.4 续期

复用 `sweepRenewals()` 的调用点（agent 上报时 + 定时）—— 项目里已经有这个 tick 机制，
加一段「证书剩余 < 30 天且 auto_renew → 入队续期」就行，不需要新的调度器。

续期成功后：

1. 读新证书 → 更新 `cert_pem` / `fingerprint` / `not_after`
2. payload hash 自然变化
3. 所有目标机器下一轮拉配置时拿到新 PEM → 落盘 → 重载

### 4.5 必须处理的坑：证书变了要触发重载

`agentBundle.js` 现在只根据 **Xray 配置文件**是否变化来置 `NP_CHANGED_XRAY=1`。
证书路径不变、只是内容换了（续期就是这种情况），配置文件字节完全一致 →
`NP_CHANGED_XRAY` 保持 0 → **不重载** → 磁盘上是新证书，进程里还是旧的。

这正是存量 `certMode=acme` 现在存在的问题（`ensure_acme_cert` 的 `--install-cert`
没带 `--reloadcmd`）。新流程必须显式处理：

```js
// np_put 返回 0 表示文件真的变了
push(`np_put ${shq(c.certPath)} 600 ... ; [ $? -eq 0 ] && NP_CHANGED_XRAY=1`);
push(`np_put ${shq(c.keyPath)}  600 ... ; [ $? -eq 0 ] && NP_CHANGED_XRAY=1`);
```

Hysteria2 实例同理（置 `NP_CHANGED_HY`）。
**这条不修，证书到期那天会静默过期**，而面板一片绿。

## 五、安全边界（要写进 SECURITY.md）

改成面板机签发后，密钥暴露面从「面板 + N 台节点」收敛到「面板一处」，这是净收益。
但面板这一处变得更关键了：

| 暴露面 | 缓解 |
| --- | --- |
| DNS API 凭据存在面板 DB + `$PANEL_DATA_DIR/acme/*/*.conf` | 接口**只写不读**：列表/详情只返回 `credsSet`（填了哪些字段名），永不回显明文；`acme` 目录 0700；界面引导用「只授单个 Zone DNS 编辑权限」的子账号，别用主账号 AK |
| 私钥存在面板 DB（多机分发必须中转） | 无法避免 —— 多机共用就必须有一处存私钥。缓解：面板必须 HTTPS 部署、DB 文件权限收紧、备份加密 |
| 面板机被攻破 = 全部证书私钥 + DNS 凭据泄露 | 这是本方案集中的风险，也是它换取简单性的代价。至少要做到：不做私钥导出接口、写审计日志 |

实现上**没有**提供任何导出私钥的接口（连默认关闭的开关都没做）——
需要私钥时请直接登录面板机取文件，不要开 HTTP 下载口。
注意：备份接口会连带导出 `certs` 表，也就是私钥与 DNS 凭据都在备份文件里，
备份的存放位置要按密钥级别对待。

## 六、页面设计

### 菜单位置

「证书」放在「服务器」之后 —— 机器维度的事，挨着服务器放比塞进节点页合理。导航变成 9 项。

### 列表

| 域名 | 类型 | 校验 | 状态 | 到期 | 引用 |
| --- | --- | --- | --- | --- | --- |
| `*.example.com` | 通配符 | DNS · Cloudflare | 有效 | 62 天后 | 3 台机器 / 5 个节点 |
| `hk2.example.com` | 单域名 | DNS · 阿里云 | 即将到期 | 9 天后 | 1 台机器 / 2 个节点 |

状态色沿用现有 badge：有效 `badge-ok` / 即将到期（≤14 天）`badge-warn` / 失败、过期 `badge-danger`。

### 新建流程

1. 填域名（含 `*` 自动识别为通配符，并自动补上裸域）
2. 选 DNS 提供商 → 填凭据（带「去哪申请、要什么权限」的说明）
3. 提交 → `issuing` → 后台签发 → 前端轮询到 `issued`

### 详情

- 基本信息：域名、类型、提供商、自动续期开关
- 当前证书：指纹、签发者、有效期、剩余天数
- 引用节点列表（可跳转到节点编辑）
- 签发历史：时间 / 结果 / 耗时 / 失败原因（最近 N 条）
- 操作：立即申请、强制续签、重载所有目标、删除（有引用时禁止）

### 节点表单收敛

现在 `nodes.js:557-612` 那 55 行塌成一个字段：

```
证书来源  [ 自动生成自签 | 使用已有证书 ▾ | 手填路径 ]
                            └→ 下拉里是证书列表 + 「去证书页新建」
```

## 七、接口

```
GET    /api/certs                列表（不含私钥与凭据，只给 credsSet）
POST   /api/certs                新建
PUT    /api/certs/:id            改配置（留空的凭据字段表示不修改）
DELETE /api/certs/:id            删除（有节点引用则 409）
POST   /api/certs/:id/issue      申请 / 续签（202，异步；force=true 时受配额保护）
```

列表项里已经带了签发历史（最近 20 条），所以没有单独的 `/log` 接口。
**也没有 `/reload`** —— agent 是拉模型，面板推不动；「重载」由配置 hash 变化
自然触发（见第四节最后一条）。

**agent 上报接口不需要改** —— 没有回传，这是本方案最省事的地方。

## 八、DNS 提供商适配

| 界面标签 | acme.sh 插件 | 凭据字段 | 备注 |
| --- | --- | --- | --- |
| Cloudflare | `dns_cf` | `CF_Token` | Token 需 Zone.DNS 编辑权限，只给单个 Zone |
| 阿里云 | `dns_ali` | `Ali_Key` / `Ali_Secret` | RAM 子账号，只授 AliyunDNSFullAccess |
| 腾讯云 DNSPod | `dns_dp` | `DP_Id` / `DP_Key` | |
| 华为云 | `dns_huaweicloud` | `HUAWEICLOUD_Username` / `_Password` / `_DomainName` | |
| 手动 | `--manual` | 无 | 面板显示 TXT 记录，用户自己去加（兜底） |

凭据通过环境变量传给 acme.sh。首次签发后 acme.sh 会把它们写进
`$PANEL_DATA_DIR/acme/<domain>/<domain>.conf`（0600），续期直接读，不用面板再传。

## 九、告警

接进 `lib/alerts.js` 现有的事件 + 冷却 + 通道框架（0.1.14 已实现前两条）：

| 事件 | 触发 | 冷却 | 状态 |
| --- | --- | --- | --- |
| `cert.expiring` | 剩余 ≤ 14 天（含已过期） | 24h | 已实现 |
| `cert.failed` | 签发 / 续期失败 | 6h | 已实现 |
| `cert.dns-creds` | 凭据失效（API 返回鉴权错误） | 12h | **未实现**：鉴权错误现在归到 `cert.failed` 的正文里，没有单独事件 |

比上一版少一条 —— 没有签发机了，也就没有「签发机离线」这个告警维度。

新事件是**可选开启**的（和 `agent.old` 一样，默认不在 `settings.notifyEvents` 里），
需要到「设置 → 消息通知」勾上。

## 十、迁移

| 现有 `certMode` | 迁移后 |
| --- | --- |
| `acme` | **不迁移**，保持节点机 http-01 原样运行 |
| `content` | **不迁移**（见下），节点继续用自己那份 PEM |
| `self` / `path` | 不动 |

存量 `acme` 不强行迁移的理由：迁移要求用户提供 DNS API 凭据，而他可能根本没有
（当初就是因为只有 80 端口才选的 http-01）。强行迁移 = 让老用户的节点在升级后失联。

`content` 最后也没迁：迁移只是把 PEM 从 `nodes` 搬到 `certs` 表，收益是能看见到期时间，
但会多一次不可逆的数据搬迁，而老节点照样能跑。想纳入管理的，在证书页新建一张 DNS-01
证书再把节点指过去 —— 平滑、可回退。

## 十一、落地顺序

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **1a** | `certs` 表 + `lib/acme.js` + 证书页 + 节点引用 + 分发路径改按 certId + **修「证书变了不重载」** | 0.1.14 已完成 |
| **1b** | 通配符 + 裸域自动补全 + 四家提供商 + 异步队列与状态轮询 | 0.1.14 已完成 |
| **1c** | 自动续期 + 告警 | 0.1.14 已完成（告警两条） |
| **1d** | 手动 DNS 兜底、导出私钥、批量重签、连通性预检 | **未做** |

**1a 里必须顺手修的存量 bug**：`agent.sh:ensure_acme_cert` 的 `--install-cert` 没带
`--reloadcmd`。这条独立于本方案，现在就该修，否则老用户的 http-01 节点在第 90 天静默过期。

## 十二、明确不做

- **CNAME 委派**（`_acme-challenge` CNAME 到另一个 Zone，避免给每个域名配凭据）—— 有用，但多一层概念，1c 之后再评估
- **多级泛域名**（`*.a.example.com`）—— LE 支持，UI 先只认一级
- **在节点机上签发新证书** —— 存量 http-01 只保留不新增，避免两套签发逻辑并存
- **证书 pinning / OCSP / CRL 监控**
- **DB 加密存储**（引入主密钥）—— 与现有 SMTP 密码处理保持一致，等有统一方案再一起做

## 十三、主要风险

| 风险 | 影响 | 缓解 | 状态 |
| --- | --- | --- | --- |
| 面板机出网受限 | 所有证书签不出来 | 签发前连通性预检 | **未实现**，目前只能靠签发失败后的报错 |
| 面板机时钟不准 | ACME 请求签名校验失败，报错晦涩 | 签发前检查时间偏差 | **未实现** |
| Windows 本地开发 | acme.sh 跑不了 | 签发接口返回明确错误 | 已实现（400 + 页面告警条） |
| 签发中途面板重启 | 证书卡在 `issuing`，手动签发与自动续期全被挡住 | 启动时把超过 10 分钟的 `issuing` 复位 | 已实现（`resetStaleIssuing`） |
| 频繁强制续签 | 撞 LE 重复证书限额（同域名组每周 5 张） | 默认不强制；7 天内签满 4 次直接 429 | 已实现 |
| 私钥集中在面板 DB | 面板被攻破 = 全部证书泄露 | 强制 HTTPS、不做导出接口、审计日志 | 部分（无导出接口；备份仍含私钥） |
| DNS 凭据权限过大 | 用户图省事用主账号 AK | 界面提示用受限子账号 | 已实现（表单 hint） |
| 通配符证书泄露影响面大 | 一张证书覆盖整个域 | 文档提示 | 已实现（本文档 + README） |

## 十四、与当前实现的差异

写这份文档时是设计稿，落地时做了取舍。逐条对齐，避免后面的人拿文档当验收单：

**实现时改掉的**

- 证书落盘路径按**证书 ID**，不是按节点 ID（同机多节点共用一张证书只落一份）。
- 数据模型没有 `issue_host` 字段 —— 签发方恒等于面板机，不需要选。
- `certMode` 收敛成 `self` / `path` / `ref` 三种新增语义，`content` 与 `acme` 保留做存量兼容。
- 续期不接 `sweepRenewals`，而是自己的 `sweepCerts`（12 小时一次，剩 30 天触发）。

**文档写了但没做的**

- `cert.dns-creds` 独立事件（鉴权错误归到 `cert.failed`）。
- 存量 `content` 证书自动迁移。
- 签发前的连通性预检、时钟偏差检查。
- 手动 DNS（`--manual`）兜底、导出私钥接口、批量重签。
- `extraTargets`（手动追加分发目标）后端完整，**前端没有编辑入口**，目前只能走 API。

**实现里有、文档没写的**

- `resetStaleIssuing`：启动时复位卡死的 `issuing` 状态。
- 强制续签的重复证书配额保护（7 天 4 次上限）。
- acme.sh 安装失败后的 30 分钟冷静期。
- 中文域名自动转 punycode。
