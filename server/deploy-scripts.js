'use strict';
/**
 * 部署脚本生成器
 *
 * 从 server.js 抽出：本文件只负责把「面板侧要下发的东西」拼成 shell
 * 文本，不碰 HTTP、不写响应、不读会话 —— 调用方拼好参数拿回字符串，自己决定怎么发。
 * 这四个生成器近千行纯模板，独立成文件后 server.js 的服务器域回到 CRUD 规模。
 *
 * 依赖刻意压到最小：store（取站点名）、package.json（版本号）、agent/agent.sh（自更新源）。
 * 不 require server.js —— 反向依赖会让这次拆分失去意义。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const store = require('../lib/store');
// 主机名校验的唯一实现在 public/js/hosts.js（浏览器与 Node 共用，test/hosts.js 锁两侧一致）
const { isValidHost } = require('../public/js/hosts');

// 与 server.js 指向同一文件；版本号仍以 package.json 为唯一来源
const AGENT_FILE = path.join(__dirname, '..', 'agent', 'agent.sh');
const APP_VERSION = require('../package.json').version;

/**
 * 会进 shell 的文本：换行撕开注释与语句，引号 / 反引号 / $ 能跑命令。
 *
 * 三个生成器（install / uninstall / relay）都必须走这里。0.1.33 里
 * buildInstallScript 做了清洗、buildRelayScript 完全没做 —— 同一个文件两套标准，
 * 就是注入面的来源。`siteName` 这类"看着无害"的字段也一样：它进的是注释行，
 * 但一个换行就能跳出注释开始执行。
 */
function shellSafe(v) {
  return String(v == null ? '' : v)
    .replace(/[\r\n]+/g, ' ')
    .replace(/["`\\$]/g, '');
}

/** 面板地址：比 shellSafe 多去一层单引号与空白（URL 里本就不该出现） */
function urlSafe(v) {
  return String(v || '').replace(/["'`\\\s$]/g, '');
}

/**
 * 中转落地地址：只接受裸 IPv4 或域名。
 *
 * 它会被拼进 `iptables -t nat -j DNAT --to-destination`，这个位置必须是一个纯
 * 主机名/IP —— 带 scheme、端口、路径、引号都会让规则失效或被注入。
 *
 * IPv6 暂时拒绝：脚本用的是 iptables（v4），v6 要 ip6tables 加 `[addr]:port`
 * 写法，半支持比不支持更糟（生成一份一定跑不通的脚本，用户还以为是网络问题）。
 */
function relayTarget(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (net.isIPv4(v)) return v;
  if (net.isIPv6(v)) return '';
  if (!/^[A-Za-z0-9.-]+$/.test(v)) return '';
  return isValidHost(v, v) ? v : '';
}

function buildInstallScript({ panelUrl, token, label, needHysteria, needXray, agentSrc, relayOnly = false }) {
  // 面板地址来自请求头，插进 shell 之前先去掉能掀起风浪的字符
  const safeUrl = urlSafe(panelUrl);
  // 名称会进双引号变量：换行撕开语句，引号/反引号/$ 能跑命令
  const safeLabel = shellSafe(label);
  // 中转机只跑 agent 的转发同步：不下载 Xray / hysteria，也不碰机器上已有的同类服务
  const wantHy = relayOnly ? false : !!needHysteria;
  const wantXray = relayOnly ? false : !!needXray;
  return `#!/bin/sh
# ${shellSafe(store.db().settings.siteName)} · ${relayOnly ? '中转机部署脚本' : '节点部署脚本'}
# 目标：${safeLabel}
# 生成时间：${new Date().toISOString()}
#
# 幂等：重复执行只覆盖 agent 与配置，不重复堆积东西。
${relayOnly
    ? '# 中转机：只部署 agent，转发规则由面板按「中转」页的规则自动同步（gost / iptables）。\n# 不会安装 Xray / Hysteria2，也不会改动本机已有的服务。'
    : '# 已有 Xray 安装（xray / xray-core / x-ui）不会被覆盖；SKIP_XRAY=1 可跳过 Xray 安装。'}
set -u

PANEL_URL="${safeUrl}"
AGENT_TOKEN="${token}"
TARGET_LABEL="${safeLabel}"
NEED_HYSTERIA="${wantHy ? '1' : '0'}"
NEED_XRAY="${wantXray ? '1' : '0'}"
RELAY_ONLY="${relayOnly ? '1' : '0'}"
INTERVAL=60

# ------------------------------ 输出辅助 ------------------------------------
START_TS=$(date +%s)
STEP=0
TOTAL=3
[ "$NEED_XRAY" = "1" ] && TOTAL=$((TOTAL + 1))
[ "$NEED_HYSTERIA" = "1" ] && TOTAL=$((TOTAL + 1))

step() { STEP=$((STEP + 1)); printf '\\n[%s/%s] %s\\n' "$STEP" "$TOTAL" "$1"; }
say() { printf '      %s\\n' "$*"; }
note() { printf '      · %s\\n' "$*"; }
bad() { printf '      ! %s\\n' "$*"; }
die() { printf '\\n✗ %s\\n' "$*" >&2; exit 1; }

# 人类可读的文件大小
size_of() {
  du -k "$1" 2>/dev/null | awk '{ if ($1 >= 1024) printf "%.1f MB", $1 / 1024; else printf "%d KB", $1 }'
}

os_name() {
  _n=''
  if [ -r /etc/os-release ]; then
    _n=$(grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | sed -n '1p' | cut -d= -f2- | tr -d '"')
  fi
  [ -n "$_n" ] || _n=$(uname -s)
  printf '%s' "$_n"
}

if [ "$(id -u)" != "0" ]; then
  printf '\\n✗ 需要 root：要写 /opt、/etc、/usr/local 并注册系统服务\\n' >&2
  exit 1
fi

# 服务管理器先定下来，后面注册和汇总都用同一个结论
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  SVC=systemd
elif command -v rc-update >/dev/null 2>&1; then
  SVC=openrc
elif command -v crontab >/dev/null 2>&1; then
  SVC=cron
else
  SVC=none
fi

printf '\\n%s\\n' '${store.db().settings.siteName} · 节点部署'
say "目标      $TARGET_LABEL"
say "面板      $PANEL_URL"
say "系统      $(os_name) · $(uname -m) · $(uname -r)"
say "服务管理  $SVC"

# ------------------------------- 下载器 ------------------------------------
if command -v curl >/dev/null 2>&1; then
  DL='curl'
elif command -v wget >/dev/null 2>&1; then
  DL='wget'
else
  die '需要 curl 或 wget 之一'
fi

download() {
  # $1=url $2=目标文件
  if [ "$DL" = 'curl' ]; then
    curl -fsSL -m 120 -o "$2" "$1"
  else
    wget -q -T 120 -O "$2" "$1"
  fi
}

# ------------------------------- 1. agent ----------------------------------
step "agent 脚本 → /opt/nodepanel/agent.sh"
mkdir -p /opt/nodepanel /var/log/nodepanel /run/nodepanel

cat > /opt/nodepanel/agent.sh <<'NODEPANEL_AGENT_EOF'
${agentSrc}
NODEPANEL_AGENT_EOF

chmod 755 /opt/nodepanel/agent.sh
sh -n /opt/nodepanel/agent.sh || die "agent 脚本语法检查失败（面板下发的脚本可能被截断）"
AGENT_VER=$(sed -n "s/^VERSION='\\(.*\\)'\\$/\\1/p" /opt/nodepanel/agent.sh | sed -n '1p')
say "版本 \${AGENT_VER:-未知} · $(size_of /opt/nodepanel/agent.sh) · sh -n 通过"
note "日志目录 /var/log/nodepanel，运行时目录 /run/nodepanel"

# 本机卸载入口：面板生成的卸载命令要联网取，面板被删 / 换域名 / token 失效时
# 就再也取不到了，机器上会留一个永远在喊「无法连接面板」的孤儿 agent。
# 这个文件只做转发 —— 真正的清理逻辑在 agent.sh 的 --uninstall 里，
# 跟着 agent 自更新一起变新，不会随版本腐化。
cat > /opt/nodepanel/uninstall.sh <<'NODEPANEL_UNINSTALL_EOF'
#!/bin/sh
# Node Panel · 本机卸载入口（部署时落地，不依赖面板）
#   sh /opt/nodepanel/uninstall.sh            卸干净：agent + 节点监听 + 面板下发的配置
#   sh /opt/nodepanel/uninstall.sh --purge    连日志与配置备份一起删
if [ ! -f /opt/nodepanel/agent.sh ]; then
  echo "✗ 找不到 /opt/nodepanel/agent.sh（agent 可能已被手动删除）"
  echo "  从面板重新取卸载命令：服务器页 / 独立节点页「卸载命令」"
  exit 1
fi
exec sh /opt/nodepanel/agent.sh --uninstall "$@"
NODEPANEL_UNINSTALL_EOF
chmod 755 /opt/nodepanel/uninstall.sh
note "本机卸载入口 /opt/nodepanel/uninstall.sh（断网、面板已删都能用）"

# ------------------------------ 2. Xray 本体 --------------------------------
# 部署脚本自己装 xray-core，三种情况分开处理，任何一种都不破坏已有安装：
#   1) 已有服务单元（webcore / xray / xray-core / x-ui）→ 完全不碰，直接用
#   2) 有 xray 二进制但没有单元（手工解压的）→ 只补一份单元
#   3) 什么都没有 → 下载官方发行包（xray + geoip/geosite）再建单元
#
# 伪装（0.1.9）：全新安装时 Xray 落地为 XRAY_ALIAS（默认 webcore）—— 二进制名、
# 服务单元名、配置/数据目录、进程名全部用它，机器上不出现「xray」字样；
# 已有官方名安装（含本面板 0.1.8 及更早部署的）一律沿用原布局，互不影响。
# Hysteria2 同理（HY_ALIAS，默认 streamd）。想换名字：XRAY_ALIAS=foo HY_ALIAS=bar
# 在部署命令前加 env（curl -fsSL … | XRAY_ALIAS=foo sh）。

XRAY_ALIAS=\${XRAY_ALIAS:-webcore}
HY_ALIAS=\${HY_ALIAS:-streamd}
XRAY_BIN=''
XRAY_ETC=''
XRAY_DAT=''
# 决策出来的实际服务单元名（等待启动 / 汇总提示用）
XRAY_UNIT_NAME=''
HY_BIN=/usr/local/bin/$HY_ALIAS
HY_DIR=/etc/$HY_ALIAS
# 想走镜像（GitHub 拉不动时）：XRAY_DOWNLOAD_BASE=https://某镜像/XTLS/Xray-core/releases/latest/download
XRAY_ZIP_BASE=\${XRAY_DOWNLOAD_BASE:-https://github.com/XTLS/Xray-core/releases/latest/download}
XRAY_VER=''
XRAY_STATE=''
XRAY_SKIPPED=0

# uname -m → 官方发行包的架构后缀（与 XTLS/Xray-install 保持一致）
xray_arch() {
  case "$(uname -m)" in
    i386 | i686) printf '32' ;;
    x86_64 | amd64) printf '64' ;;
    armv5tel) printf 'arm32-v5' ;;
    armv6l) printf 'arm32-v6' ;;
    armv7 | armv7l) printf 'arm32-v7a' ;;
    armv8 | aarch64) printf 'arm64-v8a' ;;
    mips) printf 'mips32' ;;
    mipsle) printf 'mips32le' ;;
    mips64) printf 'mips64' ;;
    mips64le) printf 'mips64le' ;;
    ppc64) printf 'ppc64' ;;
    ppc64le) printf 'ppc64le' ;;
    riscv64) printf 'riscv64' ;;
    s390x) printf 's390x' ;;
    *) printf '' ;;
  esac
}

# 已有的 Xray 服务单元名（空 = 没有）。伪装名优先：0.1.9 装过的机器重跑部署
# 时按伪装名找到已有单元；老机器按官方名找到 —— 两条路都通向「沿用，不重装」
xray_unit_name() {
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    for _u in "$XRAY_ALIAS" xray xray-core x-ui; do
      if systemctl list-unit-files 2>/dev/null | grep -q "^$_u\\.service"; then
        printf '%s' "$_u"
        return 0
      fi
    done
  fi
  if [ -f "/etc/init.d/$XRAY_ALIAS" ]; then printf '%s' "$XRAY_ALIAS"; return 0; fi
  if [ -f /etc/init.d/xray ]; then printf 'xray'; return 0; fi
  printf ''
}

# 名称/路径决策：已有官方名单元的机器整条退回官方布局（xray-core / x-ui 的
# 服务名记进 XRAY_UNIT_NAME，路径仍按 xray 惯例 —— 与 0.1.8 的行为一致）；
# 其余（全新安装 / 已是伪装名）都用伪装名布局
resolve_xray_layout() {
  _preset=$(xray_unit_name)
  XRAY_UNIT_NAME=$_preset
  if [ -n "$_preset" ] && [ "$_preset" != "$XRAY_ALIAS" ]; then
    XRAY_ALIAS=xray
  fi
  XRAY_BIN=/usr/local/bin/$XRAY_ALIAS
  XRAY_ETC=/usr/local/etc/$XRAY_ALIAS
  XRAY_DAT=/usr/local/share/$XRAY_ALIAS
}

# 包管理器装依赖（只在缺 unzip 时用得上）
pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$1" >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q "$1" >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q "$1" >/dev/null 2>&1
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache "$1" >/dev/null 2>&1
  elif command -v zypper >/dev/null 2>&1; then
    zypper -q install -y "$1" >/dev/null 2>&1
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm "$1" >/dev/null 2>&1
  else
    return 1
  fi
}

# 解压 zip：unzip → busybox unzip → python3，三选一（最小化系统常常一个都没有）
extract_zip() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$1" -d "$2" >/dev/null 2>&1 && return 0
  fi
  if command -v busybox >/dev/null 2>&1; then
    busybox unzip -o "$1" -d "$2" >/dev/null 2>&1 && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2" >/dev/null 2>&1 && return 0
  fi
  return 1
}

# 装服务单元（systemd / OpenRC）。只 enable 不 start：
# 首次部署时配置还没下发，xray 起来会因为找不到 config.json 直接退出。
# 单元名与 Description 都用中性词：Description 里出现「Xray」等于把伪装
# 又贴回去了（journalctl / systemctl list-units 直接可见）
write_xray_unit() {
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    mkdir -p /etc/systemd/system 2>/dev/null
    cat > /etc/systemd/system/$XRAY_ALIAS.service <<EOF
[Unit]
Description=WebCore Service
After=network.target nss-lookup.target

[Service]
ExecStart=$XRAY_BIN run -config $XRAY_ETC/config.json
Restart=on-failure
RestartSec=3
# 23 = 配置错误，重试也没用，别把 CPU 烧在重启循环上
RestartPreventExitStatus=23
LimitNPROC=10000
LimitNOFILE=1000000
RuntimeDirectory=$XRAY_ALIAS
RuntimeDirectoryMode=0755

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable $XRAY_ALIAS >/dev/null 2>&1
    printf 'systemd'
  elif command -v rc-update >/dev/null 2>&1; then
    mkdir -p /etc/init.d 2>/dev/null
    cat > /etc/init.d/$XRAY_ALIAS <<EOF
#!/sbin/openrc-run
name="$XRAY_ALIAS"
description="WebCore Service"
command="$XRAY_BIN"
command_args="run -config $XRAY_ETC/config.json"
command_background="yes"
pidfile="/run/$XRAY_ALIAS.pid"

depend() {
  need net
  after firewall
}
EOF
    chmod 755 /etc/init.d/$XRAY_ALIAS
    rc-update add $XRAY_ALIAS default >/dev/null 2>&1
    printf 'openrc'
  else
    printf ''
  fi
}

if [ "$NEED_XRAY" = "1" ]; then
  # 先定布局（沿用官方 or 伪装），后续所有路径/服务名都从这来
  resolve_xray_layout
  step "Xray 本体 → $XRAY_BIN"
  if [ "\${SKIP_XRAY:-0}" = "1" ]; then
    XRAY_SKIPPED=1
    say "SKIP_XRAY=1，跳过安装"
    note "配置仍会下发到 $XRAY_ETC/config.json，服务需自行管理"
  else
    _unit=$(xray_unit_name)
    if [ -n "$_unit" ]; then
      _act=''
      if command -v systemctl >/dev/null 2>&1; then
        _act=$(systemctl is-active "$_unit" 2>/dev/null)
      elif command -v rc-service >/dev/null 2>&1; then
        rc-service "$_unit" status >/dev/null 2>&1 && _act='active' || _act='inactive'
      fi
      [ -n "$_act" ] || _act='unknown'
      say "已有服务单元 $_unit（$_act），沿用现有安装"
      note "不下载、不改配置；重载命令沿用该服务"
      if [ -x "$XRAY_BIN" ]; then
        XRAY_VER=$("$XRAY_BIN" -version 2>/dev/null | sed -n '1p' | cut -d' ' -f1-2)
      fi
    else
      if [ -x "$XRAY_BIN" ]; then
        XRAY_VER=$("$XRAY_BIN" -version 2>/dev/null | sed -n '1p' | cut -d' ' -f1-2)
        say "已有二进制 \${XRAY_VER:-$XRAY_BIN}，只补服务单元"
      else
        _arch=$(xray_arch)
        if [ -z "$_arch" ]; then
          say "本机没有 Xray"
          bad "不支持的架构 $(uname -m)，需手动安装"
        else
          say "本机没有 Xray，下载官方发行包"
          _tmp="/tmp/nodepanel-xray.$$"
          rm -rf "$_tmp" 2>/dev/null
          mkdir -p "$_tmp"
          _zip="Xray-linux-$_arch.zip"
          note "来源 $XRAY_ZIP_BASE/$_zip"
          _got=0
          if download "$XRAY_ZIP_BASE/$_zip" "$_tmp/$_zip"; then
            note "已下载 $(size_of "$_tmp/$_zip")，解压中"
            if extract_zip "$_tmp/$_zip" "$_tmp"; then
              _got=1
            elif pkg_install unzip >/dev/null 2>&1 && extract_zip "$_tmp/$_zip" "$_tmp"; then
              _got=1
            fi
          fi
          if [ "$_got" = "1" ] && [ -f "$_tmp/xray" ]; then
            mkdir -p /usr/local/bin 2>/dev/null
            cp -f "$_tmp/xray" "$XRAY_BIN" 2>/dev/null || cat "$_tmp/xray" > "$XRAY_BIN"
            chmod 755 "$XRAY_BIN" 2>/dev/null
            for _f in geoip.dat geosite.dat; do
              if [ -f "$_tmp/$_f" ]; then
                cp -f "$_tmp/$_f" "$XRAY_DAT/$_f" 2>/dev/null
                chmod 644 "$XRAY_DAT/$_f" 2>/dev/null
              fi
            done
            if "$XRAY_BIN" -version >/dev/null 2>&1; then
              XRAY_VER=$("$XRAY_BIN" -version 2>/dev/null | sed -n '1p' | cut -d' ' -f1-2)
              say "已安装 \${XRAY_VER:-$XRAY_BIN} · $(size_of "$XRAY_BIN")"
              note "数据文件 geoip.dat / geosite.dat → $XRAY_DAT"
            else
              bad "二进制无法执行（架构不匹配？），已删除"
              rm -f "$XRAY_BIN"
            fi
          else
            bad "下载或解压失败"
            note "手动装：bash -c \\"\\$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)\\" @ install"
            note "GitHub 拉不动时用镜像重跑：curl -fsSL \\"<部署命令>\\" | XRAY_DOWNLOAD_BASE=<镜像地址> sh"
          fi
          rm -rf "$_tmp" 2>/dev/null
        fi
      fi

      # 二进制到位（或本来就有）才建单元，否则会留一个永远起不来的服务
      if [ -x "$XRAY_BIN" ]; then
        mkdir -p "$XRAY_ETC" "$XRAY_DAT" 2>/dev/null
        _svc=$(write_xray_unit)
        case "$_svc" in
          systemd) say "服务单元 /etc/systemd/system/$XRAY_ALIAS.service（已 enable，配置下发后启动）" ;;
          openrc) say "服务脚本 /etc/init.d/$XRAY_ALIAS（已加入 default 运行级）" ;;
          *) bad "没有可用的服务管理器，xray 需手动常驻" ;;
        esac
      fi
    fi
  fi
fi

# ---------------------------- 3. Hysteria2 ---------------------------------
if [ "$NEED_HYSTERIA" = "1" ]; then
  # 同 Xray 的逻辑：已有官方名安装（0.1.8 及更早装的 /usr/local/bin/hysteria）
  # 一律沿用，避免同机出现两份二进制各跑各的实例
  if [ -x /usr/local/bin/hysteria ]; then
    HY_BIN=/usr/local/bin/hysteria
    HY_DIR=/etc/hysteria
  fi
  step "Hysteria2 二进制 → $HY_BIN"
  if [ -x "$HY_BIN" ]; then
    say "已安装 $("$HY_BIN" version 2>/dev/null | sed -n '1p')，跳过"
  else
    case "$(uname -m)" in
      x86_64 | amd64) HARCH=amd64 ;;
      aarch64 | arm64) HARCH=arm64 ;;
      armv7l | armv7) HARCH=arm ;;
      i386 | i686) HARCH=386 ;;
      *) HARCH='' ;;
    esac
    if [ -z "$HARCH" ]; then
      bad "不支持的架构 $(uname -m)，需手动安装"
    else
      note "来源 https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-$HARCH"
      if download "https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-$HARCH" "$HY_BIN.tmp"; then
        chmod 755 "$HY_BIN.tmp"
        mv "$HY_BIN.tmp" "$HY_BIN"
        say "已安装 $("$HY_BIN" version 2>/dev/null | sed -n '1p') · $(size_of "$HY_BIN")"
      else
        rm -f "$HY_BIN.tmp"
        bad "下载失败"
        note "手动安装：https://v2.hysteria.network/zh/docs/getting-started/Installation/"
      fi
    fi
  fi
fi

# ---------------------------- 4. 运行配置 ----------------------------------
step "运行配置 → /opt/nodepanel/agent.env"

# 纯 Hysteria2 的机器没走上面的布局决策：XRAY_* 用官方缺省（反正没有 Xray 节点，
# 这个路径只是 agent.env 里的占位，bundle 不会往那写东西）
[ -n "$XRAY_ETC" ] || XRAY_ETC=/usr/local/etc/xray
[ -n "$XRAY_ALIAS" ] || XRAY_ALIAS=xray

# 服务名不一定叫 xray：伪装名 / xray-core / x-ui 都见过，按实际存在的单元来定，
# 否则 agent 每轮都会报「Xray 重载失败」却不说为什么。
# 纯 Hysteria2 的机器不猜：留空，agent 真需要时会自己探测。
RELOAD_CMD=''
if [ "$NEED_XRAY" = "1" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    for _unit in "$XRAY_ALIAS" xray xray-core x-ui; do
      if systemctl list-unit-files 2>/dev/null | grep -q "^$_unit\\.service"; then
        RELOAD_CMD="systemctl restart $_unit"
        XRAY_UNIT_NAME=$_unit
        break
      fi
    done
    [ -n "$RELOAD_CMD" ] || RELOAD_CMD="systemctl restart $XRAY_ALIAS"
  elif command -v rc-service >/dev/null 2>&1; then
    RELOAD_CMD="rc-service $XRAY_ALIAS restart"
  fi
fi

# 值一律加引号：RELOAD_CMD 里带空格，不加引号写进 agent.env 后，
# 任何 source 它的地方都会把空格后面那截当命令执行（restart: not found）
cat > /opt/nodepanel/agent.env <<EOF
PANEL_URL="$PANEL_URL"
AGENT_TOKEN="$AGENT_TOKEN"
INTERVAL="$INTERVAL"
RELAY_ONLY="$RELAY_ONLY"
XRAY_ALIAS="$XRAY_ALIAS"
XRAY_CONFIG="$XRAY_ETC/config.json"
RELOAD_CMD="$RELOAD_CMD"
HYSTERIA_DIR="$HY_DIR"
HYSTERIA_BIN="$HY_BIN"
EOF
chmod 600 /opt/nodepanel/agent.env

say "PANEL_URL=$PANEL_URL"
say "INTERVAL=\${INTERVAL}s · XRAY_CONFIG=$XRAY_ETC/config.json"
if [ -n "$RELOAD_CMD" ]; then
  say "RELOAD_CMD=\\"$RELOAD_CMD\\""
elif [ "$NEED_XRAY" = "1" ]; then
  bad "没有可用的服务管理器，Xray 需手动重载"
else
  say "RELOAD_CMD 留空（本机只有 Hysteria2 节点）"
fi
note "权限 600（内含 token）"

# ---------------------------- 5. 开机自启 ----------------------------------
step "开机自启 → nodepanel-agent"
case "$SVC" in
  systemd)
    cat > /etc/systemd/system/nodepanel-agent.service <<'EOF'
[Unit]
Description=Node Panel Agent (shell)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/nodepanel/agent.env
ExecStart=/bin/sh /opt/nodepanel/agent.sh
Restart=always
RestartSec=10
# 只杀 agent 本体：停/重启 agent 不应该把正在跑的 Hysteria2 实例一起带走
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable nodepanel-agent >/dev/null 2>&1
    systemctl restart nodepanel-agent
    STARTED='systemd'
    say "systemd 单元 /etc/systemd/system/nodepanel-agent.service"
    note "Restart=always · RestartSec=10 · KillMode=process"
    ;;
  openrc)
    mkdir -p /etc/init.d 2>/dev/null
    cat > /etc/init.d/nodepanel-agent <<'EOF'
#!/sbin/openrc-run
name="nodepanel-agent"
description="Node Panel Agent (shell)"
command="/bin/sh"
command_args="/opt/nodepanel/agent.sh"
command_background="yes"
pidfile="/run/nodepanel-agent.pid"
output_log="/var/log/nodepanel/agent.log"
error_log="/var/log/nodepanel/agent.log"

depend() {
  need net
  after firewall
}
EOF
    chmod 755 /etc/init.d/nodepanel-agent
    rc-update add nodepanel-agent default >/dev/null 2>&1
    rc-service nodepanel-agent restart >/dev/null 2>&1
    STARTED='openrc'
    say "OpenRC 脚本 /etc/init.d/nodepanel-agent（已加入 default 运行级）"
    ;;
  cron)
    ( crontab -l 2>/dev/null | grep -v 'nodepanel/agent.sh'
      echo '* * * * * /bin/sh /opt/nodepanel/agent.sh --once >> /var/log/nodepanel/agent.log 2>&1' ) | crontab -
    STARTED='cron'
    say "crontab 每分钟执行一轮（--once 模式）"
    note "没有 systemd / OpenRC，无法常驻进程"
    ;;
  *)
    STARTED='none'
    bad "没有可用的服务管理器"
    note "手动常驻：nohup sh /opt/nodepanel/agent.sh >/var/log/nodepanel/agent.log 2>&1 &"
    ;;
esac

# ---------------------------- 首次同步 --------------------------------------
if [ "$STARTED" = 'cron' ]; then
  /bin/sh /opt/nodepanel/agent.sh --once || true
fi

# agent 启动后第一轮就会写配置并重启 xray，等它一下再把结果报出来
if [ "$NEED_XRAY" = "1" ] && [ "\${SKIP_XRAY:-0}" != "1" ]; then
  _xs=$XRAY_UNIT_NAME
  [ -n "$_xs" ] || _xs=$XRAY_ALIAS
  if [ "$STARTED" = 'systemd' ]; then
    say "等待 agent 首轮同步（最多 12s）"
    _i=0
    while [ "$_i" -lt 12 ]; do
      systemctl is-active --quiet "$_xs" >/dev/null 2>&1 && break
      sleep 1
      _i=$((_i + 1))
    done
    if systemctl is-active --quiet "$_xs" >/dev/null 2>&1; then
      XRAY_STATE='运行中'
      say "服务 $_xs 运行中（pid $(systemctl show -p MainPID --value "$_xs" 2>/dev/null)）"
    else
      XRAY_STATE='未运行'
      bad "服务 $_xs 未运行"
      note "journalctl -u $_xs -n 50（配置里的证书路径 / 端口占用是最常见原因）"
    fi
  elif [ "$STARTED" = 'openrc' ]; then
    say "等待 agent 首轮同步（最多 12s）"
    _i=0
    while [ "$_i" -lt 12 ]; do
      rc-service "$_xs" status >/dev/null 2>&1 && break
      sleep 1
      _i=$((_i + 1))
    done
    if rc-service "$_xs" status >/dev/null 2>&1; then
      XRAY_STATE='运行中'
      say "服务 $_xs 运行中"
    else
      XRAY_STATE='未运行'
      bad "服务 $_xs 未运行"
      note "rc-service $_xs status；journalctl 或 agent 日志里看失败原因"
    fi
  fi
fi

# ------------------------------ 汇总 ----------------------------------------
ELAPSED=$(( $(date +%s) - START_TS ))

if [ "$NEED_XRAY" = "1" ]; then
  if [ "$XRAY_SKIPPED" = "1" ]; then
    XRAY_LINE='未安装（SKIP_XRAY=1）'
  elif [ -n "$XRAY_VER" ] && [ -n "$XRAY_STATE" ]; then
    XRAY_LINE="$XRAY_VER · $XRAY_STATE"
  elif [ -n "$XRAY_VER" ]; then
    XRAY_LINE="$XRAY_VER · 待配置下发后启动"
  else
    XRAY_LINE='未安装（见上方错误）'
  fi
else
  XRAY_LINE='不需要（本机只有 Hysteria2 节点）'
fi

if [ "$NEED_HYSTERIA" = "1" ]; then
  if [ -x "$HY_BIN" ]; then
    HY_LINE="$("$HY_BIN" version 2>/dev/null | sed -n '1p') · 配置在 $HY_DIR"
  else
    HY_LINE='未安装（见上方错误）'
  fi
else
  HY_LINE='不需要（本机没有 Hysteria2 节点）'
fi

printf '\\n✓ 部署完成 · 耗时 %ss\\n\\n' "$ELAPSED"
# 标签是手写对齐的：printf 的 %-10s 按字节补位，中文会被算成 3 字节/字，排不齐
printf '  agent      %s\\n' "v\${AGENT_VER:-未知} · $STARTED · 每 \${INTERVAL}s 一轮"
if [ "$RELAY_ONLY" = "1" ]; then
  printf '  中转       %s\\n' '按面板规则自动同步 gost / iptables 转发'
  printf '  状态       %s\\n' '/opt/nodepanel/state.env'
else
  printf '  xray       %s\\n' "$XRAY_LINE"
  printf '  hysteria2  %s\\n' "$HY_LINE"
  printf '  配置       %s\\n' "$XRAY_ETC/config.json"
  printf '  状态       %s\\n' '/opt/nodepanel/state.env'
fi
printf '\\n'
case "$STARTED" in
  systemd)
    printf '  日志       %s\\n' 'journalctl -u nodepanel-agent -f'
    printf '  重启       %s\\n' 'systemctl restart nodepanel-agent'
    ;;
  openrc)
    printf '  日志       %s\\n' 'tail -f /var/log/nodepanel/agent.log'
    printf '  重启       %s\\n' 'rc-service nodepanel-agent restart'
    ;;
  *)
    printf '  日志       %s\\n' 'tail -f /var/log/nodepanel/agent.log'
    ;;
esac
printf '  手动一轮   %s\\n' 'sh /opt/nodepanel/agent.sh --once'
printf '  卸载       %s\\n' 'sh /opt/nodepanel/uninstall.sh'
printf '\\n'
`;
}

function readAgentSource() {
  // agent 版本号跟面板走：脚本里的 VERSION= 只是兜底默认值，下发时统一替换成
  // package.json 的版本，免得再出现「面板 0.1.0、agent 自报 2.1.0」这种对不上的情况
  return fs
    .readFileSync(AGENT_FILE, 'utf8')
    .replace(/^VERSION=.*$/m, `VERSION='${APP_VERSION}'`);
}

/**
 * 卸载脚本：把 agent 从机器上摘干净。
 *
 * 默认只卸 agent 自己那摊东西（服务、state、它托管的 Hysteria2 实例与配置），
 * 不碰 Xray 配置和日志 —— 那两样可能是人家自己的资产，想连根拔起要显式 --purge。
 * 幂等：没有对应文件时各分支直接跳过，重复执行不报错。
 */
function buildUninstallScript({ label, relayOnly = false }) {
  // 同上：名称里的换行会把注释行撕开
  const safeLabel = shellSafe(label);
  return `#!/bin/sh
# ${shellSafe(store.db().settings.siteName)} · ${relayOnly ? '中转机卸载脚本' : '节点卸载脚本'}
# 目标：${safeLabel}
# 生成时间：${new Date().toISOString()}
#
# 用法（root）：
#   curl -fsSL "…/uninstall?token=…" | sh                卸干净：agent + 节点监听 + 面板下发的配置
#   curl -fsSL "…/uninstall?token=…" | sh -s -- --purge  连日志与配置备份一起清掉
#
# 清理范围：agent 服务 / 进程 / 目录、自签证书、Hysteria2 实例与配置、
#          面板生成的 Xray 配置（先备份）并停掉 Xray 服务 —— 卸完端口不再监听。
# 默认保留：日志目录、Xray 配置备份、Xray 本体（可能是你自己装的）。
# 不会动面板里的服务器 / 节点记录；想恢复接入，重新执行一遍部署命令即可。
set -u

RELAY_ONLY="${relayOnly ? '1' : '0'}"
PURGE=0
for _arg in "$@"; do
  case "$_arg" in
    --purge | -p) PURGE=1 ;;
    -h | --help)
      echo "用法：sh uninstall.sh [--purge]"
      echo "  默认  停掉并清理 agent、Hysteria2 实例、Xray 配置与自签证书（配置会先备份）"
      echo "  --purge  连 /var/log/nodepanel 与配置备份一起删掉"
      exit 0
      ;;
    *) echo "! 忽略未知参数：$_arg" ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "✗ 请用 root 执行（需要删除 /opt、/etc 与注销系统服务）"
  exit 1
fi

# 机器上还留着 agent 本体时，优先交给它自己卸（agent.sh --uninstall）：
# 清理逻辑只有一份实现，而且它更清楚自己用的是官方名还是伪装名。
# 下面这份内联逻辑是兜底 —— /opt/nodepanel 已被手删，或 agent 版本还不支持 --uninstall。
if [ -x /opt/nodepanel/agent.sh ] && grep -q '^  --uninstall)' /opt/nodepanel/agent.sh 2>/dev/null; then
  exec sh /opt/nodepanel/agent.sh --uninstall "$@"
fi

AGENT_DIR=/opt/nodepanel
RUN_DIR=/run/nodepanel
LOG_DIR=/var/log/nodepanel
CERTS_DIR=/etc/nodepanel

# 0.1.9 起机器上的安装可能是伪装名（webcore / streamd），也可能是老官方名
# （xray / hysteria）。一切以 agent.env 里记录的为准 —— 它还没被删，就在下面
# AGENT_DIR 里；读不到（手删过 / 从没部署过）就退回官方缺省路径。
# 不 source agent.env 的原因同 agent.sh：值里带空格会撕开语句
env_get() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$AGENT_DIR/agent.env" 2>/dev/null \\
    | tr -d '\\r' | tail -n 1 \\
    | sed "s/[[:space:]]*\$//; s/^'\\(.*\\)'\$/\\1/; s/^\\"\\(.*\\)\\"\$/\\1/"
}
XRAY_ALIAS=$(env_get XRAY_ALIAS)
[ -n "$XRAY_ALIAS" ] || XRAY_ALIAS=xray
HY_DIR=$(env_get HYSTERIA_DIR)
[ -n "$HY_DIR" ] || HY_DIR=/etc/hysteria
HY_BIN=$(env_get HYSTERIA_BIN)
[ -n "$HY_BIN" ] || HY_BIN=/usr/local/bin/hysteria
XRAY_CONFIG=$(env_get XRAY_CONFIG)
[ -n "$XRAY_CONFIG" ] || XRAY_CONFIG=/usr/local/etc/xray/config.json
XRAY_BAK=\${XRAY_CONFIG}.nodepanel.bak

echo "→ 停止并注销 nodepanel-agent"

# systemd
if [ -f /etc/systemd/system/nodepanel-agent.service ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop nodepanel-agent >/dev/null 2>&1
    systemctl disable nodepanel-agent >/dev/null 2>&1
  fi
  rm -f /etc/systemd/system/nodepanel-agent.service
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1; fi
  echo "  ✓ 已移除 systemd 服务"
fi

# OpenRC（Alpine 等）
if [ -f /etc/init.d/nodepanel-agent ]; then
  if command -v rc-service >/dev/null 2>&1; then rc-service nodepanel-agent stop >/dev/null 2>&1; fi
  if command -v rc-update >/dev/null 2>&1; then rc-update del nodepanel-agent default >/dev/null 2>&1; fi
  rm -f /etc/init.d/nodepanel-agent
  echo "  ✓ 已移除 OpenRC 服务"
fi

# crontab（没有 systemd / OpenRC 时的兜底方案）
if command -v crontab >/dev/null 2>&1; then
  if crontab -l 2>/dev/null | grep -q 'nodepanel/agent.sh'; then
    crontab -l 2>/dev/null | grep -v 'nodepanel/agent.sh' | crontab - 2>/dev/null
    echo "  ✓ 已移除 crontab 定时任务"
  fi
fi

# 兜底：手工 nohup 起来的进程
if command -v pkill >/dev/null 2>&1; then
  if pkill -f '/opt/nodepanel/agent.sh' 2>/dev/null; then
    echo "  ✓ 已结束残留的 agent 进程"
  fi
fi

echo "→ 停止由 agent 托管的 Hysteria2 实例"
if [ "$RELAY_ONLY" = "1" ]; then
  echo "→ 清理中转转发（gost / iptables）"
  for _u in /etc/systemd/system/gost-relay-*.service; do
    [ -f "$_u" ] || continue
    _name=$(basename "$_u")
    systemctl disable --now "$_name" >/dev/null 2>&1 || true
    rm -f "$_u"
    echo "  ✓ 已移除 $_name"
  done
  # Alpine / OpenRC：服务脚本在 /etc/init.d，必须单独清
  for _f in /etc/init.d/gost-relay-*; do
    [ -f "$_f" ] || continue
    _name=$(basename "$_f")
    rc-service "$_name" stop >/dev/null 2>&1 || true
    rc-update del "$_name" default >/dev/null 2>&1 || true
    rm -f "$_f" "/run/$_name.pid"
    echo "  ✓ 已移除 $_name（OpenRC）"
  done
  rm -f /etc/gost/relay-*.env 2>/dev/null
  systemctl daemon-reload >/dev/null 2>&1 || true
  if command -v iptables >/dev/null 2>&1; then
    for _chain in PREROUTING POSTROUTING NP_RELAY_COUNT; do
      iptables -t nat -S "$_chain" 2>/dev/null | grep -F 'np-relay' | sed "s/^-A $_chain //" | while IFS= read -r _r; do
        [ -n "$_r" ] || continue
        iptables -t nat -D "$_chain" $_r 2>/dev/null || true
      done
    done
    iptables -t nat -D PREROUTING -j NP_RELAY_COUNT 2>/dev/null || true
    iptables -t nat -X NP_RELAY_COUNT 2>/dev/null || true
    echo "  ✓ 已清理带 np-relay 标签的 NAT 规则"
  fi
  echo "  · 已跳过 Hysteria2 / Xray 清理（中转机不安装这两样）"
else
for _pidfile in "$RUN_DIR"/*.pid; do
  [ -f "$_pidfile" ] || continue
  _pid=$(cat "$_pidfile" 2>/dev/null)
  if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
    kill "$_pid" 2>/dev/null
    _i=0
    while [ "$_i" -lt 15 ] && kill -0 "$_pid" 2>/dev/null; do
      sleep 0.2 2>/dev/null || sleep 1
      _i=$((_i + 1))
    done
    kill -9 "$_pid" 2>/dev/null
    echo "  ✓ 已停止 $(basename "$_pidfile" .pid)"
  fi
  rm -f "$_pidfile"
done

if ls "$HY_DIR"/node-*.yaml >/dev/null 2>&1; then
  rm -f "$HY_DIR"/node-*.yaml
  echo "  ✓ 已删除 agent 下发的 Hysteria2 配置（$HY_DIR/node-*.yaml）"
fi

# pid 文件丢了（手删 / 机器重启）时按命令行兜底，只匹配 agent 自己下发的那些实例。
# 三种形态都试：agent.env 记录的路径（伪装或官方）、默认伪装名、默认官方名
if command -v pkill >/dev/null 2>&1; then
  if pkill -f "$HY_BIN server -c $HY_DIR/node-" 2>/dev/null \\
     || pkill -f '/usr/local/bin/streamd server -c /etc/streamd/node-' 2>/dev/null \\
     || pkill -f 'hysteria server -c /etc/hysteria/node-' 2>/dev/null; then
    echo "  ✓ 已结束残留的 Hysteria2 实例"
  fi
fi
fi  # RELAY_ONLY=1 时跳过 Hysteria2 清理

echo "→ 删除 agent 文件与运行时目录"
rm -rf "$AGENT_DIR" "$RUN_DIR"
echo "  ✓ 已删除 $AGENT_DIR 与 $RUN_DIR"

# agent 现场生成 / 落盘的自签证书：机器上再没有东西引用它们
if [ -d "$CERTS_DIR" ]; then
  rm -rf "$CERTS_DIR"
  echo "  ✓ 已删除自签证书目录 $CERTS_DIR"
fi

if [ "$RELAY_ONLY" != "1" ]; then
echo "→ 停掉 Xray 并清理面板生成的配置"
# 服务名不一定是 xray：伪装名 / xray-core / x-ui 都见过
XRAY_UNIT=''
if command -v systemctl >/dev/null 2>&1; then
  for _u in "$XRAY_ALIAS" xray xray-core x-ui; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^$_u\\.service"; then
      XRAY_UNIT=$_u
      break
    fi
  done
fi
if [ -z "$XRAY_UNIT" ] && [ -f "/etc/init.d/$XRAY_ALIAS" ]; then XRAY_UNIT=$XRAY_ALIAS; fi
if [ -z "$XRAY_UNIT" ] && [ -f /etc/init.d/xray ]; then XRAY_UNIT=xray; fi

# 只动「确实是面板写的」那份配置：面板生成的配置一定带 StatsService。
# 机器上原有的、管理员自己的 xray 配置一律不碰 —— 卸载命令不该误删别人的服务
if [ ! -f "$XRAY_CONFIG" ]; then
  echo "  · 没有 $XRAY_CONFIG（这台机器可能还没部署过节点），跳过"
elif ! grep -q 'StatsService' "$XRAY_CONFIG" 2>/dev/null; then
  echo "  · $XRAY_CONFIG 不是面板生成的（没有 StatsService），Xray 与配置都保留"
else
  if [ -n "$XRAY_UNIT" ]; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl stop "$XRAY_UNIT" >/dev/null 2>&1
      systemctl disable "$XRAY_UNIT" >/dev/null 2>&1
    elif command -v rc-service >/dev/null 2>&1; then
      rc-service "$XRAY_UNIT" stop >/dev/null 2>&1
      command -v rc-update >/dev/null 2>&1 && rc-update del "$XRAY_UNIT" default >/dev/null 2>&1
    fi
    echo "  ✓ 已停止并取消开机自启 $XRAY_UNIT"
  fi

  if cp -f "$XRAY_CONFIG" "$XRAY_BAK" 2>/dev/null; then
    echo "  ✓ 已备份 Xray 配置到 $XRAY_BAK"
  fi
  rm -f "$XRAY_CONFIG"
  echo "  ✓ 已移除面板生成的 $XRAY_CONFIG"

  # 没有服务单元时（手工 nohup 起的），按进程名收尾 —— 否则端口会一直被占着
  if [ -z "$XRAY_UNIT" ] && command -v pkill >/dev/null 2>&1; then
    if pkill -x "$XRAY_ALIAS" 2>/dev/null || pkill -x xray 2>/dev/null; then
      echo "  ✓ 已结束手工启动的 Xray 进程"
    fi
  fi
fi
fi  # RELAY_ONLY=1 时跳过 Xray 清理

if [ "$PURGE" = "1" ]; then
  echo "→ 深度清理（--purge）"
  rm -rf "$LOG_DIR"
  echo "  ✓ 已删除日志目录 $LOG_DIR"
  rm -f "$XRAY_BAK"
  echo "  ✓ 已删除配置备份 $XRAY_BAK"
else
  echo ""
  echo "· 保留 $LOG_DIR（要一起清掉就加 --purge 重跑）"
  echo "· 保留 $XRAY_BAK（面板覆盖前的配置备份，不需要可手动删）"
fi

if [ -x "/usr/local/bin/$XRAY_ALIAS" ] || [ -x /usr/local/bin/xray ]; then
  echo "· 保留 Xray 二进制与 geo 数据（可能是你自己装的；"
  echo "  确认是面板装的那份，可执行：rm -rf /usr/local/bin/$XRAY_ALIAS /usr/local/share/$XRAY_ALIAS）"
fi

echo ""
if [ "$RELAY_ONLY" = "1" ]; then
  echo "✓ 卸载完成：中转机 agent 已注销，转发规则已清理"
else
  echo "✓ 卸载完成：agent 已注销，节点端口不再监听"
fi
echo "  面板里的服务器 / 节点记录还在，重新执行部署命令即可恢复接入。"
`;
}

/** 服务器 / 独立节点共用的卸载脚本鉴权 */

/**
 * L4 中转脚本：把入口机器某端口的流量 DNAT 到节点所在机器。
 * 入口不解析协议，因此 TLS / Reality / Hysteria2 全部适用，
 * 且流量仍记在落地节点上（计费不受影响）。
 */
function buildRelayScript({ to, port, proto = 'both', label = '' }) {
  // 落地地址与标签都来自 query：这里再洗一遍是纵深防御，真正的白名单校验在
  // server/servers.js 的 relayScript（那里能回一句看得懂的 400）
  const target = shellSafe(to);
  const safeLabel = shellSafe(label);
  const listenPort = Number(port) || 443;
  const protocols = proto === 'both' ? ['tcp', 'udp'] : [proto];

  const dnatRules = protocols.map(
    (p) => `add_rule PREROUTING -p ${p} --dport "\${LISTEN_PORT}" -j DNAT --to-destination "\${TARGET_HOST}:\${TARGET_PORT}"`,
  );

  return `#!/usr/bin/env bash
# ${shellSafe(store.db().settings.siteName)} · 中转部署脚本
# ${safeLabel ? safeLabel + '\n# ' : ''}把本机 \${LISTEN_PORT} 的流量转发到 \${TARGET_HOST}:\${TARGET_PORT}
# 生成时间：${new Date().toISOString()}
# 用法：sh relay.sh      （需要 root：直接以 root 执行，或先 su -；脚本不依赖 sudo）
set -euo pipefail

TARGET_HOST="${target}"
TARGET_PORT=${listenPort}
LISTEN_PORT=${listenPort}

if [ "$(id -u)" != '0' ]; then
  echo "✗ 需要 root 权限（要改 sysctl 与 iptables）：用 root 执行，或先 su - 再跑"
  exit 1
fi

if [ -z "$TARGET_HOST" ]; then
  echo "✗ 未指定落地节点地址"
  exit 1
fi

echo "→ 开启内核转发"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
if grep -q '^net.ipv4.ip_forward' /etc/sysctl.conf 2>/dev/null; then
  sed -i 's/^net.ipv4.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf
else
  echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
fi

# 缺 iptables 时自动安装（Alpine 默认不装）
if ! command -v iptables >/dev/null 2>&1; then
  echo "→ 未检测到 iptables，尝试自动安装"
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache iptables 2>&1 | tail -n 3 || true
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables 2>&1 | tail -n 3 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y iptables 2>&1 | tail -n 3 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y iptables 2>&1 | tail -n 3 || true
  fi
  export PATH="$PATH:/usr/sbin:/sbin"
fi
if ! command -v iptables >/dev/null 2>&1; then
  echo "✗ iptables 仍不可用：请手动安装（Alpine: apk add iptables）"
  exit 1
fi

# 幂等写入 NAT 规则（已存在则跳过）
add_rule() {
  iptables -t nat -C "$@" 2>/dev/null || iptables -t nat -A "$@"
}

add_rule POSTROUTING -d "$TARGET_HOST" -j MASQUERADE
${dnatRules.join('\n')}

echo ""
echo "✓ 中转规则已生效"
echo "  本机 :$LISTEN_PORT  →  $TARGET_HOST:$TARGET_PORT"
echo ""
echo "当前 NAT 规则："
iptables -t nat -L PREROUTING -n --line-numbers | grep -E "DNAT|MASQUERADE" || true

# 持久化（不同发行版命令不同，失败不影响本次生效）
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save && echo "✓ 规则已持久化"
elif command -v iptables-save >/dev/null 2>&1; then
  mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4 && echo "✓ 规则已保存到 /etc/iptables/rules.v4"
else
  echo "! 未找到持久化工具，重启后规则会丢失"
fi

echo ""
echo "提示："
echo "  · 流量仍记在落地节点（$TARGET_HOST）上，计费与统计不受影响"
echo "  · 记得在入口机器放行 $LISTEN_PORT 端口"
echo "  · 删除规则：iptables -t nat -L PREROUTING -n --line-numbers 找到行号后 -D"
`;
}


/* ------------------------ 中转规则脚本（0.1.43，三态） ------------------------ */

/**
 * 中转规则脚本：install / uninstall / check 三态，按 tool 分发到 iptables 或 gost。
 *
 * 与旧 buildRelayScript（一次性脚本，保留兼容）的区别：
 *   - 规则带 ID：iptables 打 comment 标签 np-relay:<id>，gost 用独立 systemd unit，
 *     卸载按标签 / unit 名精确删除，不依赖行号
 *   - 执行末尾 curl 回执（免登录 /api/relay/ack，deployToken 鉴权），面板据此把
 *     status 从 planned 推进到 applied —— 回执失败只提示，绝不影响规则本身
 *   - install 前置端口占用预检：脚本跑成功了但流量根本不通，比报错退出难查得多
 *
 * bash 模板里的 ${VAR} 是「给 systemd / 间接展开保留的字面量」，写 JS 模板串时
 * 必须转义成 \${VAR}；普通的 "$VAR" 引号形式不含 {，无需转义 —— 两者别混着改。
 */

/** gost 版本白名单：只认 x.y.z 纯数字版本（nightly / rc 一律拒绝，资产名不可预测） */
const GOST_VER_RE = /^\d+\.\d+\.\d+$/;
/**
 * 默认 gost 版本：必须与 GitHub Release 的 tag / 资产名一致。
 * 3.5.1 并不存在（会 404），当前最新稳定版是 3.3.3；升级前先确认
 * https://api.github.com/repos/go-gost/gost/releases/latest 的 tag_name 与资产名。
 */
const DEFAULT_GOST_VER = '3.3.3';

/**
 * 规则的目标列表（0.1.46）：targets 优先，老数据回落到 targetHost/targetPort。
 * 全部过 shellSafe —— 这两个字段会被拼进 systemd unit 与 iptables 参数。
 */
function relayTargets(rule) {
  const raw = Array.isArray(rule.targets) && rule.targets.length
    ? rule.targets
    : rule.targetHost
      ? [{ host: rule.targetHost, port: rule.targetPort }]
      : [];
  return raw
    .map((t) => ({ host: shellSafe((t && t.host) || ''), port: Number(t && t.port) || 443 }))
    .filter((t) => t.host);
}

const targetListText = (list) => list.map((t) => `${t.host}:${t.port}`).join(' / ');

/** 三条脚本共用的开头：站点 / 规则 / 回执参数，全部洗过一遍再进 shell */
function relayHeader({ rule, mode, panelUrl, site, comment }) {
  const targets = relayTargets(rule);
  return `#!/usr/bin/env bash
# ${site} · 中转规则脚本（${rule.tool} · ${mode}）
# 规则：${shellSafe(rule.name || rule.id)}   本机 :${Number(rule.listenPort) || 443} → ${targetListText(targets)}${
    targets.length > 1 ? `（共 ${targets.length} 个目标，按顺序故障切换）` : ''
  }
${comment ? `# ${comment}\n` : ''}# 生成时间：${new Date().toISOString()}
# 用法：sh relay-${shellSafe(rule.id)}-${mode}.sh   （需要 root：直接以 root 执行，或先 su -；脚本不依赖 sudo）
set -euo pipefail

RELAY_ID="${shellSafe(rule.id)}"
RELAY_TOKEN="${shellSafe(rule.deployToken)}"
MODE="${mode}"
PANEL_URL="${urlSafe(panelUrl)}"
`;
}

function relayRootCheck() {
  return `if [ "$(id -u)" != '0' ]; then
  echo "✗ 需要 root 权限：用 root 执行，或先 su - 再跑"
  exit 1
fi
`;
}

/** 执行结果回执：免登录 /api/relay/ack（deployToken 恒时比较），失败只提示 */
function relayAck() {
  return `
# 回执：把执行结果告诉面板（deployToken 是生成脚本时新发的一次性凭证）
# 回执失败只影响面板上的状态展示，不影响规则本身
if command -v curl >/dev/null 2>&1 && [ -n "\${PANEL_URL}" ]; then
  curl -fsS -m 10 -X POST "\${PANEL_URL}/api/relay/ack" \\
    -H 'Content-Type: application/json' \\
    -d "{\\"id\\":\\"\${RELAY_ID}\\",\\"token\\":\\"\${RELAY_TOKEN}\\",\\"mode\\":\\"\${MODE}\\",\\"ok\\":\${OK}}" \\
    >/dev/null 2>&1 || echo "! 回执失败（不影响规则，可忽略）"
fi
`;
}

/* ------------------------------- iptables 三态 ------------------------------ */

function buildIptablesRelayScript({ rule, mode, panelUrl }) {
  const site = shellSafe(store.db().settings.siteName);
  const id = shellSafe(rule.id);
  const listenPort = Number(rule.listenPort) || 443;
  const targets = relayTargets(rule);
  const target = targets[0] ? targets[0].host : '';
  const targetPort = targets[0] ? targets[0].port : 443;
  const targetsBash = targets.map((t) => `'${t.host}:${t.port}'`).join(' ');
  const protocols = rule.proto === 'both' ? ['tcp', 'udp'] : [rule.proto === 'udp' ? 'udp' : 'tcp'];

  if (mode === 'install') {
    const dnatLines = protocols
      .map((p) => `add_rule PREROUTING -p ${p} --dport "$LISTEN_PORT" -j DNAT --to-destination "$TARGET_HOST:$TARGET_PORT" $TAG`)
      .join('\n');

    return `${relayHeader({ rule, mode, panelUrl, site, comment: `规则 ID：${id}（iptables 注释标签 np-relay:${id}，卸载脚本按标签精确删除）` })}
LISTEN_PORT=${listenPort}
# 目标顺序 = 故障切换顺序（0.1.46）；安装时探测一次，选第一个可达
TARGETS=(${targetsBash})
# 卸载脚本按这个标签找规则；comment 模块缺失时降级为按监听端口匹配（见下）
TAG='-m comment --comment np-relay:${id}'

${relayRootCheck()}
if ! command -v iptables >/dev/null 2>&1; then
  echo "→ 未检测到 iptables，尝试自动安装"
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache iptables 2>&1 | tail -n 3 || true
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables 2>&1 | tail -n 3 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y iptables 2>&1 | tail -n 3 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y iptables 2>&1 | tail -n 3 || true
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm iptables 2>&1 | tail -n 3 || true
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install iptables 2>&1 | tail -n 3 || true
  fi
  export PATH="$PATH:/usr/sbin:/sbin"
fi
if ! command -v iptables >/dev/null 2>&1; then
  echo "✗ iptables 仍不可用：请手动安装（Alpine: apk add iptables）"
  exit 1
fi

# comment 模块探测：有标签才能在卸载时精确定位
if ! iptables -m comment -h >/dev/null 2>&1; then
  echo "! iptables 缺少 comment 模块：本次规则不带标签，卸载只能按目标地址匹配（精度略降）"
  TAG=''
fi

echo "→ 开启内核转发"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
if grep -q '^net.ipv4.ip_forward' /etc/sysctl.conf 2>/dev/null; then
  sed -i 's/^net.ipv4.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf
else
  echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
fi

# 端口预检：同一监听端口已有别的 DNAT 规则时明确报错 —— 静默冲突的表现是
# 「脚本跑成功了但流量不通」，排查成本远高于现在多打这两行
if iptables -t nat -S PREROUTING | grep -E -- "--dport $LISTEN_PORT( |$)" | grep -vF "np-relay:\$RELAY_ID" >/dev/null 2>&1; then
  echo "✗ 端口 $LISTEN_PORT 已被其它 DNAT 规则占用："
  iptables -t nat -S PREROUTING | grep -E -- "--dport $LISTEN_PORT( |$)" || true
  echo "  请换一个监听端口，或先清理占用该端口的规则再重跑"
  exit 1
fi

# 幂等写入 NAT 规则（已存在则跳过）
add_rule() {
  iptables -t nat -C "$@" 2>/dev/null || iptables -t nat -A "$@"
}

# 目标探测：按顺序取第一个能建立 TCP 连接的。iptables 规则是静态的，
# 切换只发生在「安装 / 重跑脚本」时；agent 托管的中转机由每轮收敛重新选目标。
pick_target() {
  local t h p
  for t in "\${TARGETS[@]}"; do
    h="\${t%:*}"; p="\${t##*:}"
    if command -v nc >/dev/null 2>&1; then
      nc -z -w 2 "$h" "$p" >/dev/null 2>&1 && { echo "$t"; return 0; }
    else
      (exec 3<>"/dev/tcp/$h/$p") 2>/dev/null && { echo "$t"; return 0; }
    fi
  done
  return 1
}

echo "→ 探测目标（按顺序第一个可达）"
PICK=$(pick_target || true)
if [ -z "$PICK" ]; then
  echo "! 所有目标都不可达，先按第一个写入：\${TARGETS[0]}（恢复后重跑本脚本即可重选）"
  PICK="\${TARGETS[0]}"
fi
TARGET_HOST="\${PICK%:*}"
TARGET_PORT="\${PICK##*:}"
echo "  使用目标：$TARGET_HOST:$TARGET_PORT"

# 目标探测：按顺序取第一个能建立 TCP 连接的。iptables 规则是静态的，
# 切换只发生在「安装 / 重跑脚本」时；agent 托管的中转机由每轮收敛重新选目标。
# 域名先在入口机解析成 IPv4 —— DNAT 的 --to-destination 只接受 IP
resolve_ipv4() {
  case "$1" in
    *[!0-9.]*) ;;
    *) echo "$1"; return 0 ;;
  esac
  local ip=''
  if command -v getent >/dev/null 2>&1; then
    ip=$(getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}')
  fi
  if [ -z "$ip" ] && command -v nslookup >/dev/null 2>&1; then
    ip=$(nslookup "$1" 2>/dev/null | awk '/^Name:/{seen=1;next} seen && /^Address/{for(i=2;i<=NF;i++) if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {print $i; exit}}')
  fi
  if [ -z "$ip" ] && command -v host >/dev/null 2>&1; then
    ip=$(host "$1" 2>/dev/null | awk '/has address/{print $4; exit}')
  fi
  [ -n "$ip" ] || return 1
  echo "$ip"
}

pick_target() {
  local t h p ip
  for t in "\${TARGETS[@]}"; do
    h="\${t%:*}"; p="\${t##*:}"
    ip=$(resolve_ipv4 "$h" || true)
    if [ -z "$ip" ]; then
      echo "! 目标 $h 无法解析为 IPv4（检查入口机 DNS，或直接填 IP）" >&2
      continue
    fi
    if command -v nc >/dev/null 2>&1; then
      nc -z -w 2 "$ip" "$p" >/dev/null 2>&1 && { echo "$ip:$p"; return 0; }
    else
      (exec 3<>"/dev/tcp/$ip/$p") 2>/dev/null && { echo "$ip:$p"; return 0; }
    fi
  done
  return 1
}

echo "→ 探测目标（按顺序第一个可达）"
PICK=$(pick_target || true)
if [ -z "$PICK" ]; then
  echo "✗ 没有可用目标：域名解析失败或全部不可达，请检查入口机 DNS / 目标地址"
  exit 1
fi
TARGET_HOST="\${PICK%:*}"
TARGET_PORT="\${PICK##*:}"
echo "  使用目标：$TARGET_HOST:$TARGET_PORT"

add_rule POSTROUTING -d "$TARGET_HOST" -j MASQUERADE $TAG
${dnatLines}

echo ""
echo "✓ 中转规则已生效"
echo "  本机 :$LISTEN_PORT  →  $TARGET_HOST:$TARGET_PORT"
echo "  目标列表（按顺序故障切换）：${targetListText(targets)}"
echo "  · 安装了 agent 的中转机会每轮自动重选；纯手动模式请在本机重跑脚本切换"
echo ""
echo "当前 NAT 规则："
iptables -t nat -S PREROUTING | grep -F "np-relay:\$RELAY_ID" || true
iptables -t nat -S POSTROUTING | grep -F "np-relay:\$RELAY_ID" || true

# 持久化（不同发行版命令不同，失败不影响本次生效）
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save && echo "✓ 规则已持久化"
elif [ -f /etc/init.d/iptables ] && command -v rc-service >/dev/null 2>&1; then
  rc-update add iptables default >/dev/null 2>&1 || true
  if rc-service iptables save >/dev/null 2>&1; then
    echo "✓ 规则已持久化（OpenRC iptables 服务）"
  else
    mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4 && echo "✓ 规则已保存到 /etc/iptables/rules.v4"
  fi
elif command -v iptables-save >/dev/null 2>&1; then
  mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4 && echo "✓ 规则已保存到 /etc/iptables/rules.v4"
else
  echo "! 未找到持久化工具，重启后规则会丢失"
fi

OK=1
${relayAck()}

echo ""
echo "提示："
echo "  · 流量仍记在落地节点（$TARGET_HOST）上，计费与统计不受影响"
echo "  · 记得在中转服务器放行 $LISTEN_PORT 端口（安全组 / 防火墙）"
`;
  }

  if (mode === 'uninstall') {
    return `${relayHeader({ rule, mode, panelUrl, site, comment: `按标签 np-relay:${id} 精确删除；无标签（comment 模块缺失时安装的旧规则）按目标地址匹配兜底` })}
LISTEN_PORT=${listenPort}
TARGET_HOST="${target}"
TARGET_PORT=${targetPort}

${relayRootCheck()}
if ! command -v iptables >/dev/null 2>&1; then
  echo "✗ 未检测到 iptables"
  exit 1
fi

if ! iptables -m comment -h >/dev/null 2>&1; then
  echo "! iptables 缺少 comment 模块：按目标地址匹配删除（精度略降）"
fi

# 把 -S 输出的规则行转成 -D 参数逐条删：行号会漂移，规则全文才是稳定锚点
del_tag() {
  iptables -t nat -S "$1" | grep -F "np-relay:\$RELAY_ID" | sed "s/^-A $1 //" | while IFS= read -r r; do
    echo "→ 删除（$1）：$r"
    iptables -t nat -D "$1" $r || echo "! 删除失败（可能已被清除）"
  done
}

# 无标签兜底：按 dport（监听端口）匹配。多目标切换后机器上的 to-destination
# 可能不是当前第一项，不能再按目标地址筛；同端口唯一性由面板侧冲突校验保证
del_target() {
  iptables -t nat -S "$1" \\
    | grep -E -- "--dport $LISTEN_PORT( |$)" \\
    | sed "s/^-A $1 //" \\
    | while IFS= read -r r; do
        echo "→ 删除（$1）：$r"
        iptables -t nat -D "$1" $r || echo "! 删除失败（可能已被清除）"
      done
}

echo "→ 清理中转规则 np-relay:\$RELAY_ID"
if iptables -m comment -h >/dev/null 2>&1; then
  del_tag PREROUTING
  del_tag POSTROUTING
else
  del_target PREROUTING
  echo "  MASQUERADE 未删（无标签无法精确定位，可能被同目标规则共用）："
  iptables -t nat -S POSTROUTING | grep -F -- "-d $TARGET_HOST" || echo "  （没有该目标的 MASQUERADE）"
fi

# 标签与目标两种途径都过一遍（幂等：删过了就静默跳过），防止历史遗留混装
del_target PREROUTING 2>/dev/null || true

echo ""
echo "✓ 卸载完成：中转规则已从中转服务器移除"
echo "  面板里的规则记录还在，重新生成 install 脚本执行即可恢复。"

OK=1
${relayAck()}
`;
  }

  // check：只读盘点，回执 ok=1 → applied / ok=0 → unknown
  return `${relayHeader({ rule, mode, panelUrl, site, comment: '只读检查：本规则是否存活 + 本机全部面板中转规则盘点' })}
LISTEN_PORT=${listenPort}
TARGET_HOST="${target}"
TARGET_PORT=${targetPort}

${relayRootCheck()}
if ! command -v iptables >/dev/null 2>&1; then
  echo "✗ 未检测到 iptables"
  exit 1
fi

OK=0
if iptables -m comment -h >/dev/null 2>&1; then
  if iptables -t nat -S PREROUTING | grep -F "np-relay:\$RELAY_ID" >/dev/null 2>&1; then
    OK=1
    echo "✓ 规则存活（np-relay:\$RELAY_ID）"
  else
    echo "✗ 规则不在 NAT 表里（未安装或已被清除）"
  fi
else
  if iptables -t nat -S PREROUTING \\
      | grep -E -- "--dport $LISTEN_PORT( |$)" >/dev/null 2>&1; then
    OK=1
    echo "✓ 规则存活（按目标地址匹配）"
  else
    echo "✗ 规则不在 NAT 表里（未安装或已被清除）"
  fi
fi

echo ""
echo "本机全部面板中转规则："
iptables -t nat -S PREROUTING | grep -F 'np-relay:' || echo "  （没有带 np-relay: 标签的规则）"

${relayAck()}
`;
}

/* --------------------------------- gost 三态 -------------------------------- */

/**
 * gost 转发（v3，go-gost）：每条规则一个 systemd unit（gost-relay-<id>.service）
 * + 一份环境文件（/etc/gost/relay-<id>.env）。unit 名就是「卸载时找到规则」的锚点。
 */
function buildGostRelayScript({ rule, mode, panelUrl, githubProxy = '' }) {
  const site = shellSafe(store.db().settings.siteName);
  const id = shellSafe(rule.id);
  const listenPort = Number(rule.listenPort) || 443;
  const targets = relayTargets(rule);
  const target = targets[0] ? targets[0].host : '';
  const targetPort = targets[0] ? targets[0].port : 443;
  const targetsBash = targets.map((t) => `'${t.host}:${t.port}'`).join(' ');
  const proxy = shellSafe(String(githubProxy || ''));

  // proto 裁剪成 -L 参数（gost 的 TCP 与 UDP 是两个独立监听，可同端口并存）。
  // \${NP_LISTEN}/\${NP_TARGET} 是 systemd 的 EnvironmentFile 变量，必须保留字面。
  // 不用 gost 的 strategy/max_fails 参数：不同版本对多目标策略参数的兼容性不一致，
  // 一旦不认识 unit 就起不来。改成「脚本先探测、只下发一个可达目标」，最稳。
  const forwards = rule.proto === 'both' ? ['tcp', 'udp'] : [rule.proto === 'udp' ? 'udp' : 'tcp'];
  const execArgs = forwards.map((p) => `-L ${p}://:\${NP_LISTEN}/\${NP_TARGET}`).join(' ');
  // OpenRC 没有 EnvironmentFile 这一层，参数在生成 init 脚本时用实际值写死
  const openrcArgs = forwards.map((p) => `-L ${p}://:\${LISTEN_PORT}/$TARGET_ADDR`).join(' ');

  if (mode === 'install') {
    return `${relayHeader({ rule, mode, panelUrl, site, comment: `gost 服务（systemd unit 或 OpenRC init）：gost-relay-${id}（卸载 / 状态检查按服务名定位）` })}
LISTEN_PORT=${listenPort}
# 目标顺序 = 故障切换顺序（0.1.46）；下面探测一次，选第一个可达
TARGETS=(${targetsBash})
TARGET_ADDR="${target}:${targetPort}"
GOST_VER="${DEFAULT_GOST_VER}"
GOST_BIN=/usr/local/bin/gost
# GitHub 反代前缀（面板设置项）；空 = 直连
GOST_PROXY="${proxy}"
UNIT="gost-relay-\${RELAY_ID}.service"
SERVICE="gost-relay-\${RELAY_ID}"
SVC_FILE="/etc/init.d/\${SERVICE}"
ENV_FILE="/etc/gost/relay-\${RELAY_ID}.env"

${relayRootCheck()}
case "$(uname -m)" in
  x86_64)          ARCH=amd64 ;;
  aarch64|arm64)   ARCH=arm64 ;;
  *) echo "✗ 不支持的架构：$(uname -m)（gost 官方只发 amd64 / arm64）"; exit 1 ;;
esac

# 服务管理器：Alpine 只有 OpenRC，没有 /etc/systemd/system，不能硬写 unit
if command -v systemctl >/dev/null 2>&1; then
  SVC_KIND=systemd
elif command -v rc-service >/dev/null 2>&1; then
  SVC_KIND=openrc
else
  echo "✗ 未找到 systemd / OpenRC：gost 需要服务管理器常驻"
  exit 1
fi

# gost 二进制：已存在就复用（不覆盖用户自装的版本），缺了才下载。
# 自定义镜像：GOST_DL_BASE=https://your-mirror/... sh relay-*.sh
if [ ! -x "$GOST_BIN" ]; then
  GOST_URL="\${GOST_DL_BASE:-https://github.com/go-gost/gost/releases/download}/v\${GOST_VER}/gost_\${GOST_VER}_linux_\${ARCH}.tar.gz"
  # 有反代且机器在中国大陆（或判断不出来）时，把反代拼在 GitHub 地址前；
  # 自定义镜像已经是替代源，不再叠加反代
  if [ -n "$GOST_PROXY" ] && [ -z "\${GOST_DL_BASE:-}" ]; then
    _loc=$(curl -fsS -m 5 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^loc=//p')
    case "$_loc" in
      CN|'') GOST_URL="\${GOST_PROXY}\${GOST_URL}" ;;
    esac
  fi
  echo "→ 下载 gost v\${GOST_VER}（linux/\${ARCH}）：$GOST_URL"
  # 小磁盘机器（Alpine 容器常见 90MB 根分区）：先看可用空间。
  # 以前「下载 tar.gz → 解压 → install 复制」峰值是 3 份，60MB 可用也会被撑爆
  _avail=$(df -k "$(dirname "$GOST_BIN")" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$_avail" ] && [ "$_avail" -lt 61440 ]; then
    echo "✗ 磁盘空间不足：$(dirname "$GOST_BIN") 可用 \${_avail}KB，gost 二进制约 50MB"
    echo "  · 清理 /tmp 后重跑；或把这条规则改用 iptables（不需要 gost 二进制）"
    exit 1
  fi
  _tmp="$GOST_BIN.np-new.$$"
  # 流式解压：压缩包不落地，峰值只占最终二进制一份，避免 No space left on device
  if curl -fsSL "$GOST_URL" | tar -xzO gost > "$_tmp" 2>/dev/null && [ "$(wc -c < "$_tmp")" -gt 20971520 ]; then
    chmod 755 "$_tmp"
    mv -f "$_tmp" "$GOST_BIN"
    echo "✓ gost 已安装：$("$GOST_BIN" -V 2>&1 | head -n 1 || echo '(版本信息获取失败，但不影响安装)')"
  else
    rm -f "$_tmp"
    echo "✗ gost 下载/解压失败：$GOST_URL"
    echo "  · 404 = 版本 / 资产名不存在；连不上 = 在面板设置里配置 GitHub 反代"
    echo "  · No space left on device = 磁盘不足（清理 /tmp 或改用 iptables）"
    exit 1
  fi
fi

# 端口预检：先停本规则旧服务（重跑更新配置的场景），再确认端口没被别人占着
if [ "$SVC_KIND" = systemd ]; then
  systemctl stop "$UNIT" >/dev/null 2>&1 || true
else
  rc-service "$SERVICE" stop >/dev/null 2>&1 || true
fi
if ss -lntu 2>/dev/null | grep -E ":\${LISTEN_PORT}[[:space:]]" >/dev/null; then
  echo "✗ 端口 \${LISTEN_PORT} 已被其它进程占用："
  ss -lntup 2>/dev/null | grep -E ":\${LISTEN_PORT}[[:space:]]" || true
  echo "  请换一个监听端口，或先停掉占用方再重跑"
  exit 1
fi

# 目标探测：按顺序取第一个能建立 TCP 连接的。gost 只下发一个目标，
# 切换只发生在「安装 / 重跑脚本」时；agent 托管的中转机由每轮收敛重新选目标
pick_target() {
  local t h p
  for t in "\${TARGETS[@]}"; do
    h="\${t%:*}"; p="\${t##*:}"
    if command -v nc >/dev/null 2>&1; then
      nc -z -w 2 "$h" "$p" >/dev/null 2>&1 && { echo "$t"; return 0; }
    else
      (exec 3<>"/dev/tcp/$h/$p") 2>/dev/null && { echo "$t"; return 0; }
    fi
  done
  return 1
}

echo "→ 探测目标（按顺序第一个可达）"
PICK=$(pick_target || true)
if [ -z "$PICK" ]; then
  echo "! 所有目标都不可达，先按第一个写入：\${TARGETS[0]}（恢复后重跑本脚本即可重选）"
  PICK="\${TARGETS[0]}"
fi
TARGET_ADDR="$PICK"
echo "  使用目标：$TARGET_ADDR"

echo "→ 写入配置 \$ENV_FILE"
mkdir -p /etc/gost
cat > "$ENV_FILE" <<EOF
# nodepanel relay \${RELAY_ID}
NP_LISTEN=\${LISTEN_PORT}
# 单目标：由脚本按 TARGETS 顺序探测后选出
NP_TARGET=\${TARGET_ADDR}
EOF

if [ "$SVC_KIND" = systemd ]; then
  echo "→ 写入 systemd unit \$UNIT"
  # heredoc 用 'EOF' 禁止 bash 展开：unit 里的 \${NP_LISTEN}/\${NP_TARGET}
  # 是给 systemd 的 EnvironmentFile 变量，必须原样落盘；其余值由面板直接拼好
  cat > "/etc/systemd/system/\$UNIT" <<'EOF'
[Unit]
Description=nodepanel relay ${id} (${listenPort} -> ${targets.length > 1 ? `${targets.length} targets` : `${target}:${targetPort}`})
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/gost/relay-${id}.env
ExecStart=/usr/local/bin/gost ${execArgs}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$UNIT"
  _active() { systemctl is-active --quiet "$UNIT" 2>/dev/null; }
  _logs() { systemctl status "$UNIT" --no-pager -n 20 2>/dev/null || true; }
else
  echo "→ 写入 OpenRC 服务 \$SVC_FILE"
  # OpenRC 没有 EnvironmentFile：监听端口与目标直接写进 init 脚本
  cat > "$SVC_FILE" <<EOF
#!/sbin/openrc-run
name="\$SERVICE"
description="nodepanel relay \$RELAY_ID"
command="\$GOST_BIN"
command_args="${openrcArgs}"
command_background=true
pidfile="/run/\$SERVICE.pid"
EOF
  chmod +x "$SVC_FILE"
  rc-update add "$SERVICE" default >/dev/null 2>&1 || true
  rc-service "$SERVICE" restart >/dev/null 2>&1 || rc-service "$SERVICE" start >/dev/null 2>&1 || true
  _active() { rc-service "$SERVICE" status >/dev/null 2>&1; }
  _logs() { rc-service "$SERVICE" status 2>&1 || true; }
fi

# 端口自检：服务 active 但端口没监听 = applied 也是假的，必须当场戳穿
sleep 1
OK=0
if _active && ss -lntu 2>/dev/null | grep -E ":\${LISTEN_PORT}[[:space:]]" >/dev/null; then
  OK=1
  echo "✓ gost 转发已生效（\$SVC_KIND）：本机 :\${LISTEN_PORT} → \${TARGET_ADDR}"
  echo "  目标列表（按顺序故障切换）：${targetListText(targets)}"
else
  echo "✗ 服务已提交但端口未监听，排查："
  _logs
  exit 1
fi
${relayAck()}

echo ""
echo "提示："
if [ "$SVC_KIND" = systemd ]; then
  echo "  · 服务名：\$UNIT（journalctl -u \$UNIT -f 看实时日志）"
else
  echo "  · 服务名：\$SERVICE（rc-service \$SERVICE status / /var/log/gost-relay-\${RELAY_ID}.log）"
fi
echo "  · 记得在中转服务器放行 \${LISTEN_PORT} 端口（安全组 / 防火墙）"
`;
  }

  if (mode === 'uninstall') {
    return `${relayHeader({ rule, mode, panelUrl, site, comment: `移除 gost-relay-${id} 服务（systemd unit / OpenRC init）与 env` })}
GOST_BIN=/usr/local/bin/gost
UNIT="gost-relay-\${RELAY_ID}.service"
SERVICE="gost-relay-\${RELAY_ID}"
SVC_FILE="/etc/init.d/\${SERVICE}"
ENV_FILE="/etc/gost/relay-\${RELAY_ID}.env"

${relayRootCheck()}
if command -v systemctl >/dev/null 2>&1; then
  echo "→ 停止并移除 systemd unit \$UNIT"
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/\$UNIT"
  systemctl daemon-reload
fi
if command -v rc-service >/dev/null 2>&1; then
  if [ -f "$SVC_FILE" ]; then
    echo "→ 停止并移除 OpenRC 服务 \$SERVICE"
    rc-service "$SERVICE" stop >/dev/null 2>&1 || true
    rc-update del "$SERVICE" default >/dev/null 2>&1 || true
    rm -f "$SVC_FILE" "/run/\$SERVICE.pid"
  fi
fi
rm -f "$ENV_FILE"

OK=1
echo "✓ 卸载完成：中转规则已从中转服务器移除"
echo "  面板里的规则记录还在，重新生成 install 脚本执行即可恢复。"

# --purge：所有中转规则都清完时连 gost 二进制一起删（保守：还有别的规则就不动）
if [ "\${1:-}" = '--purge' ] && ! ls /etc/systemd/system/gost-relay-*.service /etc/init.d/gost-relay-* >/dev/null 2>&1; then
  rm -f "$GOST_BIN"
  echo "✓ 已删除 \$GOST_BIN（最后一个中转规则）"
fi

${relayAck()}
`;
  }

  // check：服务 active + 端口真的在监听才算存活（systemd / OpenRC 都认）
  return `${relayHeader({ rule, mode, panelUrl, site, comment: '只读检查：gost-relay 服务与端口监听状态' })}
LISTEN_PORT=${listenPort}
UNIT="gost-relay-\${RELAY_ID}.service"
SERVICE="gost-relay-\${RELAY_ID}"
SVC_FILE="/etc/init.d/\${SERVICE}"

${relayRootCheck()}
OK=0
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "$UNIT" 2>/dev/null && ss -lntu 2>/dev/null | grep -E ":\${LISTEN_PORT}[[:space:]]" >/dev/null; then
    OK=1
    echo "✓ 规则存活：systemd \$UNIT active，端口 \${LISTEN_PORT} 监听中"
  else
    echo "✗ 规则不在运行（未安装或已停止）"
    systemctl status "$UNIT" --no-pager -n 5 2>/dev/null || echo "  （unit 不存在）"
  fi
elif command -v rc-service >/dev/null 2>&1; then
  if [ -f "$SVC_FILE" ] && rc-service "$SERVICE" status >/dev/null 2>&1 && ss -lntu 2>/dev/null | grep -E ":\${LISTEN_PORT}[[:space:]]" >/dev/null; then
    OK=1
    echo "✓ 规则存活：OpenRC \$SERVICE started，端口 \${LISTEN_PORT} 监听中"
  else
    echo "✗ 规则不在运行（未安装或已停止）"
    rc-service "$SERVICE" status 2>&1 || echo "  （OpenRC 服务不存在）"
  fi
else
  echo "✗ 未找到 systemd / OpenRC"
fi

${relayAck()}
`;
}

/**
 * 中转机 agent 用的「收敛脚本」：把本机规则同步成面板当前期望的那一组。
 *
 * 和 buildRelayRuleScript（手动三态脚本）的区别：
 *   · 没有 ack / 回执凭证：状态由 agent 的 receipt 统一上报，不再走 /api/relay/ack
 *   · 幂等收敛而不是安装/卸载二选一：先删「本机有、面板已不要」的规则，再写期望规则，
 *     所以面板删规则、改端口、换 tool 都能在下一轮自动生效
 *   · POSIX sh：bundle 是 `sh` 执行的，不能用 bash 数组 / pipefail
 *
 * 命名与手动脚本完全一致（gost-relay-<id>.service / np-relay:<id>），两条通道可以互相接手。
 */
function buildRelaySyncScript({ rules = [], githubProxy = '', probe = [] } = {}) {
  const gostRules = rules.filter((r) => r.tool === 'gost');
  const iptRules = rules.filter((r) => r.tool === 'iptables');
  const idList = (list) => `' ${list.map((r) => shellSafe(r.id)).join(' ')} '`;
  const proxy = shellSafe(String(githubProxy || ''));

  /**
   * 入口机视角诊断（面板点「从入口机检测」后的一次性探测）。
   * 只在这一轮 bundle 里生成，探测结果写 JSON 文件，agent 随回执带回后删除。
   * 延迟用 curl 的 time_connect（TCP 握手耗时），目标可能是任意 TCP 端口。
   */
  const probeBlock = (list) => {
    if (!Array.isArray(list) || !list.length) return '';
    const chunks = [];
    chunks.push(`
# ---- 入口机视角诊断（面板触发的一次性探测） ----
_probe_file="/opt/nodepanel/relay-probe.json"
mkdir -p /opt/nodepanel
if command -v curl >/dev/null 2>&1; then
  {
    printf '{'
    _rsep=''`);
    for (const p of list) {
      const id = shellSafe(p.id);
      chunks.push(`    printf '%s"${id}":{"at":"%s","targets":[' "$_rsep" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    _rsep=','
    _tsep=''`);
      for (const t of p.targets || []) {
        const host = shellSafe(t.host);
        const port = Number(t.port) || 443;
        chunks.push(`    _tc=$(curl -s -o /dev/null --connect-timeout 3 --max-time 4 -w '%{time_connect}' "http://${host}:${port}/" 2>/dev/null)
    _ok=false; _ms=0; _err=unreachable
    case "$_tc" in ''|0|0.000000) ;; *) _ok=true; _err=''; _ms=$(printf '%s' "$_tc" | awk '{printf "%d", $1*1000}') ;; esac
    printf '%s{"host":"${host}","port":${port},"ok":%s,"ms":%s,"error":"%s"}' "$_tsep" "$_ok" "$_ms" "$_err"
    _tsep=','`);
      }
      chunks.push(`    printf ']}'`);
    }
    chunks.push(`    printf '}'
  } > "$_probe_file" 2>/dev/null
  echo "· 入口机诊断完成：$_probe_file"
else
  echo "! 未找到 curl：无法从入口机执行诊断"
fi
`);
    return chunks.join('\n');
  };

  const gostBlock = (r) => {
    const id = shellSafe(r.id);
    const listen = Number(r.listenPort) || 443;
    const targets = relayTargets(r);
    const targetList = targets.map((t) => `${t.host}:${t.port}`).join(' ');
    const forwards = r.proto === 'both' ? ['tcp', 'udp'] : [r.proto === 'udp' ? 'udp' : 'tcp'];
    // 不用 gost 的 strategy/max_fails 参数（版本兼容性不一致，unit 可能直接起不来）。
    // 每轮探测选第一个可达目标，单目标下发；切换粒度 = 收敛周期。
    const execArgs = forwards.map((p) => `-L ${p}://:\${NP_LISTEN}/\${NP_TARGET}`).join(' ');
    const openrcArgs = forwards.map((p) => `-L ${p}://:${listen}/$PICK`).join(' ');
    return `
# ---- gost 规则 ${id} ----
NP_TARGETS='${targetList}'
PICK=''
for _t in $NP_TARGETS; do
  _h=\${_t%:*}; _p=\${_t##*:}
  if command -v nc >/dev/null 2>&1 && nc -z -w 2 "$_h" "$_p" >/dev/null 2>&1; then PICK=$_t; break; fi
done
if [ -z "$PICK" ]; then
  for _t in $NP_TARGETS; do PICK=$_t; break; done
  echo "! gost 规则 ${id}：目标都不可达，暂用 $PICK"
  NP_FAIL=1
fi
mkdir -p /etc/gost
cat > "/etc/gost/relay-${id}.env" <<NP_ENV_EOF
NP_LISTEN=${listen}
NP_TARGET=$PICK
NP_ENV_EOF
if command -v systemctl >/dev/null 2>&1; then
  cat > "/etc/systemd/system/gost-relay-${id}.service" <<'NP_UNIT_EOF'
[Unit]
Description=nodepanel relay ${id} (${targets.length} targets)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/gost/relay-${id}.env
ExecStart=/usr/local/bin/gost ${execArgs}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
NP_UNIT_EOF
  systemctl daemon-reload >/dev/null 2>&1 || true
  if systemctl enable --now "gost-relay-${id}.service" >/dev/null 2>&1; then
    echo "✓ gost 规则就位 ${id}（systemd · :${listen} → $PICK）"
  else
    echo "! gost 规则启动失败 ${id}：journalctl -u gost-relay-${id} -n 20"
    NP_FAIL=1
  fi
elif command -v rc-service >/dev/null 2>&1; then
  # Alpine / OpenRC：写 init 脚本。没有 /etc/systemd/system 时不能硬写 unit
  cat > "/etc/init.d/gost-relay-${id}" <<NP_SVC_EOF
#!/sbin/openrc-run
name="gost-relay-${id}"
description="nodepanel relay ${id}"
command="/usr/local/bin/gost"
command_args="${openrcArgs}"
command_background=true
pidfile="/run/gost-relay-${id}.pid"
NP_SVC_EOF
  chmod +x "/etc/init.d/gost-relay-${id}"
  rc-update add "gost-relay-${id}" default >/dev/null 2>&1 || true
  if rc-service "gost-relay-${id}" restart >/dev/null 2>&1 || rc-service "gost-relay-${id}" start >/dev/null 2>&1; then
    echo "✓ gost 规则就位 ${id}（OpenRC · :${listen} → $PICK）"
  else
    echo "! gost 规则启动失败 ${id}：rc-service gost-relay-${id} status"
    NP_FAIL=1
  fi
else
  echo "! 未找到 systemd / OpenRC：gost 规则无法常驻（可改用 iptables 规则）"
  NP_FAIL=1
fi
# 入口流量计数（gost 没有 DNAT 规则可挂计数器）：往固定计数链里插一条 RETURN 规则。
# 规则只建一次、不重建，所以计数器跨轮累积；agent 每轮读它上报。
if [ "$HAS_COMMENT" = '1' ]; then
  iptables -t nat -N NP_RELAY_COUNT 2>/dev/null || true
  iptables -t nat -C PREROUTING -j NP_RELAY_COUNT 2>/dev/null || iptables -t nat -A PREROUTING -j NP_RELAY_COUNT || true
  for _cp in ${forwards.join(' ')}; do
    iptables -t nat -C NP_RELAY_COUNT -p $_cp --dport ${listen} -m comment --comment np-relay-count:${id} -j RETURN 2>/dev/null \
      || iptables -t nat -A NP_RELAY_COUNT -p $_cp --dport ${listen} -m comment --comment np-relay-count:${id} -j RETURN || NP_FAIL=1
  done
fi
`;
  };

  const iptBlock = (r) => {
    const id = shellSafe(r.id);
    const listen = Number(r.listenPort) || 443;
    const targets = relayTargets(r);
    const targetList = targets.map((t) => `${t.host}:${t.port}`).join(' ');
    const protos = r.proto === 'both' ? ['tcp', 'udp'] : [r.proto === 'udp' ? 'udp' : 'tcp'];
    const dnat = protos
      .map((p) => `add_rule PREROUTING -p ${p} --dport ${listen} -j DNAT --to-destination "$_h:$_p" $TAG || NP_FAIL=1`)
      .join('\n');
    const checks = protos
      .map((p) => `iptables -t nat -C PREROUTING -p ${p} --dport ${listen} -j DNAT --to-destination "$_h:$_p" $TAG 2>/dev/null || _need=1`)
      .join('\n');
    return `
# ---- iptables 规则 ${id} ----
TAG=''
[ "$HAS_COMMENT" = '1' ] && TAG='-m comment --comment np-relay:${id}'
NP_TARGETS='${targetList}'
# 按顺序探测，取第一个可达目标；iptables 是静态规则，切换粒度 = 本收敛包的运行周期
PICK=''
for _t in $NP_TARGETS; do
  _h=\${_t%:*}; _p=\${_t##*:}
  # DNAT 只接受 IP：域名先在入口机解析成 IPv4，解析不到就跳过并报明确原因
  _ip=$(resolve_ipv4 "$_h" || true)
  if [ -z "$_ip" ]; then
    echo "! iptables 规则 ${id}：目标 $_h 无法解析为 IPv4（检查入口机 DNS，或直接填 IP）"
    NP_FAIL=1
    continue
  fi
  if command -v nc >/dev/null 2>&1 && nc -z -w 2 "$_ip" "$_p" >/dev/null 2>&1; then PICK="$_ip:$_p"; break; fi
done
if [ -z "$PICK" ]; then
  echo "! iptables 规则 ${id}：没有可用目标，本规则跳过"
  NP_FAIL=1
fi
_h=\${PICK%:*}; _p=\${PICK##*:}
if [ -n "$PICK" ]; then
# 期望规则已经在位就跳过重建：iptables 计数器挂在规则上，每轮重删会让流量统计永远归零
_need=0
iptables -t nat -C POSTROUTING -d "$_h" -j MASQUERADE $TAG 2>/dev/null || _need=1
${checks}
del_tag() {
  iptables -t nat -S "$1" 2>/dev/null | grep -F "np-relay:${id}" | sed "s/^-A $1 //" | while IFS= read -r _r; do
    [ -n "$_r" ] || continue
    iptables -t nat -D "$1" $_r 2>/dev/null || true
  done
}
if [ "$_need" = '1' ]; then
  if [ "$HAS_COMMENT" = '1' ]; then
    del_tag PREROUTING
    del_tag POSTROUTING
  else
    iptables -t nat -S PREROUTING 2>/dev/null | grep -E -- "--dport ${listen}( |$)" | sed 's/^-A PREROUTING //' | while IFS= read -r _r; do
      [ -n "$_r" ] || continue
      iptables -t nat -D PREROUTING $_r 2>/dev/null || true
    done
  fi
  add_rule POSTROUTING -d "$_h" -j MASQUERADE $TAG || NP_FAIL=1
${dnat}
  if [ "$NP_FAIL" = '0' ]; then
    echo "· iptables 规则 ${id} 已更新（使用目标 $_h:$_p，候选 ${targets.length} 个）"
  else
    echo "! iptables 规则 ${id} 写入失败（目标 $_h:$_p 无法转发）"
  fi
else
  echo "· iptables 规则 ${id} 未变化（使用目标 $_h:$_p），保留计数器"
fi
fi
`;
  };

  return `#!/bin/sh
# 中转转发收敛包（由面板生成，agent 每轮幂等执行）
# gost ${gostRules.length} 条 / iptables ${iptRules.length} 条
set -u

NP_FAIL=0
NP_GOST_N=${gostRules.length}
NP_IPT_N=${iptRules.length}
NP_GOST_IDS=${idList(gostRules)}
NP_IPT_IDS=${idList(iptRules)}
# GitHub 反代前缀（面板设置项）；空 = 直连
GOST_PROXY="${proxy}"

# 域名 → IPv4：iptables DNAT 的 --to-destination 只接受 IP。
# 在入口机上解析才有意义（实际转发链路用的是这台机器的 DNS）。
resolve_ipv4() {
  case "$1" in
    *[!0-9.]*) ;;
    *) echo "$1"; return 0 ;;
  esac
  _ip=''
  if command -v getent >/dev/null 2>&1; then
    _ip=$(getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}')
  fi
  if [ -z "$_ip" ] && command -v nslookup >/dev/null 2>&1; then
    _ip=$(nslookup "$1" 2>/dev/null | awk '
      /^Name:/ { seen = 1; next }
      seen && /^Address/ {
        for (i = 2; i <= NF; i++) if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) { print $i; exit }
      }')
  fi
  if [ -z "$_ip" ] && command -v host >/dev/null 2>&1; then
    _ip=$(host "$1" 2>/dev/null | awk '/has address/ { print $4; exit }')
  fi
  [ -n "$_ip" ] || return 1
  echo "$_ip"
}

# 1) 清理面板已经删除的 gost 规则（systemd unit / OpenRC init 都是锚点）
for _f in /etc/systemd/system/gost-relay-*.service; do
  [ -f "$_f" ] || continue
  _id=$(basename "$_f" .service)
  _id=\${_id#gost-relay-}
  case "$NP_GOST_IDS" in
    *" $_id "*) ;;
    *)
      systemctl disable --now "gost-relay-$_id.service" >/dev/null 2>&1 || true
      rm -f "$_f" "/etc/gost/relay-$_id.env"
      echo "· 已移除过期 gost 规则 $_id（systemd）"
      ;;
  esac
done
for _f in /etc/init.d/gost-relay-*; do
  [ -f "$_f" ] || continue
  _id=$(basename "$_f")
  _id=\${_id#gost-relay-}
  case "$NP_GOST_IDS" in
    *" $_id "*) ;;
    *)
      rc-service "gost-relay-$_id" stop >/dev/null 2>&1 || true
      rc-update del "gost-relay-$_id" default >/dev/null 2>&1 || true
      rm -f "$_f" "/run/gost-relay-$_id.pid" "/etc/gost/relay-$_id.env"
      echo "· 已移除过期 gost 规则 $_id（OpenRC）"
      ;;
  esac
done

# 2) 清理面板已经删除的规则（DNAT 标签 np-relay:<id> / gost 计数标签 np-relay-count:<id>）
if command -v iptables >/dev/null 2>&1; then
  for _chain in PREROUTING POSTROUTING NP_RELAY_COUNT; do
    iptables -t nat -S "$_chain" 2>/dev/null | grep -F 'np-relay' | while IFS= read -r _line; do
      _id=$(printf '%s' "$_line" | sed -n 's/.*np-relay-count:\\([A-Za-z0-9]*\\).*/\\1/p')
      _want="$NP_IPT_IDS"
      if [ -n "$_id" ]; then
        _want="$NP_GOST_IDS"
      else
        _id=$(printf '%s' "$_line" | sed -n 's/.*np-relay:\\([A-Za-z0-9]*\\).*/\\1/p')
      fi
      [ -n "$_id" ] || continue
      case "$_want" in
        *" $_id "*) continue ;;
      esac
      _rule=\${_line#-A $_chain }
      iptables -t nat -D "$_chain" $_rule 2>/dev/null || true
      echo "· 已移除过期规则 $_id（$_chain）"
    done
  done
fi

# comment 模块探测：gost 计数规则与 iptables 标签都依赖它，缺失时降级
HAS_COMMENT=0
if command -v iptables >/dev/null 2>&1; then
  iptables -m comment -h >/dev/null 2>&1 && HAS_COMMENT=1
fi

# 3) gost 二进制：只在真有 gost 规则且本机缺它时下载
if [ "$NP_GOST_N" -gt 0 ] && [ ! -x /usr/local/bin/gost ]; then
  case "$(uname -m)" in
    x86_64)          ARCH=amd64 ;;
    aarch64|arm64)   ARCH=arm64 ;;
    *) ARCH='' ;;
  esac
  if [ -z "$ARCH" ]; then
    echo "! 不支持的架构 $(uname -m)：gost 只发 amd64 / arm64，相关规则不会生效"
    NP_FAIL=1
  else
    _GOST_URL="\${GOST_DL_BASE:-https://github.com/go-gost/gost/releases/download}/v${DEFAULT_GOST_VER}/gost_${DEFAULT_GOST_VER}_linux_\${ARCH}.tar.gz"
    # 有反代且机器在中国大陆（或判断不出来）时，把反代拼在 GitHub 地址前；
    # 自定义镜像已经是替代源，不再叠加反代
    if [ -n "$GOST_PROXY" ] && [ -z "\${GOST_DL_BASE:-}" ]; then
      _loc=$(curl -fsS -m 5 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^loc=//p')
      case "$_loc" in
        CN|'') _GOST_URL="\${GOST_PROXY}\${_GOST_URL}" ;;
      esac
    fi
    echo "→ 下载 gost v${DEFAULT_GOST_VER}：$_GOST_URL"
    # 小磁盘机器（Alpine 容器常见 90MB 根分区）：先看可用空间。
    # 流式解压，压缩包不落地，峰值只占最终二进制一份
    _avail=$(df -k /usr/local/bin 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -n "$_avail" ] && [ "$_avail" -lt 61440 ]; then
      echo "! 磁盘空间不足：/usr/local/bin 可用 \${_avail}KB，gost 二进制约 50MB"
      echo "  · 清理 /tmp；或把这条规则改用 iptables（不需要 gost 二进制）"
      NP_FAIL=1
    else
      _tmp="/usr/local/bin/.gost.np-new.$$"
      if curl -fsSL "$_GOST_URL" | tar -xzO gost > "$_tmp" 2>/dev/null && [ "$(wc -c < "$_tmp")" -gt 20971520 ]; then
        chmod 755 "$_tmp"
        mv -f "$_tmp" /usr/local/bin/gost
        echo "✓ gost v${DEFAULT_GOST_VER} 已安装"
      else
        rm -f "$_tmp"
        echo "! gost 下载/解压失败：$_GOST_URL"
        echo "  · 404 = 版本 / 资产名不存在；连不上 = 配置 GitHub 反代；No space left = 磁盘不足"
        NP_FAIL=1
      fi
    fi
  fi
fi

# 4) 应用 gost 规则（unit 覆盖写 + enable --now，幂等）
${gostRules.map(gostBlock).join('')}
# 5) 应用 iptables 规则（内核态 DNAT）
if [ "$NP_IPT_N" -gt 0 ]; then
  # 缺 iptables 时自动安装：Alpine 默认不装，用户环境就是这种情况
  if ! command -v iptables >/dev/null 2>&1; then
    echo "→ 未检测到 iptables，尝试自动安装"
    if command -v apk >/dev/null 2>&1; then
      apk add --no-cache iptables 2>&1 | tail -n 3
    elif command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables 2>&1 | tail -n 3
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y iptables 2>&1 | tail -n 3
    elif command -v yum >/dev/null 2>&1; then
      yum install -y iptables 2>&1 | tail -n 3
    elif command -v pacman >/dev/null 2>&1; then
      pacman -Sy --noconfirm iptables 2>&1 | tail -n 3
    elif command -v zypper >/dev/null 2>&1; then
      zypper --non-interactive install iptables 2>&1 | tail -n 3
    fi
    export PATH="$PATH:/usr/sbin:/sbin"
    command -v iptables >/dev/null 2>&1 && echo "✓ iptables 已安装"
  fi
  if ! command -v iptables >/dev/null 2>&1; then
    echo "! iptables 自动安装失败：请手动安装（Alpine: apk add iptables）"
    NP_FAIL=1
  else

    [ "$HAS_COMMENT" = '1' ] || echo "! iptables 缺少 comment 模块：规则不带标签，面板删规则后需手动清理"
    sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
    if grep -q '^net.ipv4.ip_forward' /etc/sysctl.conf 2>/dev/null; then
      sed -i 's/^net.ipv4.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf 2>/dev/null || true
    else
      echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf 2>/dev/null || true
    fi
    add_rule() { iptables -t nat -C "$@" 2>/dev/null || iptables -t nat -A "$@"; }
${iptRules.map(iptBlock).join('')}
    # 持久化：Debian 系用 netfilter-persistent；Alpine 用 OpenRC 的 iptables 服务
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save >/dev/null 2>&1 || true
    elif [ -f /etc/init.d/iptables ] && command -v rc-service >/dev/null 2>&1; then
      rc-update add iptables default >/dev/null 2>&1 || true
      rc-service iptables save >/dev/null 2>&1 || {
        mkdir -p /etc/iptables 2>/dev/null || true
        iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
      }
    elif command -v iptables-save >/dev/null 2>&1; then
      mkdir -p /etc/iptables 2>/dev/null || true
      iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    fi
  fi
fi

if [ "$NP_FAIL" = '0' ]; then
  echo "✓ 中转规则已收敛（gost ${gostRules.length} 条 / iptables ${iptRules.length} 条）"
else
  echo "✗ 中转规则收敛失败（gost ${gostRules.length} 条 / iptables ${iptRules.length} 条）"
fi
${probeBlock(probe)}
[ "$NP_FAIL" = '0' ] || exit 1
`;
}

/** 按 tool 分发：gost / iptables 各自的三态生成器 */
function buildRelayRuleScript({ rule, mode = 'install', panelUrl = '' }) {
  const gen = rule.tool === 'iptables' ? buildIptablesRelayScript : buildGostRelayScript;
  // gost 下载可能要用面板设置里的 GitHub 反代前缀；iptables 生成器会忽略这个字段
  return gen({ rule, mode, panelUrl, githubProxy: store.db().settings.githubProxy || '' });
}

module.exports = {
  buildInstallScript,
  readAgentSource,
  buildUninstallScript,
  buildRelayScript,
  buildRelayRuleScript,
  buildRelaySyncScript,
  relayTarget,
  GOST_VER_RE,
  shellSafe,
};
