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
const path = require('path');
const store = require('../lib/store');

// 与 server.js 指向同一文件；版本号仍以 package.json 为唯一来源
const AGENT_FILE = path.join(__dirname, '..', 'agent', 'agent.sh');
const APP_VERSION = require('../package.json').version;

function buildInstallScript({ panelUrl, token, label, needHysteria, needXray, agentSrc }) {
  // 面板地址来自请求头，插进 shell 之前先去掉能掀起风浪的字符
  const safeUrl = String(panelUrl || '').replace(/["'`\\\s$]/g, '');
  // 名称会进双引号变量：换行撕开语句，引号/反引号/$ 能跑命令
  const safeLabel = String(label || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/["`\\$]/g, '');
  return `#!/bin/sh
# ${store.db().settings.siteName} · 节点部署脚本
# 目标：${safeLabel}
# 生成时间：${new Date().toISOString()}
#
# 幂等：重复执行只覆盖 agent 与配置，不重复堆积东西。
# 已有 Xray 安装（xray / xray-core / x-ui）不会被覆盖；SKIP_XRAY=1 可跳过 Xray 安装。
set -u

PANEL_URL="${safeUrl}"
AGENT_TOKEN="${token}"
TARGET_LABEL="${safeLabel}"
NEED_HYSTERIA="${needHysteria ? '1' : '0'}"
NEED_XRAY="${needXray ? '1' : '0'}"
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
printf '  xray       %s\\n' "$XRAY_LINE"
printf '  hysteria2  %s\\n' "$HY_LINE"
printf '  配置       %s\\n' "$XRAY_ETC/config.json"
printf '  状态       %s\\n' '/opt/nodepanel/state.env'
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
function buildUninstallScript({ label }) {
  // 同上：名称里的换行会把注释行撕开
  const safeLabel = String(label || '').replace(/[\r\n]+/g, ' ');
  return `#!/bin/sh
# ${store.db().settings.siteName} · 节点卸载脚本
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

echo "→ 删除 agent 文件与运行时目录"
rm -rf "$AGENT_DIR" "$RUN_DIR"
echo "  ✓ 已删除 $AGENT_DIR 与 $RUN_DIR"

# agent 现场生成 / 落盘的自签证书：机器上再没有东西引用它们
if [ -d "$CERTS_DIR" ]; then
  rm -rf "$CERTS_DIR"
  echo "  ✓ 已删除自签证书目录 $CERTS_DIR"
fi

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
echo "✓ 卸载完成：agent 已注销，节点端口不再监听"
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
  const target = String(to || '').trim();
  const listenPort = Number(port) || 443;
  const protocols = proto === 'both' ? ['tcp', 'udp'] : [proto];

  const dnatRules = protocols.map(
    (p) => `add_rule PREROUTING -p ${p} --dport "\${LISTEN_PORT}" -j DNAT --to-destination "\${TARGET_HOST}:\${TARGET_PORT}"`,
  );

  return `#!/usr/bin/env bash
# ${store.db().settings.siteName} · 中转部署脚本
# ${label ? label + '\n# ' : ''}把本机 \${LISTEN_PORT} 的流量转发到 \${TARGET_HOST}:\${TARGET_PORT}
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

if ! command -v iptables >/dev/null 2>&1; then
  echo "✗ 未检测到 iptables，请先安装：apt install -y iptables"
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

module.exports = {
  buildInstallScript,
  readAgentSource,
  buildUninstallScript,
  buildRelayScript,
};
