# 排查：配置了端口，但机器上没有程序监听

典型现象：

```
journalctl -u nodepanel-agent -f
[2026-10-23 15:46:49] ✓ 配置已更新
[2026-10-23 15:46:49] 面板在线 · 服务器「xxx」 · 1 个节点 / 2 位可用用户
[2026-10-23 15:46:54] ✓ 已回执：配置 496ce804f5ee4a0c 已生效

lsof -i:42323        # 什么都没有
```

面板显示「已同步」、agent 日志一切正常，但客户端连不上、`lsof` 看不到端口。

## 一、先读懂日志：缺了什么，比写了什么更重要

agent 一轮的日志大致有这几段，缺哪段就说明哪一步没发生：

| 日志 | 含义 | 缺失说明 |
| --- | --- | --- |
| `✓ 配置已更新` | 配置包被执行成功（文件落盘） | 没执行到 |
| `✓ Xray 已重载` / `✗ Xray 重载失败` / `! 跳过 Xray 重载` | 配置文件**变了**之后重载服务 | 三行都没有 = 配置内容和磁盘上完全一样，**根本没有重载动作** |
| `已启动 Hysteria2 实例 node-x` | 拉起一个 Hysteria2 实例 | 没有 Hysteria2 节点时正常静默 |
| `! 端口未在监听：tcp:42323` | 端口自检没通过（0.1.3 起） | 旧版 agent 没有自检 |

上面那段日志里，`✓ 配置已更新` 之后**没有出现任何与 Xray 重载相关的行**，
说明这一轮的 `NP_CHANGED_XRAY=0` —— 配置文件内容和面板下发的字节完全一致。

也就是说：**配置早就写对了（42323 在里面），只是没有任何进程在按这份配置监听**。
而面板判断「已同步」只看配置 hash，看不出进程死没死，于是形成了假阳性。

## 二、按这个顺序定位（每步都有明确结论）

```sh
# 0. 端口到底在不在下发的配置里（Xray 节点）
grep -n '"port"' /usr/local/etc/xray/config.json
#   里面有 42323 → 配置没问题，问题在「服务没跑」
#   没有 42323     → 面板上的节点没落到这台机器（节点属于别的服务器 / 被停用），
#                    先看面板「节点」页的「所属服务器」和状态

# 1. 进程在不在
systemctl status xray --no-pager -l        # 服务名可能是 xray-core / x-ui
ps -ef | grep -E '[x]ray|[h]ysteria'

# 2. 谁在监听（Hysteria2 是 UDP，别只查 TCP）
ss -lntup | grep 42323                      # TCP
ss -lnup  | grep 42323                      # UDP
#   注意：lsof -i:42323 在部分系统上看不到 UDP 监听，Hysteria2 节点要用 ss -lnup 确认

# 3. 配置本身能不能过自检（Xray 有错会直接退出，systemd 里表现为反复重启）
/usr/local/bin/xray -test -config /usr/local/etc/xray/config.json

# 4. 服务日志里 Xray 退出的原因（端口被占 / 证书读不到 / 配置字段不被版本支持）
journalctl -u xray -n 80 --no-pager
```

四个分支的结论：

- **配置里没有 42323** → 面板的节点没下发到这台机器（节点归属 / 启停状态），不是端口问题
- **配置里有、服务 `inactive` / `failed`** → 服务没启动，或启动即退出，看第 3、4 步
- **服务 `active` 但 `ss` 里没有** → Xray 读的不是这份配置（`ExecStart -config` 指向别处，
  常见于装过 x-ui / 宝塔的机器）；`systemctl cat xray | grep ExecStart` 确认路径
- **`ss` 里能看到但客户端连不上** → 本机监听正常，问题在防火墙 / 云安全组（见第四节）

## 三、修复（按上一步的结论选一条）

**A. 服务没启动 / 开机不自启**（最常见：重装系统、重启 VPS 后）

```sh
systemctl enable --now xray        # 换成实际服务名：xray-core / x-ui
systemctl status xray --no-pager
```

**B. 机器上压根没装 Xray**（装完 agent 就以为万事大吉）

```sh
command -v xray || echo "没装"
```

装 Xray 官方发行版后再 `systemctl enable --now xray`。
面板只下发配置，不负责安装 Xray 本体（Hysteria2 二进制才是部署脚本自动装的）。

**C. Xray 读的是别的配置**（x-ui / 宝塔 / 手写 unit）

```sh
systemctl cat xray | grep ExecStart
```

把 `agent.env` 的 `XRAY_CONFIG` 指到实际路径，或把 `RELOAD_CMD` 改成实际服务名，
然后 `systemctl restart nodepanel-agent`。否则面板写 A 文件、Xray 读 B 文件，永远对不上。

**D. 端口被别的程序占着**

```sh
ss -lntup | grep 42323     # 看是不是 nginx / 其它 xray 实例
```

换一个端口（面板上改节点端口，agent 一分钟内会重载），或停掉占用者。

**E. 配置自检不过**

```sh
xray -test -config /usr/local/etc/xray/config.json
```

常见原因：Reality 的 `privateKey` 为空、证书文件不存在、`network` 与 `security` 组合不被
当前 Xray 版本支持。按报错修好面板上的节点参数，agent 会重新下发并重载。

## 四、本机能连、外网连不上 → 防火墙与安全组

```sh
# 系统防火墙
ufw status                          # Debian/Ubuntu
firewall-cmd --list-ports           # CentOS/Rocky
iptables -S | grep -E '42323|DROP|REJECT'
```

云厂商控制台的安全组 / 防火墙要单独放行，注意**协议别只放 TCP**：

- vmess / vless / trojan / ss → TCP（ss 还要 UDP）
- **hysteria2 → UDP**

## 五、验证（四层，逐层排除）

```sh
# 1. 本机在监听
ss -lntup | grep 42323

# 2. 本机端口可连（TCP）
timeout 3 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/42323' && echo "本机 TCP OK"

# 3. 公网地址可连（从另一台机器执行，注意云厂商安全组）
nc -vz <服务器IP> 42323
#   UDP（hysteria2）没法用 nc 测，直接看客户端日志

# 4. 客户端实测
#   订阅更新 → 选中该节点 → 测延迟；再看服务器上：
ss -lntup | grep 42323            # 应该有 ESTAB 连接
journalctl -u xray -n 30 --no-pager
```

## 六、0.1.3 起 agent 会自己兜住这类问题

旧逻辑只在「配置内容变了」时重载 Xray。于是机器重启、xray 没 enable、进程被 OOM 杀掉
之后，磁盘配置和面板始终一致 → 每轮都判定「没变化」→ 永远不会再启动 Xray →
端口永久空着，而面板一直显示「已同步」。

现在多两道保险：

1. **Xray 存活自愈**：配置没变也检查 `systemctl is-active`，不在 active 就
   `systemctl enable --now`；5 分钟内失败过就不再反复重试（避免日志刷屏），
   但仍会把失败原因回执给面板。
2. **端口监听自检**：面板在 `state.env` 里下发 `NP_LISTEN_PORTS`（`tcp:42323 udp:8443`），
   agent 用 `ss -lntu` / `netstat -lntu` 核对，没监听就回执 `unbound:"tcp:42323"`，
   面板状态变成**端口未监听**，日志里直接写 `! 端口未在监听：tcp:42323`。

升级方式：面板升级后，agent 会在下一轮自更新（`/api/agent/script` 下发新脚本），
不需要重新执行部署命令。
