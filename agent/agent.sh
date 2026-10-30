#!/bin/sh
# ============================================================================
# Node Panel Agent · POSIX shell 实现
#
# 设计目标：任何主流 Linux（Debian / Ubuntu / CentOS / Rocky / Alpine …）
# 不装任何额外运行时就能跑，空闲时几乎不占内存 —— 64MB 的 Alpine 小鸡也扛得住。
#
#   · 不依赖 Node / Python / jq，只用 busybox 都有的 sh + sed + awk + base64
#   · 不常驻内存：脚本本体常驻约 2MB，配置与流量采集都在子进程里做完即释放
#   · 配置由面板编译成 shell 配置包下发（见 lib/agentBundle.js），本脚本只负责
#     「比对 hash → 执行配置包 → 收敛服务 → 端口自检 → 采流量上报」
#   · Hysteria2 用 pid 文件自己托管，不依赖 systemd / OpenRC 的模板单元
#
# 环境变量（写在同目录 agent.env，或用环境变量覆盖）：
#   PANEL_URL        面板地址，必填
#   AGENT_TOKEN      服务器 token 或独立节点 token，必填
#   INTERVAL         轮询间隔秒数，默认 60
#   XRAY_CONFIG      Xray 配置路径，默认 /usr/local/etc/xray/config.json
#   XRAY_ALIAS       Xray 的本地伪装名（二进制/服务/进程名），默认 xray。
#                    0.1.9 起部署脚本全新安装时默认 webcore：二进制、systemd 单元、
#                    配置目录全部换成这个名字，机器上看不到「xray」字样；
#                    老机器 agent.env 没写这一项，就继续用官方名，互不影响
#   RELOAD_CMD       重载 Xray 的命令，默认自动探测
#   SOCK_CMD         端口自检用的命令，默认自动用 ss / netstat（每行「协议 本地地址」）
#   HYSTERIA_DIR     Hysteria2 配置目录，默认 /etc/hysteria（伪装部署为 /etc/streamd）
#   HYSTERIA_BIN     hysteria 可执行文件，默认 /usr/local/bin/hysteria（伪装部署为
#                    /usr/local/bin/streamd —— 名字改了，二进制本身没动）
#   ORPHAN_GRACE     面板回 401 持续多少秒后转低频重试，默认 21600（6 小时）。
#                    401 的含义是「面板上没有这个 token 了」（服务器 / 节点记录被删，
#                    或 token 被重置），和「连不上面板」是两回事 —— 后者永远按正常
#                    间隔重试，绝不能因为网络抖动就降低一台活节点的轮询频率
#   ORPHAN_INTERVAL  转低频之后的轮询间隔秒数，默认 1800（30 分钟）
#   STATE_DIR        状态目录，默认 /opt/nodepanel
#   RUN_DIR          运行时目录（pid），默认 /run/nodepanel
#   LOG_DIR          日志目录，默认 /var/log/nodepanel
#
# 用法：
#   sh agent.sh            常驻循环（systemd / OpenRC 用这个）
#   sh agent.sh --once     只跑一轮（cron 用这个）
#   sh agent.sh --uninstall [--purge]
#                          在本机把自己卸干净（不联网、不依赖面板）
#   sh agent.sh --version
# ============================================================================

# 版本号和面板 package.json 保持一致：部署脚本会把这一行替换成面板当前版本，
# 面板据此判断「agent 是不是该重新部署了」，两边版本号必须同一处来源
VERSION='0.1.17'

SELF_DIR=$(dirname "$0")
# 自更新要原子替换「自己」，所以必须拿到绝对路径（cron 里 $0 常常是相对路径）
SELF_PATH=$0
case "$SELF_PATH" in
  /*) : ;;
  *) SELF_PATH=$(cd "$SELF_DIR" 2>/dev/null && pwd)/$(basename "$0") ;;
esac
# 自更新后 exec 重启要用同一批参数，函数里的 $@ 不是脚本参数
RUN_ARGS="$*"
ENV_FILE=${AGENT_ENV:-$SELF_DIR/agent.env}

# 本轮「配置应用结果」的聚合状态，回执用。
# 这几个变量由 reload_xray / hy_sync / probe_ports 写入，tick() 读完就重置。
#   RC_OK    1=一切正常，0=有失败（面板上标红）
#   RC_XRAY  ok / fail / skip
#   RC_HY    「跑起来的实例数/期望实例数」，没有 Hysteria2 节点时为空
#   BAD_PORTS 本轮没在监听的端口（tcp:42000,udp:8443），面板据此报「端口未监听」
RC_OK=1
RC_XRAY=''
RC_HY=''
RC_HY_FAIL=''
RC_ERR=''
BAD_PORTS=''
# reload / start 之后端口 bind 需要一点时间，自检前先等一下
NP_JUST_RESTARTED=0

# 读 agent.env 里的 key=value，但**绝不 source 它**。
# 原因：值里带空格时（RELOAD_CMD=systemctl restart xray），source 会把空格后面那截
# 当成另一条命令去执行，日志里就会一直刷
#   /opt/nodepanel/agent.sh: . /opt/nodepanel/agent.env: restart: not found
# 而且 RELOAD_CMD 会被悄悄清空，Xray 再也重载不了。
env_read() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" 2>/dev/null \
    | tr -d '\r' \
    | tail -n 1 \
    | sed "s/[[:space:]]*$//; s/^'\(.*\)'$/\1/; s/^\"\(.*\)\"$/\1/"
}

if [ -f "$ENV_FILE" ]; then
  for _env_key in PANEL_URL AGENT_TOKEN INTERVAL XRAY_ALIAS XRAY_CONFIG RELOAD_CMD HYSTERIA_DIR \
                  HYSTERIA_BIN HYSTERIA_AUTO_INSTALL STATE_DIR RUN_DIR LOG_DIR HTTP_TIMEOUT LOG_MAX \
                  ACME_SH ACME_EMAIL REPORT_IP SOCK_CMD ORPHAN_GRACE ORPHAN_INTERVAL; do
    _env_val=$(env_read "$_env_key")
    [ -n "$_env_val" ] || continue
    # 赋值语境下不做分词，带空格的值能原样存进变量
    eval "$_env_key=\$_env_val"
  done
fi

PANEL_URL=${PANEL_URL:-}
AGENT_TOKEN=${AGENT_TOKEN:-}
INTERVAL=${INTERVAL:-60}
XRAY_ALIAS=${XRAY_ALIAS:-xray}
XRAY_CONFIG=${XRAY_CONFIG:-/usr/local/etc/xray/config.json}
HYSTERIA_DIR=${HYSTERIA_DIR:-/etc/hysteria}
HYSTERIA_BIN=${HYSTERIA_BIN:-/usr/local/bin/hysteria}
# 配置包（bundle）是「sh 子进程」执行的：不 export 的话，里面引用的
# $XRAY_CONFIG / $HYSTERIA_DIR / $HYSTERIA_BIN 全是空的，文件会写到别处去
export XRAY_CONFIG HYSTERIA_DIR HYSTERIA_BIN
# 有 hy2 实例却没有二进制时自己装一个（见 hy_install）；关掉就只记日志
HYSTERIA_AUTO_INSTALL=${HYSTERIA_AUTO_INSTALL:-1}
STATE_DIR=${STATE_DIR:-/opt/nodepanel}
RUN_DIR=${RUN_DIR:-/run/nodepanel}
LOG_DIR=${LOG_DIR:-/var/log/nodepanel}
HTTP_TIMEOUT=${HTTP_TIMEOUT:-15}
LOG_MAX=${LOG_MAX:-5242880}
# 关掉公网 IP 上报：面板在反代后面、或者只想手动填地址时用
REPORT_IP=${REPORT_IP:-1}
# 401 宽限期与降级后的轮询间隔。宽限期要足够长：面板换域名、临时迁移、从备份恢复
# 都可能让 token 短暂对不上，几分钟的宽限会把一整片节点误判成「已被删除」
ORPHAN_GRACE=${ORPHAN_GRACE:-21600}
ORPHAN_INTERVAL=${ORPHAN_INTERVAL:-1800}

# 401 状态：0=正常；1=已过宽限期，本轮起转低频重试
NP_ORPHAN=0
# 本轮取包拿到的 HTTP 状态码（000 = 连不上 / 拿不到），由 fetch_bundle 写入
NP_HTTP_CODE=''

# 看版本不需要配置：装好没装好、装的是哪一版，先问这个最省事
case "${1:-}" in
  --version | -v)
    echo "nodepanel-agent $VERSION (shell)"
    exit 0
    ;;
  --uninstall)
    # 卸载会删掉脚本自己所在的目录：先把自己拷到 /tmp 再 exec，
    # 免得某些 shell 边读边执行时读到已经被 unlink 的文件。
    # 真正的清理逻辑在 np_uninstall（文件末尾），这里只负责换个安全的位置执行它
    _np_tmp="/tmp/.nodepanel-uninstall.$$"
    if cp -f "$SELF_PATH" "$_np_tmp" 2>/dev/null && chmod 700 "$_np_tmp" 2>/dev/null; then
      # AGENT_ENV 必须带过去：副本的 SELF_DIR 是 /tmp，读不到原来的 agent.env，
      # 就不知道 XRAY_ALIAS / HYSTERIA_DIR 这些伪装名，清理会漏掉真正在跑的那套
      _np_env=$(cd "$SELF_DIR" 2>/dev/null && pwd)/agent.env
      AGENT_ENV=$_np_env exec sh "$_np_tmp" __np_uninstall "$@"
    fi
    echo "✗ 无法把脚本复制到 /tmp，卸载中止（面板上的卸载命令同样能用）" >&2
    exit 1
    ;;
esac

# 卸载不需要配置：面板删了、token 失效了、agent.env 被手删了，都得能卸
case "${1:-}" in
  __np_uninstall) NP_MODE='uninstall' ;;
  *) NP_MODE='run' ;;
esac

if [ "$NP_MODE" = 'run' ] && { [ -z "$PANEL_URL" ] || [ -z "$AGENT_TOKEN" ]; }; then
  echo "✗ 缺少 PANEL_URL 或 AGENT_TOKEN，请检查 $SELF_DIR/agent.env" >&2
  exit 1
fi
PANEL_URL=${PANEL_URL%/}

# 卸载模式不要建目录：正要删的东西被重新 mkdir 出来，
# 会让「本来就没有 /var/log/nodepanel」的机器卸完反而多一个空目录
if [ "$NP_MODE" = 'run' ]; then
  mkdir -p "$STATE_DIR" "$RUN_DIR" "$LOG_DIR" 2>/dev/null
fi

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# ------------------------------- HTTP 客户端 --------------------------------
# 优先 curl，退回 busybox 自带的 wget —— 两者都不装才算真的缺依赖

if command -v curl >/dev/null 2>&1; then
  HTTP=curl
elif command -v wget >/dev/null 2>&1; then
  HTTP=wget
else
  HTTP=''
fi

http_get() {
  _u=$1
  _h=${2:-}
  _t=${3:-$HTTP_TIMEOUT}
  [ -n "$HTTP" ] || return 1
  if [ "$HTTP" = 'curl' ]; then
    if [ -n "$_h" ]; then
      curl -fsS -m "$_t" -H "$_h" "$_u" 2>/dev/null
    else
      curl -fsS -m "$_t" "$_u" 2>/dev/null
    fi
  else
    if [ -n "$_h" ]; then
      wget -q -T "$_t" -O - --header="$_h" "$_u" 2>/dev/null
    else
      wget -q -T "$_t" -O - "$_u" 2>/dev/null
    fi
  fi
}

# 带状态码的 GET：body 落到第三个参数指定的文件，stdout 只留 HTTP 状态码。
#
# 为什么不能直接用 http_get：curl -f 遇到 4xx 直接失败并丢掉 body，
# 于是「面板明确回 401：这个 token 我已经不认了」被抹平成「连不上」——
# 面板上删了服务器 / 节点之后，agent 就永远只剩一句「✗ 无法连接面板」，
# 既不知道自己在面板上已经不存在了，也没法做出任何反应。
#
# 拿不到状态码时返回 000：连不上、DNS 失败、面板没起、只有 wget 且撞上 4xx，
# 全归到这一类 —— 调用方必须把它当「暂时状态」，绝不能当成「我被删了」。
http_probe() {
  _u=$1
  _h=${2:-}
  _o=$3
  : > "$_o" 2>/dev/null
  [ -n "$HTTP" ] || { printf '000'; return 0; }
  if [ "$HTTP" = 'curl' ]; then
    # -w '%{http_code}' 在连不上时输出 000、退出码非 0，两种都按 000 处理
    if [ -n "$_h" ]; then
      _code=$(curl -sS -m "$HTTP_TIMEOUT" -o "$_o" -w '%{http_code}' -H "$_h" "$_u" 2>/dev/null) || _code=000
    else
      _code=$(curl -sS -m "$HTTP_TIMEOUT" -o "$_o" -w '%{http_code}' "$_u" 2>/dev/null) || _code=000
    fi
    case "$_code" in '' | *[!0-9]*) _code=000 ;; esac
    printf '%s' "$_code"
  else
    # wget 分支拿不到状态码（4xx 也只是一句失败），只能区分「成功 / 没成功」，
    # 401 的判定在只有 wget 的机器上会退化成旧行为，不影响正常取包
    if [ -n "$_h" ]; then
      wget -q -T "$HTTP_TIMEOUT" -O "$_o" --header="$_h" "$_u" 2>/dev/null && printf '200' || printf '000'
    else
      wget -q -T "$HTTP_TIMEOUT" -O "$_o" "$_u" 2>/dev/null && printf '200' || printf '000'
    fi
  fi
}

# 第三个参数是可选的额外请求头（"Key: value" 形式）。
# 0.1.8 起对面板的请求把 token 放进 Authorization 头；URL 里仍保留一份 query token
# （双发过渡）：面板升级后、本机 agent 自更新完成前，老面板只认 query，双发保证不掉线。
# 计划 0.2.0 移除 query 里的 token —— 那会落进反代 access log 和 shell history，泄露面大得多。
http_post() {
  _u=$1
  _f=$2
  _h=${3:-}
  [ -n "$HTTP" ] || return 1
  if [ "$HTTP" = 'curl' ]; then
    if [ -n "$_h" ]; then
      curl -fsS -m "$HTTP_TIMEOUT" -X POST -H 'Content-Type: text/plain' -H "$_h" --data-binary "@$_f" "$_u" 2>/dev/null
    else
      curl -fsS -m "$HTTP_TIMEOUT" -X POST -H 'Content-Type: text/plain' --data-binary "@$_f" "$_u" 2>/dev/null
    fi
  else
    if [ -n "$_h" ]; then
      wget -q -T "$HTTP_TIMEOUT" -O - --header='Content-Type: text/plain' --header="$_h" --post-file="$_f" "$_u" 2>/dev/null
    else
      wget -q -T "$HTTP_TIMEOUT" -O - --header='Content-Type: text/plain' --post-file="$_f" "$_u" 2>/dev/null
    fi
  fi
}

# 回执 / 其它结构化上报走 JSON；和 http_post 的唯一区别是 Content-Type
http_post_json() {
  _u=$1
  _f=$2
  _h=${3:-}
  [ -n "$HTTP" ] || return 1
  if [ "$HTTP" = 'curl' ]; then
    if [ -n "$_h" ]; then
      curl -fsS -m "$HTTP_TIMEOUT" -X POST -H 'Content-Type: application/json' -H "$_h" --data-binary "@$_f" "$_u" 2>/dev/null
    else
      curl -fsS -m "$HTTP_TIMEOUT" -X POST -H 'Content-Type: application/json' --data-binary "@$_f" "$_u" 2>/dev/null
    fi
  else
    if [ -n "$_h" ]; then
      wget -q -T "$HTTP_TIMEOUT" -O - --header='Content-Type: application/json' --header="$_h" --post-file="$_f" "$_u" 2>/dev/null
    else
      wget -q -T "$HTTP_TIMEOUT" -O - --header='Content-Type: application/json' --post-file="$_f" "$_u" 2>/dev/null
    fi
  fi
}

# 下载到文件。二进制不能用 $(...) 接（NUL 与换行会被吃掉），所以单独一个函数
http_download() {
  _u=$1
  _out=$2
  [ -n "$HTTP" ] || return 1
  if [ "$HTTP" = 'curl' ]; then
    curl -fsSL -m 300 -o "$_out" "$_u" 2>/dev/null
  else
    wget -q -T 300 -O "$_out" "$_u" 2>/dev/null
  fi
}

# --------------------------------- 公网 IP ----------------------------------
# 结果缓存 5 分钟写进文件，cron 模式也不会每分钟去问三次

public_ip() {
  _now=$(date +%s)
  if [ -f "$STATE_DIR/.ip" ]; then
    _ts=$(sed -n '1p' "$STATE_DIR/.ip" 2>/dev/null)
    _ip=$(sed -n '2p' "$STATE_DIR/.ip" 2>/dev/null)
    case "$_ts" in ''|*[!0-9]*) _ts=0 ;; esac
    if [ -n "$_ip" ] && [ $((_now - _ts)) -lt 300 ]; then
      printf '%s' "$_ip"
      return 0
    fi
  fi

  for _u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com https://ip.sb; do
    # 探测源给短超时：一个源卡住不该拖垮整轮
    _ip=$(http_get "$_u" '' 4 | tr -d ' \r\n')
    case "$_ip" in
      '') continue ;;
      *[!0-9a-fA-F.:]*) continue ;;
    esac
    printf '%s\n%s\n' "$_now" "$_ip" > "$STATE_DIR/.ip" 2>/dev/null
    printf '%s' "$_ip"
    return 0
  done
  printf '%s' "$_ip"
}

# -------------------------------- 证书 --------------------------------------

# 自签证书：文件已存在就跳过，所以每轮调用都是安全的
ensure_self_cert() {
  _cn=$1
  _crt=$2
  _key=$3
  [ -n "$_crt" ] && [ -n "$_key" ] || return 0
  [ -f "$_crt" ] && [ -f "$_key" ] && return 0
  if ! command -v openssl >/dev/null 2>&1; then
    log "! 缺少 openssl，无法为 $_cn 生成自签证书（apk add openssl / apt install openssl）"
    return 1
  fi
  mkdir -p "$(dirname "$_crt")" 2>/dev/null
  _cfg="$RUN_DIR/selfsign.$$.cnf"
  cat > "$_cfg" <<EOF
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=$_cn
[v3]
subjectAltName=DNS:$_cn
EOF
  # 用配置文件而不是 -addext，兼容 CentOS 7 自带的 openssl 1.0.2
  if openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout "$_key" -out "$_crt" -config "$_cfg" >/dev/null 2>&1; then
    chmod 600 "$_crt" "$_key" 2>/dev/null
    log "已生成自签证书：$_crt（CN=$_cn，客户端需关闭证书校验）"
  else
    log "! 自签证书生成失败：$_cn"
  fi
  rm -f "$_cfg" 2>/dev/null
}

# 自签证书的 SHA-256 指纹（64 位无冒号小写 hex）。
# Xray-core v25 起 allowInsecure 被整个移除（配置里出现即加载失败），新核心连自签
# 节点的正解是 pinnedPeerCertSha256 —— 但指纹只有本机知道（证书就在这生成的），
# 所以每轮算好放进回执，面板转手写进订阅的 pcs 参数。
# 输出形如「sha256 Fingerprint=AA:BB:…」：取 = 之后、去冒号、转小写；
# -fingerprint -sha256 在 openssl 1.0.2（CentOS 7）就已支持。
self_cert_fp() {
  openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null \
    | sed -n 's/^.*=//p' | tr -d ': \r\n' | tr 'A-F' 'a-f'
}

# 每轮重算指纹清单（幂等）。证书十年才换一次，正常情况下这份文件永远不变，
# send_receipt 的去重签名会把它带上：指纹一变（证书重签）回执立即重发。
collect_selfcert_fps() {
  _list="$RUN_DIR/selfcerts.list"
  _tmp="$_list.new"
  rm -f "$_tmp" 2>/dev/null
  [ -n "${NP_SELF_CERT_IDS:-}" ] || { rm -f "$_list" 2>/dev/null; return 0; }
  for _item in $NP_SELF_CERT_IDS; do
    _nid=${_item%%:*}
    _crt=${_item#*:}
    [ -n "$_nid" ] && [ -f "$_crt" ] || continue
    _fp=$(self_cert_fp "$_crt")
    _len=${#_fp}
    case "$_fp" in '' | *[!0-9a-f]*) _len=0 ;; esac
    if [ "$_len" -eq 64 ]; then
      printf '%s %s\n' "$_nid" "$_fp" >> "$_tmp" 2>/dev/null
    else
      log "! 自签证书指纹计算失败：$_crt（openssl 不可用或证书损坏）"
    fi
  done
  # 指纹清单变化才记日志：本函数每轮 tick 都跑（apply_services 的 changed/same
  # 两个分支都会到这），无条件打会每 60 秒刷一条。首轮与证书重签后各打一条，
  # 平时静默；全量 hex 进日志，排查时直接与面板节点指纹、订阅 pcs / pinSHA256 比对
  _old=$(cat "$_list" 2>/dev/null)
  _new=$(cat "$_tmp" 2>/dev/null)
  if [ "$_old" != "$_new" ] && [ -n "$_new" ]; then
    while read -r _line; do
      [ -n "$_line" ] || continue
      log "自签证书指纹：${_line%% *}=${_line#* }"
    done < "$_tmp"
  fi
  mv -f "$_tmp" "$_list" 2>/dev/null
}

# ACME：acme.sh 是纯 shell，正好符合「不装运行时」的诉求；失败不影响其它节点
ACME_SH=${ACME_SH:-${HOME:-/root}/.acme.sh/acme.sh}

# 机器上没有 acme.sh 时自动安装。get.acme.sh 只是个 1KB 引导脚本：它自己再从
# raw.githubusercontent.com 拉 acme.sh 主体 —— 那个域名在不少机房被 SNI 阻断
# （get.acme.sh 在 Cloudflare 上反而通；线上案例：wget get.acme.sh 返回 200，
# agent 里 7 秒后安装失败）。所以加一条 github.com 源码归档兜底：github.com
# 可达性通常没问题（部署 hysteria 二进制就是从它 releases 下的）。
# 两条路都失败就冷静 30 分钟再试，错误信息带手动安装指引。
# $1 = CA 账号邮箱（官方安装命令统一带 email=…；acme.sh 默认 CA ZeroSSL 的账号注册
# 强制 email，不传的话装得上也签不出来 —— 0.1.12 对照官方文档补的参数）
acme_install() {
  _email=${1:-}
  [ -f "$ACME_SH" ] && return 0

  _f="$STATE_DIR/.acme-install-fail"
  if [ -f "$_f" ]; then
    _ts=$(sed -n '1p' "$_f" 2>/dev/null)
    case "$_ts" in '' | *[!0-9]*) _ts=0 ;; esac
    if [ $(( $(date +%s) - _ts )) -lt 1800 ]; then
      return 1
    fi
  fi

  log "本机没有 acme.sh，自动安装（在线安装 → GitHub 归档兜底）"

  # 方式一：官方在线安装（引导脚本内部从 raw.githubusercontent.com 拉主体）
  _tmp="$RUN_DIR/acme-install.$$.sh"
  if http_download "${ACME_INSTALL_URL:-https://get.acme.sh}" "$_tmp" && [ -s "$_tmp" ]; then
    if sh "$_tmp" ${_email:+email="$_email"} >> "$LOG_DIR/agent.log" 2>&1 && [ -f "$ACME_SH" ]; then
      rm -f "$_tmp" "$_f" 2>/dev/null
      log "✓ 已安装 acme.sh"
      return 0
    fi
  fi
  rm -f "$_tmp" 2>/dev/null

  # 方式二：github.com 源码归档直接解压安装（归档顶层目录名不固定，find 定位入口）
  _t="$RUN_DIR/acme.$$.tar.gz"
  _d="$RUN_DIR/acme.$$.dir"
  if http_download "${ACME_ARCHIVE_URL:-https://github.com/acmesh-official/acme.sh/archive/refs/heads/master.tar.gz}" "$_t" && [ -s "$_t" ]; then
    mkdir -p "$_d" 2>/dev/null
    if tar -xzf "$_t" -C "$_d" 2>>"$LOG_DIR/agent.log"; then
      _entry=$(find "$_d" -type f -name acme.sh 2>/dev/null | sed -n '1p')
      if [ -n "$_entry" ] && sh "$_entry" --install --home "${ACME_SH%/acme.sh}" ${_email:+-m "$_email"} >>"$LOG_DIR/agent.log" 2>&1 && [ -f "$ACME_SH" ]; then
        rm -rf "$_d" "$_t" 2>/dev/null
        rm -f "$_f" 2>/dev/null
        log "✓ 已安装 acme.sh（GitHub 归档）"
        return 0
      fi
    fi
  fi
  rm -rf "$_d" "$_t" 2>/dev/null

  printf '%s\n' "$(date +%s)" > "$_f" 2>/dev/null
  log "! acme.sh 安装失败：在线安装与 GitHub 归档都没走通（详情见 $LOG_DIR/agent.log）"
  log "  手动安装：curl https://get.acme.sh | sh -s -- email=你的邮箱（中国大陆网络另见 acme.sh wiki「Install in China」）"
  return 1
}

# 把 acme.sh 目录里的证书导出到固定路径。
#
# --reloadcmd 不能省：acme.sh 续期只换磁盘上的文件，不重载服务的话
# Xray 进程内存里还是旧证书 —— 面板一路绿灯，客户端第 90 天报证书过期。
# detect_reload_cmd 定义在文件后面，但 shell 函数是调用时才解析的，这里能拿到。
acme_install_cert() {
  _cn=$1
  _crt=$2
  _key=$3
  _reload=$(detect_reload_cmd)
  if [ -n "$_reload" ]; then
    "$ACME_SH" --install-cert -d "$_cn" --fullchain-file "$_crt" --key-file "$_key" --reloadcmd "$_reload" >>"$LOG_DIR/agent.log" 2>&1
  else
    "$ACME_SH" --install-cert -d "$_cn" --fullchain-file "$_crt" --key-file "$_key" >>"$LOG_DIR/agent.log" 2>&1
  fi
}

ensure_acme_cert() {
  _cn=$1
  _crt=$2
  _key=$3
  [ -n "$_crt" ] || return 0
  [ -f "$_crt" ] && return 0

  # CA 账号邮箱：agent.env 可指定 ACME_EMAIL，缺省 admin@<证书域名>。
  # ZeroSSL / Let's Encrypt 注册账号都要邮箱（到期/失败通知用，格式合法即可）
  _email=${ACME_EMAIL:-admin@$_cn}

  if ! acme_install "$_email"; then
    RC_OK=0
    RC_ERR="${RC_ERR}${RC_ERR:+；}ACME 证书未就绪：acme.sh 安装失败（$_cn）"
    return 1
  fi

  mkdir -p "$(dirname "$_crt")" 2>/dev/null
  if [ -d "${ACME_SH%/acme.sh}/${_cn}_ecc" ]; then
    if acme_install_cert "$_cn" "$_crt" "$_key"; then
      log "ACME 证书已安装：$_cn"
      return 0
    fi
    log "! ACME 证书安装失败：$_cn（详情见 $LOG_DIR/agent.log）"
    RC_OK=0
    RC_ERR="${RC_ERR}${RC_ERR:+；}ACME 证书安装失败：$_cn"
    return 1
  fi

  # Let's Encrypt 对失败验证限速（5 次/小时/账号+域名）：盲目每分钟重签很快被锁，
  # 失败后冷静 30 分钟。期间照常回执「证书未就绪」，面板上能看到明确状态而不是红灯猜谜
  _f="$STATE_DIR/.acme-issue-fail"
  if [ -f "$_f" ]; then
    _ts=$(sed -n '1p' "$_f" 2>/dev/null)
    case "$_ts" in '' | *[!0-9]*) _ts=0 ;; esac
    if [ $(( $(date +%s) - _ts )) -lt 1800 ]; then
      RC_OK=0
      RC_ERR="${RC_ERR}${RC_ERR:+；}ACME 证书未就绪：$_cn 签发失败（30 分钟冷静期，详情见 $LOG_DIR/agent.log）"
      return 1
    fi
  fi

  log "申请 ACME 证书：$_cn（需要 80 端口可用且域名已解析到本机）"
  # --server letsencrypt：acme.sh 缺省 CA 是 ZeroSSL（免费层政策不透明）；
  # LE 的限速规则公开清晰 —— 失败验证 5 次/小时，正好对上上面的 30 分钟冷静期。
  # --accountemail：账号自动注册时带上邮箱（账号已存在时 acme.sh 会忽略它）
  if "$ACME_SH" --issue -d "$_cn" --standalone --keylength ec-256 --server letsencrypt --accountemail "$_email" >>"$LOG_DIR/agent.log" 2>&1; then
    if acme_install_cert "$_cn" "$_crt" "$_key"; then
      log "ACME 证书就绪：$_crt"
      rm -f "$_f" 2>/dev/null
      return 0
    fi
    log "! ACME 证书安装失败：$_cn（详情见 $LOG_DIR/agent.log）"
    RC_OK=0
    RC_ERR="${RC_ERR}${RC_ERR:+；}ACME 证书安装失败：$_cn"
    return 1
  fi
  log "! ACME 申请失败：$_cn（检查域名解析与 80 端口，详情见 $LOG_DIR/agent.log）"
  printf '%s\n' "$(date +%s)" > "$_f" 2>/dev/null
  RC_OK=0
  RC_ERR="${RC_ERR}${RC_ERR:+；}ACME 证书申请失败：$_cn（域名需解析到本机且 80 端口可用）"
  return 1
}

# ------------------------------ 服务收敛 ------------------------------------

xray_bin() {
  _b=$(command -v "$XRAY_ALIAS" 2>/dev/null)
  [ -n "$_b" ] || _b="/usr/local/bin/$XRAY_ALIAS"
  # 兜底官方名：机器上手工装过官方 xray、agent.env 又没写 XRAY_ALIAS 的场景
  [ -x "$_b" ] || _b=$(command -v xray 2>/dev/null)
  [ -n "$_b" ] || _b=/usr/local/bin/xray
  printf '%s' "$_b"
}

# agent.env 没写 RELOAD_CMD 时现猜一个：服务名不一定叫 xray
# （xray-core / x-ui 都见过；0.1.9 起还可能是伪装名 webcore）
detect_reload_cmd() {
  if command -v systemctl >/dev/null 2>&1; then
    for _u in "$XRAY_ALIAS" xray xray-core x-ui; do
      if systemctl list-unit-files 2>/dev/null | grep -q "^$_u\.service"; then
        printf 'systemctl restart %s' "$_u"
        return 0
      fi
    done
  fi
  if command -v rc-service >/dev/null 2>&1; then
    if [ -x "/etc/init.d/$XRAY_ALIAS" ]; then
      printf 'rc-service %s restart' "$XRAY_ALIAS"
    else
      printf 'rc-service xray restart'
    fi
    return 0
  fi
  printf ''
}

# 重载 Xray 前先自检，坏配置绝不顶掉线上正在跑的
reload_xray() {
  _bin=$(xray_bin)
  if [ -x "$_bin" ] && [ -f "$XRAY_CONFIG" ]; then
    if ! "$_bin" -test -config "$XRAY_CONFIG" >/dev/null 2>&1; then
      log "✗ Xray 配置自检未通过，放弃重载（线上配置保持不变）"
      RC_XRAY=fail
      RC_ERR='Xray 配置自检未通过，已放弃重载'
      RC_OK=0
      return 1
    fi
  fi

  _cmd=${RELOAD_CMD:-}
  [ -n "$_cmd" ] || _cmd=$(detect_reload_cmd)
  if [ -z "$_cmd" ]; then
    # 没有可用的重载命令 = 配置已落盘但需要人工重启。这不算「失败」：
    # 把整轮标记成失败会让面板显示红标，掩盖真正的问题（配置自检不过 / 重载报错）
    if command -v systemctl >/dev/null 2>&1 || command -v rc-service >/dev/null 2>&1; then
      # 有服务管理器却没找到 xray 单元：机器装了 systemd，但服务不叫 xray / xray-core / x-ui
      log "! 有服务管理器但没找到 xray 服务单元，跳过重载（配置已写入 $XRAY_CONFIG）"
      log "  把实际的重载命令写进 $ENV_FILE 的 RELOAD_CMD（如 systemctl restart 你的服务名）"
    else
      log "! 本机没有 systemd / OpenRC，跳过 Xray 重载（配置已写入 $XRAY_CONFIG，需手动重启）"
    fi
    RC_XRAY=skip
    return 1
  fi

  # 服务管理器吐的错误一起打出来：只说「重载失败」等于让人去猜
  _err=$(sh -c "$_cmd" 2>&1)
  if [ $? -eq 0 ]; then
    log "✓ Xray 已重载"
    RC_XRAY=ok
    NP_JUST_RESTARTED=1
    return 0
  fi
  log "✗ Xray 重载失败：$_cmd"
  [ -n "$_err" ] && printf '%s\n' "$_err" | sed -n '1,3p' | sed 's/^/    /'
  log "  服务名不是 xray 时（x-ui / xray-core 等），把 RELOAD_CMD 写进 $ENV_FILE 再重启 agent"
  RC_XRAY=fail
  RC_OK=0
  if [ -n "$_err" ]; then
    RC_ERR="Xray 重载失败：$_cmd — $(printf '%s' "$_err" | sed -n '1p')"
  else
    RC_ERR="Xray 重载失败：$_cmd"
  fi
  return 1
}

# --------------------------- Xray 存活自愈 -----------------------------------
# 为什么需要这一段：reload_xray 只在「配置内容变了」的时候执行。
# 一旦机器重启过（xray 服务没 enable）、或进程被 OOM / 手动 kill 掉，
# 磁盘上的配置和面板完全一致 → 每轮都判定「没变化」→ 永远不会再重启 Xray，
# 端口就一直空着。而面板只看配置 hash，会一直显示「已同步」，只能靠 lsof 才发现。
# 所以这里补一条兜底：配置没变也要确认 Xray 在跑，没跑就拉起来。

# 从 RELOAD_CMD 里取服务名（systemctl restart xray → xray）
xray_unit() {
  _cmd=${RELOAD_CMD:-}
  [ -n "$_cmd" ] || _cmd=$(detect_reload_cmd)
  case "$_cmd" in
    'systemctl restart '*) printf '%s' "${_cmd#systemctl restart }" ;;
    'rc-service '*) printf '%s' "${_cmd#rc-service }" | sed 's/[[:space:]]*restart$//' ;;
    *) printf '' ;;
  esac
}

xray_running() {
  _u=$(xray_unit)
  if [ -n "$_u" ]; then
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$_u" 2>/dev/null; then
      return 0
    fi
    if command -v rc-service >/dev/null 2>&1 && rc-service "$_u" status >/dev/null 2>&1; then
      return 0
    fi
  fi
  # 没有服务单元（手动 nohup 起的 / 容器里）时退回看进程。
  # 伪装名与官方名都试：XRAY_ALIAS 缺省就是 xray，第二个探测只对
  # 「手工装了官方 xray 却在 env 里配了别名」这类混搭生效
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -x "$XRAY_ALIAS" >/dev/null 2>&1 && return 0
    pgrep -x xray >/dev/null 2>&1 && return 0
  fi
  return 1
}

xray_ensure() {
  # 本机没有 Xray 节点（纯 Hysteria2 / 空节点）：没有需要重载的对象。
  # 这里必须落一个值 —— 留空会被回执兜底成 skip，面板于是永远显示「待重载」
  if ! [ "${NP_XRAY_NODES:-0}" -gt 0 ] 2>/dev/null; then
    RC_XRAY=${RC_XRAY:-ok}
    return 0
  fi

  if xray_running; then
    rm -f "$STATE_DIR/.xray-fail" 2>/dev/null
    # 本来就在跑：配置没变（或这一轮刚重载过）都说明线上已经是这份配置。
    # 以前这里直接 return，RC_XRAY 留空 → 回执写 skip → 面板误报「待重载」。
    # skip 的含义是「配置落盘了但没重启」，没重启这件事没发生过就不能这么说
    RC_XRAY=${RC_XRAY:-ok}
    return 0
  fi

  # 拉不起来时（多半是根本没装 Xray）不要每 60 秒往日志里灌一遍：
  # 5 分钟内只报状态、不再重试，过了冷静期再试一次
  _xf="$STATE_DIR/.xray-fail"
  if [ -f "$_xf" ]; then
    _ts=$(sed -n '1p' "$_xf" 2>/dev/null)
    _msg=$(sed -n '2p' "$_xf" 2>/dev/null)
    case "$_ts" in '' | *[!0-9]*) _ts=0 ;; esac
    _now=$(date +%s)
    if [ $((_now - _ts)) -lt 300 ]; then
      RC_XRAY=fail
      RC_OK=0
      RC_ERR=${_msg:-Xray 未运行}
      return 1
    fi
  fi

  _u=$(xray_unit)
  if [ -z "$_u" ]; then
    log "! Xray 未运行，且没有可用的服务管理器：配置在 $XRAY_CONFIG，需要手动启动"
    RC_XRAY=fail
    RC_OK=0
    RC_ERR='Xray 未运行，且本机没有可用的服务管理器'
    printf '%s\n%s\n' "$(date +%s)" "$RC_ERR" > "$_xf" 2>/dev/null
    return 1
  fi

  log "! Xray 未运行（$_u 不是 active），尝试拉起"
  if command -v systemctl >/dev/null 2>&1; then
    # 顺手 enable：否则下次重启又是同样的坑，而且没人会发现
    systemctl enable "$_u" >/dev/null 2>&1
    _err=$(systemctl start "$_u" 2>&1)
  else
    _err=$(rc-service "$_u" start 2>&1)
  fi
  if [ $? -eq 0 ]; then
    log "✓ Xray 已启动"
    rm -f "$_xf" 2>/dev/null
    RC_XRAY=ok
    NP_JUST_RESTARTED=1
    return 0
  fi

  case "$_err" in
    *'not found'* | *'not-found'* | *'No such file'*)
      # 最容易踩的一种：机器上根本没有 Xray，装个节点却从来没装过服务。
      # 0.1.5 起部署脚本会自己装 xray-core，所以这里直接给出能一键修好的动作
      RC_ERR="未找到 $_u 服务：本机没有安装 Xray。到面板「服务器 / 节点」页复制部署命令重跑一次（会自动装 xray-core），或手工装好后把 RELOAD_CMD 写进 $ENV_FILE"
      log "  修复：重跑面板上的部署命令即可自动安装 xray-core（已有安装不会被覆盖）"
      ;;
    *)
      RC_ERR="Xray 启动失败：$_u — $(printf '%s' "$_err" | sed -n '1p')"
      ;;
  esac
  log "✗ $RC_ERR"
  [ -n "$_err" ] && printf '%s\n' "$_err" | sed -n '1,3p' | sed 's/^/    /'
  RC_XRAY=fail
  RC_OK=0
  printf '%s\n%s\n' "$(date +%s)" "$RC_ERR" > "$_xf" 2>/dev/null
  return 1
}

# ----------------------------- 端口监听自检 ---------------------------------
# 面板在 state.env 里下发「这台机器应该监听的端口」（NP_LISTEN_PORTS=tcp:42000 udp:8443）。
# 配置落盘 ≠ 端口在听：进程崩了、配置被别的程序占着、Xray 起在别的配置文件上，
# 都会让面板显示「已同步」而实际连不上。这里抓一次本机监听表核对。

SOCK_LIST=''
sock_list() {
  [ -n "$SOCK_LIST" ] && { printf '%s\n' "$SOCK_LIST"; return 0; }
  # SOCK_CMD 是给「既没有 ss 也没有 netstat」的机器（以及测试）留的把手：
  # 只要输出「协议 本地地址」两列即可，例如 `ss -lntu | tail -n +2`
  if [ -n "${SOCK_CMD:-}" ]; then
    SOCK_LIST=$(sh -c "$SOCK_CMD" 2>/dev/null)
  elif command -v ss >/dev/null 2>&1; then
    SOCK_LIST=$(ss -lntu 2>/dev/null | sed -n '2,$p')
  elif command -v netstat >/dev/null 2>&1; then
    SOCK_LIST=$(netstat -lntu 2>/dev/null | sed -n '3,$p')
  fi
  printf '%s\n' "$SOCK_LIST"
}

# $1=协议(tcp/udp) $2=端口
port_bound() {
  sock_list | awk -v proto="$1" -v p="$2" '
    {
      if (tolower($1) !~ "^" proto) next
      # 整行匹配「:端口」且后面不是数字，避免 4200 误命中 42000
      if ($0 ~ (":" p "([^0-9]|$)")) { found = 1; exit }
    }
    END { exit(found ? 0 : 1) }'
}

probe_ports() {
  [ -n "${NP_LISTEN_PORTS:-}" ] || return 0
  BAD_PORTS=''
  for _item in $NP_LISTEN_PORTS; do
    _proto=${_item%%:*}
    _port=${_item#*:}
    case "$_port" in '' | *[!0-9]*) continue ;; esac
    port_bound "$_proto" "$_port" && continue
    BAD_PORTS="${BAD_PORTS}${BAD_PORTS:+,}${_proto}:${_port}"
  done
  [ -n "$BAD_PORTS" ] || return 0

  log "! 端口未在监听：$BAD_PORTS（配置已落盘，但服务没把它监听起来）"
  log "  排查：ss -lntup | grep -E 'xray|hysteria'；journalctl -u xray -n 50"
  RC_OK=0
  RC_ERR="${RC_ERR}${RC_ERR:+；}端口未监听：$BAD_PORTS"
  return 1
}

hy_pidfile() { printf '%s/%s.pid' "$RUN_DIR" "$1"; }


hy_stop() {
  _pidfile=$(hy_pidfile "$1")
  [ -f "$_pidfile" ] || return 0
  _pid=$(cat "$_pidfile" 2>/dev/null)
  if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
    kill "$_pid" 2>/dev/null
    _i=0
    while [ "$_i" -lt 15 ] && kill -0 "$_pid" 2>/dev/null; do
      sleep 0.2 2>/dev/null || sleep 1
      _i=$((_i + 1))
    done
    kill -9 "$_pid" 2>/dev/null
  fi
  rm -f "$_pidfile"
}

# --------------------------- Hysteria2 二进制自愈 ---------------------------
# 部署脚本只在「生成脚本那一刻已经有 Hysteria2 节点」时装二进制，而面板推荐的流程是
# 先部署机器、后加节点 —— 那种情况下 needHysteria 是 0，机器上永远没有 hysteria，
# 节点就只会一直「端口未监听」。这里让 agent 自己补上，装不上就冷静 30 分钟再试，
# 免得每分钟往 GitHub 撞一次。

hy_install_allowed() {
  _f="$STATE_DIR/.hysteria-install-fail"
  [ -f "$_f" ] || return 0
  _ts=$(sed -n '1p' "$_f" 2>/dev/null)
  case "$_ts" in '' | *[!0-9]*) _ts=0 ;; esac
  [ $(( $(date +%s) - _ts )) -ge 1800 ]
}

hy_install() {
  [ -x "$HYSTERIA_BIN" ] && return 0
  if [ "$HYSTERIA_AUTO_INSTALL" != '1' ]; then
    log "! 未找到 hysteria（$HYSTERIA_BIN），已禁用自动安装（HYSTERIA_AUTO_INSTALL=0）"
    log "  手动装：https://v2.hysteria.network/zh/docs/getting-started/Installation/"
    return 1
  fi
  hy_install_allowed || return 1

  case "$(uname -m)" in
    x86_64 | amd64) _arch=amd64 ;;
    aarch64 | arm64) _arch=arm64 ;;
    armv7l | armv7) _arch=arm ;;
    i386 | i686) _arch=386 ;;
    *)
      log "! 不支持的架构 $(uname -m)，无法自动安装 hysteria"
      return 1
      ;;
  esac

  _url="https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-$_arch"
  _tmp="$HYSTERIA_BIN.tmp.$$"
  log "本机没有 hysteria，尝试自动安装（$_url）"
  if http_download "$_url" "$_tmp" && [ -s "$_tmp" ]; then
    chmod 755 "$_tmp" 2>/dev/null
    # 下下来先跑一下：架构不对或文件被截断时，装上去也只会让 hy_ensure 反复失败
    if "$_tmp" version >/dev/null 2>&1; then
      mv -f "$_tmp" "$HYSTERIA_BIN" 2>/dev/null || cp -f "$_tmp" "$HYSTERIA_BIN" 2>/dev/null
      rm -f "$_tmp" "$STATE_DIR/.hysteria-install-fail" 2>/dev/null
      log "✓ 已安装 hysteria $("$HYSTERIA_BIN" version 2>/dev/null | sed -n '1p')"
      return 0
    fi
    log "! 下载到的 hysteria 跑不起来（架构不匹配或文件损坏）"
  else
    log "! hysteria 下载失败（本机可能连不上 GitHub）"
  fi

  rm -f "$_tmp" 2>/dev/null
  printf '%s\n' "$(date +%s)" > "$STATE_DIR/.hysteria-install-fail" 2>/dev/null
  log "  30 分钟内不再重试；也可以回面板复制一次部署命令重跑，或手动装："
  log "  https://v2.hysteria.network/zh/docs/getting-started/Installation/"
  return 1
}

hy_ensure() {
  _inst=$1
  _cfg="$HYSTERIA_DIR/$_inst.yaml"
  [ -f "$_cfg" ] || return 0

  _pidfile=$(hy_pidfile "$_inst")
  if [ -f "$_pidfile" ]; then
    _pid=$(cat "$_pidfile" 2>/dev/null)
    if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
      return 0
    fi
  fi

  # yaml 引用的证书还不存在（ACME 签发中 / 失败）就先别拉起：起来也是秒退，
  # 60 秒一轮的崩溃循环只会刷屏，还把「证书为什么没有」这个真正的线索淹掉
  _cert=$(sed -n 's/^[[:space:]]*cert:[[:space:]]*//p' "$_cfg" 2>/dev/null | sed -n '1p')
  if [ -n "$_cert" ] && [ ! -f "$_cert" ]; then
    log "! 证书未就绪（$_cert），暂不启动 $_inst；ACME 节点请确认域名解析与 80 端口"
    RC_ERR="${RC_ERR}${RC_ERR:+；}证书未就绪：$_cert"
    RC_OK=0
    return 1
  fi

  if [ ! -x "$HYSTERIA_BIN" ]; then
    if ! hy_install; then
      log "! 未找到 hysteria（$HYSTERIA_BIN），跳过 $_inst"
      return 1
    fi
  fi

  mkdir -p "$RUN_DIR" "$LOG_DIR" 2>/dev/null
  _log="$LOG_DIR/$_inst.log"
  # 简单滚动：超过 5MB 就清空，避免小硬盘被日志吃满
  if [ -f "$_log" ]; then
    _size=$(wc -c < "$_log" 2>/dev/null || echo 0)
    [ "$_size" -gt "$LOG_MAX" ] && : > "$_log"
  fi

  nohup "$HYSTERIA_BIN" server -c "$_cfg" >> "$_log" 2>&1 &
  echo $! > "$_pidfile"
  log "已启动 Hysteria2 实例 $_inst"
  # 「已启动」只说明 nohup 派生成功。hysteria 遇到 YAML 非法、证书读不了、
  # 端口被占会启动即退，留给 verify_started_hy 统一核对并把死因翻出来
  NP_STARTED_HY="${NP_STARTED_HY}${NP_STARTED_HY:+ }$_inst"
  NP_JUST_RESTARTED=1
}

# $1 = 需要重启的实例名（空格分隔，可为空）
hy_sync() {
  _restart=" ${1:-} "

  # 1. 面板已经不认的实例：停掉并删配置
  for _f in "$HYSTERIA_DIR"/node-*.yaml; do
    [ -f "$_f" ] || continue
    _inst=$(basename "$_f" .yaml)
    case " ${NP_HY2_LIST:-} " in
      *" $_inst:"*) : ;;
      *)
        hy_stop "$_inst"
        rm -f "$_f" "$LOG_DIR/$_inst.log" 2>/dev/null
        log "已移除 Hysteria2 实例 $_inst"
        ;;
    esac
  done

  # 2. 配置变过的先停，再统一确保在跑（没跑的就拉起来）
  _ok=0
  _total=0
  for _item in ${NP_HY2_LIST:-}; do
    _inst=${_item%%:*}
    _total=$((_total + 1))
    case "$_restart" in
      *" $_inst "*) hy_stop "$_inst" ;;
    esac
    if hy_ensure "$_inst"; then
      _ok=$((_ok + 1))
    else
      RC_HY_FAIL="${RC_HY_FAIL:-}${RC_HY_FAIL:+、}${_inst}"
      RC_OK=0
    fi
  done
  [ "$_total" -gt 0 ] && RC_HY="$_ok/$_total"
}

# 本轮拉起的 Hysteria2 实例统一做一次存活核对（apply_services 里 sleep 1 之后才调用，
# 给 hysteria 留出「启动即退出」的时间）。死进程的 pid 文件顺手清掉，免得下一轮
# hy_ensure 误判「还活着」；真正的死因（实例日志里的 FATAL 行）带进 agent 日志与回执，
# 否则面板上只有一个笼统的「端口未监听」，排查得登机器翻日志。
verify_started_hy() {
  for _inst in ${NP_STARTED_HY:-}; do
    _pidfile=$(hy_pidfile "$_inst")
    _pid=$(cat "$_pidfile" 2>/dev/null)
    if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
      continue
    fi
    rm -f "$_pidfile" 2>/dev/null
    _why=$(grep 'FATAL' "$LOG_DIR/$_inst.log" 2>/dev/null | tail -n 1 | cut -c1-200)
    if [ -n "$_why" ]; then
      log "! Hysteria2 实例 $_inst 启动后立即退出：$_why"
    else
      log "! Hysteria2 实例 $_inst 启动后立即退出（$LOG_DIR/$_inst.log 未见 FATAL 记录）"
    fi
    log "  完整日志：tail -50 $LOG_DIR/$_inst.log"
    RC_HY_FAIL="${RC_HY_FAIL:-}${RC_HY_FAIL:+、}${_inst}"
    RC_ERR="${RC_ERR}${RC_ERR:+；}Hysteria2 启动即退出：${_inst}${_why:+（$_why）}"
    RC_OK=0
  done
  NP_STARTED_HY=''
}

# ------------------------------- 配置包 -------------------------------------

fetch_bundle() {
  # 第一个参数是 body 的落盘位置：状态码从 stdout 回，内容进文件，
  # 这样 4xx 的响应体也不会被 curl -f 丢掉
  _url="$PANEL_URL/api/agent/bundle?token=$AGENT_TOKEN&v=$VERSION&hash=${NP_HASH:-}"
  _ip=''
  [ "$REPORT_IP" = '1' ] && _ip=$(public_ip)
  [ -n "$_ip" ] && _url="$_url&ip=$_ip"
  http_probe "$_url" "Authorization: Bearer $AGENT_TOKEN" "$1"
}

# 401 = 面板上已经没有这个 token（服务器 / 节点记录被删，或 token 被重置）。
# 这是唯一可信的「我被摘掉了」信号；连不上（000）绝不能算。
#
# 判定之后不做「自杀」：systemd 的 Restart=always 会把进程再拉起来、
# KillMode=process 又让自停命令和停止信号互相打架，cron 模式下更是没法安全摘掉
# 自己那行 crontab；更要紧的是，面板从备份恢复 / 换域名时 token 会短暂对不上，
# 那会把一整片活节点误停。所以这里只做两件不伤人的事：
#   1) 日志从每轮一条收敛成一条（带恢复与卸载的出路）
#   2) 轮询降到 ORPHAN_INTERVAL，面板记录恢复后自己回来，不用登机器
# 第一个参数是最小记录间隔（秒），后面是日志正文。
# 去重不能只靠内存变量：--once（cron）模式下每轮都是新进程
orphan_log() {
  _gap=$1
  shift
  _now=$(date +%s)
  _last=$(cat "$STATE_DIR/.orphan.log" 2>/dev/null)
  case "$_last" in '' | *[!0-9]*) _last=0 ;; esac
  [ $((_now - _last)) -ge "$_gap" ] || return 0
  printf '%s\n' "$_now" > "$STATE_DIR/.orphan.log" 2>/dev/null
  log "$@"
}

orphan_note() {
  _now=$(date +%s)
  # .orphan 存两列：401 起点、是否已跨过宽限期（1 = 已经降级过）
  _first=''
  _tripped=''
  # 2>/dev/null 必须写在 < 前面：重定向按从左到右处理，文件不存在时
  # 先报错的那条已经打到 stderr 了，后面的 2>/dev/null 根本来不及生效
  read _first _tripped 2>/dev/null < "$STATE_DIR/.orphan"
  case "$_first" in
    '' | *[!0-9]*)
      _first=$_now
      printf '%s 0\n' "$_first" > "$STATE_DIR/.orphan" 2>/dev/null
      ;;
  esac
  _age=$((_now - _first))

  if [ "$_age" -ge "$ORPHAN_GRACE" ]; then
    NP_ORPHAN=1
    if [ "$_tripped" != '1' ]; then
      # 跨过宽限期的这一轮必须立刻说清楚（后面转成一天一条）
      printf '%s 1\n' "$_first" > "$STATE_DIR/.orphan" 2>/dev/null
      # 两行合成一次 log：日志按「一次记录」去重，分两次调会把第二行吃掉
      orphan_log 0 "✗ 面板持续不认这台机器（HTTP 401，已 $((_age / 60)) 分钟）：服务器 / 节点记录可能已被删除
  已转为每 ${ORPHAN_INTERVAL}s 低频重试（面板恢复后自动回来）；要彻底摘掉：sh $STATE_DIR/uninstall.sh"
    else
      orphan_log 86400 "✗ 面板仍不认这台机器（HTTP 401，已 $((_age / 3600)) 小时）：记录可能已被删除；卸载：sh $STATE_DIR/uninstall.sh"
    fi
  else
    orphan_log 3600 "✗ 面板不认这台机器（HTTP 401）：token 失效或记录已删除；$((ORPHAN_GRACE / 60)) 分钟后转低频重试"
  fi

  RC_ERR="面板不认这台机器（HTTP 401）"
  return 1
}

# 拿回 200 就说明 token 又是有效的（重新部署 / 面板恢复），把宽限期从头算
orphan_clear() {
  NP_ORPHAN=0
  [ -f "$STATE_DIR/.orphan" ] || return 0
  rm -f "$STATE_DIR/.orphan" "$STATE_DIR/.orphan.log" 2>/dev/null
  log "✓ 面板恢复认可这台机器，轮询间隔回到 ${INTERVAL}s"
}

# 返回 0 = 应用了配置，1 = 没变化或失败
apply_bundle() {
  _body="$RUN_DIR/bundle.body.$$"
  NP_HTTP_CODE=$(fetch_bundle "$_body")
  _out=$(cat "$_body" 2>/dev/null)
  rm -f "$_body" 2>/dev/null
  LAST_FETCH_OK=0

  case "$NP_HTTP_CODE" in
    401)
      orphan_note
      return 1
      ;;
    000 | '')
      # 暂时状态：网络断了、DNS 挂了、面板没起、反代在重启。
      # 这种情况永远按正常间隔重试 —— 面板恢复的瞬间就该连上
      log "✗ 无法连接面板：$PANEL_URL"
      RC_ERR="无法连接面板 $PANEL_URL"
      return 1
      ;;
  esac

  if [ -z "$_out" ]; then
    log "✗ 面板返回空内容（HTTP $NP_HTTP_CODE）：$PANEL_URL"
    RC_ERR="面板返回空内容（HTTP $NP_HTTP_CODE）"
    return 1
  fi
  # 能拿到内容就说明通道是通的，回执才有意义
  LAST_FETCH_OK=1
  orphan_clear

  case "$_out" in
    '#UNCHANGED'*) return 1 ;;
    '#ERROR'*)
      log "✗ 面板拒绝：${_out#\#ERROR }"
      LAST_FETCH_OK=0
      RC_OK=0
      RC_ERR="面板拒绝配置：${_out#\#ERROR }"
      return 1
      ;;
  esac

  _tmp="$RUN_DIR/bundle.$$.sh"
  printf '%s\n' "$_out" > "$_tmp" || return 1
  if sh "$_tmp" >> "$LOG_DIR/agent.log" 2>&1; then
    rm -f "$_tmp"
    # state.env 给下一轮用；changed.env 记录这一轮哪些文件真的变了，决定要不要重载服务
    . "$STATE_DIR/state.env" 2>/dev/null
    . "$STATE_DIR/changed.env" 2>/dev/null
    # 变更项写进日志：事后对时间线时，「这轮到底改了什么」比「更新了」有用得多
    _what=''
    [ "${NP_CHANGED_XRAY:-0}" = '1' ] && _what='Xray'
    [ -n "${NP_CHANGED_HY:-}" ] && _what="${_what}${_what:+、}Hysteria2${NP_CHANGED_HY}"
    log "✓ 配置已更新（hash ${NP_HASH:-?}，变更：${_what:-无}）"
    return 0
  fi

  log "✗ 配置包执行失败，详见 $LOG_DIR/agent.log"
  rm -f "$_tmp"
  LAST_FETCH_OK=1
  RC_OK=0
  RC_ERR="配置包执行失败，详见 $LOG_DIR/agent.log"
  return 1
}

apply_services() {
  # 证书先就位，否则 Xray 起来会因为找不到证书而失败
  for _item in ${NP_SELF_CERTS:-}; do
    _cn=${_item%%|*}
    _rest=${_item#*|}
    ensure_self_cert "$_cn" "${_rest%%|*}" "${_rest#*|}"
  done
  for _item in ${NP_ACME_CERTS:-}; do
    _cn=${_item%%|*}
    _rest=${_item#*|}
    ensure_acme_cert "$_cn" "${_rest%%|*}" "${_rest#*|}"
  done
  # 自签证书就位后立刻算指纹：首轮生成的证书当轮回执就能把指纹带给面板，
  # 面板订阅从 allowInsecure 切到 pcs 不用等第二轮
  collect_selfcert_fps

  if [ "$1" = 'changed' ]; then
    [ "${NP_CHANGED_XRAY:-0}" = '1' ] && reload_xray
    hy_sync "${NP_CHANGED_HY:-}"
    # 用完即清，避免下一轮把实例又重启一遍
    printf "NP_CHANGED_XRAY=0\nNP_CHANGED_HY=''\n" > "$STATE_DIR/changed.env" 2>/dev/null
  else
    hy_sync ''
  fi

  # 配置没变也要收敛：Xray 崩了 / 开机没自启时把它拉起来（否则端口永久空着）
  xray_ensure

  # 等服务把端口 bind 上再自检；每轮都跑一次 ss，开销可以忽略
  [ "$NP_JUST_RESTARTED" = '1' ] && sleep 1 2>/dev/null
  verify_started_hy
  probe_ports
}

# ------------------------------- 流量采集 -----------------------------------
# 中间格式统一成「email uplink|downlink 字节数」，最后用一段 awk 汇总

# 把 },{ 拆成一行一条记录（busybox sed 也认这个写法）
split_records() {
  sed 's/},{/}\
{/g'
}

collect_xray() {
  [ "${NP_XRAY_NODES:-0}" -gt 0 ] 2>/dev/null || return 0
  _bin=$(xray_bin)
  [ -x "$_bin" ] || return 0

  "$_bin" api statsquery --server="${NP_STATS:-127.0.0.1:10085}" -pattern 'user>>>' -reset 2>/dev/null \
    | tr -d ' \r\n\t' \
    | split_records \
    | awk '
      {
        if (!match($0, /"name":"[^"]*"/)) next
        nm = substr($0, RSTART + 8, RLENGTH - 9)
        if (!match($0, /"value":[0-9]+/)) next
        val = substr($0, RSTART + 8, RLENGTH - 8) + 0
        if (val <= 0) next
        n = split(nm, p, ">>>")
        # 只要 user>>>email>>>traffic>>>(uplink|downlink)，inbound>>>tag>>>traffic>>>* 不算用户
        if (n != 4 || p[1] != "user" || p[3] != "traffic") next
        if (p[4] == "uplink") print p[2], "uplink", val
        else if (p[4] == "downlink") print p[2], "downlink", val
      }'
}

# 节点维度用量：Xray 每个入站都带 tag `node-<节点ID>`，入站计数器正好就是该节点的总流量。
# 注意入站总数 ≠ 用户总和（可能有未认证流量），所以它只用于「哪台节点在跑量」的报表，
# 不参与用户额度计算。
collect_xray_nodes() {
  [ "${NP_XRAY_NODES:-0}" -gt 0 ] 2>/dev/null || return 0
  _bin=$(xray_bin)
  [ -x "$_bin" ] || return 0

  "$_bin" api statsquery --server="${NP_STATS:-127.0.0.1:10085}" -pattern 'inbound>>>' -reset 2>/dev/null \
    | tr -d ' \r\n\t' \
    | split_records \
    | awk '
      {
        if (!match($0, /"name":"[^"]*"/)) next
        nm = substr($0, RSTART + 8, RLENGTH - 9)
        if (!match($0, /"value":[0-9]+/)) next
        val = substr($0, RSTART + 8, RLENGTH - 8) + 0
        if (val <= 0) next
        n = split(nm, p, ">>>")
        if (n != 4 || p[1] != "inbound" || p[3] != "traffic") next
        if (p[4] == "uplink") print p[2], "uplink", val
        else if (p[4] == "downlink") print p[2], "downlink", val
      }' \
    | awk '
      { up[$1] += ($2 == "uplink" ? $3 : 0); down[$1] += ($2 == "downlink" ? $3 : 0); seen[$1] = 1 }
      END {
        for (t in seen) {
          # 只认自家入站（node-<id>），api / metrics 之类的内部入站直接跳过
          if (t !~ /^node-/) continue
          id = substr(t, 6)
          if (id == "") continue
          printf "node:%s %d %d\n", id, up[t], down[t]
        }
      }'
}

collect_hysteria() {
  for _item in ${NP_HY2_LIST:-}; do
    _inst=${_item%%:*}
    _rest=${_item#*:}
    _port=${_rest%%:*}
    _secret=${_rest#*:}
    _resp=$(http_get "http://127.0.0.1:$_port/traffic?clear=1" "Authorization: $_secret" 5)
    [ -n "$_resp" ] || continue
    _rows="$RUN_DIR/hy.$$.rows"
    printf '%s' "$_resp" \
      | tr -d ' \r\n\t' \
      | sed 's/},"/}\
"/g' \
      | awk '
        {
          i = index($0, "\":{\"tx\"")
          if (i < 3) next
          # 记录形如 {"u<id>":{"tx":1,"rx":2}：取第一个引号到 :{"tx" 之间，再去掉引号
          email = substr($0, 2, i - 2)
          gsub(/"/, "", email)
          if (email == "") next
          rest = substr($0, i)
          tx = 0; rx = 0
          if (match(rest, /"tx":[0-9]+/)) tx = substr(rest, RSTART + 5, RLENGTH - 5) + 0
          if (match(rest, /"rx":[0-9]+/)) rx = substr(rest, RSTART + 5, RLENGTH - 5) + 0
          if (tx > 0) print email, "uplink", tx
          if (rx > 0) print email, "downlink", rx
        }' > "$_rows" 2>/dev/null
    cat "$_rows" 2>/dev/null
    # 一个 Hysteria2 实例就是一个节点：把该实例下所有用户的流量求和即为节点用量
    awk -v nid="${_inst#node-}" '
      { up += ($2 == "uplink" ? $3 : 0); down += ($2 == "downlink" ? $3 : 0) }
      END { if (up + down > 0) printf "node:%s %d %d\n", nid, up, down }
    ' "$_rows" 2>/dev/null
    rm -f "$_rows"
  done
}

collect_stats() {
  _raw="$RUN_DIR/stats.$$.raw"
  : > "$_raw"
  collect_xray >> "$_raw" 2>/dev/null
  collect_xray_nodes >> "$_raw" 2>/dev/null
  collect_hysteria >> "$_raw" 2>/dev/null

  # 用户行与节点行分开汇总：email up down / node:<id> up down
  # 注意 node: 行（collect_xray_nodes / collect_hysteria 输出）已是最终格式「key up down」，
  # 而 email 行是中间格式「email uplink|downlink 字节」—— 分支处理不能混
  awk '
    {
      if ($1 ~ /^node:/) {
        nup[$1] += $2 + 0; ndown[$1] += $3 + 0; nseen[$1] = 1
      } else {
        up[$1] += ($2 == "uplink" ? $3 : 0); down[$1] += ($2 == "downlink" ? $3 : 0); seen[$1] = 1
      }
    }
    END {
      for (e in seen) printf "%s %d %d\n", e, up[e], down[e]
      for (t in nseen) printf "%s %d %d\n", t, nup[t], ndown[t]
    }
  ' "$_raw" > "$RUN_DIR/stats.agg" 2>/dev/null
  rm -f "$_raw"
}

# ------------------------------ 流量对账（v2） -------------------------------
# 0.1.16 起（面板下发 NP_REPORT_V2=1 时启用）：本轮增量先并入磁盘上的累计值，
# 上报改发「累计值 + 单调递增序号 + 实例代数 gen」，服务端拿差值入账 ——
# 丢一轮上报只是让这部分量晚一轮到账，不再像纯增量模式那样丢一次就永久丢量。
# 序号每次尝试上报都 +1 并先落盘：HTTP 超时重传由服务端按序号挡住。
# gen 与 totals 同生命周期：重装（STATE_DIR 被删）后重新生成，面板看到新 gen
# 就知道「这台机器的计数器从头开始了」—— 只建基线不入账，两个方向都不会错账
# （旧 seq 比面板水位小会被当重复丢弃；删记录重接入会把全量历史重算一遍）。

gen_of() {
  cat "$STATE_DIR/totals.gen" 2>/dev/null
}

gen_make() {
  # 8 字节随机 hex；/dev/urandom 不可用时回退 时间戳-PID（同一台机器上仍唯一）
  _g=$(head -c 8 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')
  case "$_g" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) _g="$(date +%s 2>/dev/null)-$$" ;;
  esac
  printf '%s\n' "$_g" > "$STATE_DIR/totals.gen" 2>/dev/null
  printf '%s' "$_g"
}

merge_totals() {
  _totals="$STATE_DIR/totals"
  # 累计文件首轮还不存在：先建空文件，否则下面的 awk 两文件里第一个打不开，
  # gawk/busybox 直接 fatal 退出（还被 2>/dev/null 吞掉），totals 永远建不起来
  if [ ! -f "$_totals" ]; then
    : > "$_totals" 2>/dev/null || return 0
    gen_make > /dev/null
  fi
  : > "$_totals.new" 2>/dev/null || return 0
  # 第一文件是旧累计，第二文件是本轮增量（都已是「key up down」最终格式）
  awk '
    function add(k, u, d) { up[k] += u; down[k] += d; seen[k] = 1 }
    NR == FNR { add($1, $2 + 0, $3 + 0); next }
    { add($1, $2 + 0, $3 + 0) }
    END { for (k in seen) printf "%s %d %d\n", k, up[k] + 0, down[k] + 0 }
  ' "$_totals" "$RUN_DIR/stats.agg" > "$_totals.new" 2>/dev/null
  if [ -s "$_totals.new" ] || [ -s "$_totals" ]; then
    mv "$_totals.new" "$_totals" 2>/dev/null || rm -f "$_totals.new" 2>/dev/null
  else
    rm -f "$_totals.new" 2>/dev/null
  fi
  : > "$RUN_DIR/stats.agg"
}

report_v2() {
  _totals="$STATE_DIR/totals"
  [ -s "$_totals" ] || return 0

  _seq=$(cat "$STATE_DIR/.seq" 2>/dev/null)
  case "$_seq" in '' | *[!0-9]*) _seq=0 ;; esac
  _seq=$((_seq + 1))
  printf '%s\n' "$_seq" > "$STATE_DIR/.seq" 2>/dev/null

  # gen 丢了（手删）就补一个：面板会把它当新代数建基线，丢的只是 60 秒的量
  _gen=$(gen_of)
  [ -n "$_gen" ] || _gen=$(gen_make)

  _ip=''
  [ "$REPORT_IP" = '1' ] && _ip=$(public_ip)
  _url="$PANEL_URL/api/agent/report?token=$AGENT_TOKEN&v=$VERSION"
  [ -n "$_ip" ] && _url="$_url&ip=$_ip"

  _f="$RUN_DIR/report.$$.json"
  {
    printf '{"v2":1,"seq":%d,"gen":"%s","totals":[' "$_seq" "$_gen"
    awk 'BEGIN { ORS = "" } $1 !~ /^node:/ { printf "%s[\"%s\",%d,%d]", sep, $1, $2, $3; sep = "," }' "$_totals"
    printf '],"nodes":['
    awk 'BEGIN { ORS = "" } $1 ~ /^node:/ { printf "%s[\"%s\",%d,%d]", sep, substr($1, 6), $2, $3; sep = "," }' "$_totals"
    printf ']}\n'
  } > "$_f" 2>/dev/null

  if http_post_json "$_url" "$_f" "Authorization: Bearer $AGENT_TOKEN" >/dev/null; then
    log "↑ 已上报累计流量（序号 $_seq）"
  else
    log "✗ 流量上报失败（累计值已保留，下一轮自动补报）"
  fi
  rm -f "$_f"
}

report() {
  # 孤儿模式（面板持续回 401）：上报必然失败，静默跳过 —— v2 的累计值完好保留在
  # totals 里，面板记录恢复 / 重新部署后按 gen 建基线自动接上；每 60 秒一条
  # 「✗ 流量上报失败」只会把降频后的日志又刷成噪音
  if [ "$NP_ORPHAN" = '1' ]; then
    if [ "$NP_REPORT_V2" = '1' ]; then
      merge_totals
    fi
    return 0
  fi

  # v1（旧面板）：纯增量上报，成功才清零 —— 丢一轮就永久丢，v2 的动因就是它
  if [ "$NP_REPORT_V2" = '1' ]; then
    merge_totals
    report_v2
    return
  fi

  [ -s "$RUN_DIR/stats.agg" ] || return 0
  _url="$PANEL_URL/api/agent/report?token=$AGENT_TOKEN&v=$VERSION"
  _ip=''
  [ "$REPORT_IP" = '1' ] && _ip=$(public_ip)
  [ -n "$_ip" ] && _url="$_url&ip=$_ip"

  _res=$(http_post "$_url" "$RUN_DIR/stats.agg" "Authorization: Bearer $AGENT_TOKEN")
  if [ -n "$_res" ]; then
    log "↑ 已上报 $(wc -l < "$RUN_DIR/stats.agg" 2>/dev/null | tr -d ' ') 位用户流量"
    : > "$RUN_DIR/stats.agg"
  else
    log "✗ 流量上报失败（增量数据丢失，下一轮重新采集）"
  fi
}

# -------------------------------- 同步回执 ----------------------------------
# 「配置发出去了」不等于「配置生效了」。每轮把本机的实际结果报回面板：
# 应用到的 hash + 服务重载成败 + 失败原文，面板据此显示「已同步 / 待同步 / 同步失败」。
#
# 只在结果变化、或距上次超过 10 分钟时才发 —— 否则每台机器每分钟都多一个请求，
# 面板上的「最近回执时间」也没必要精确到秒。

receipt_escape() {
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g' | tr -d '\r' | tr '\n' ' ' | cut -c1-400
}

send_receipt() {
  # 签名要写进 state 文件的第二行：先把换行压掉，否则永远读不回原值、每轮都重发。
  # 指纹清单也进签名：证书重签 → 指纹变化 → 回执立即重发，面板订阅里的 pcs 才不会拿着旧指纹
  _sig="${NP_HASH:-}|$RC_OK|$RC_XRAY|$RC_HY|${BAD_PORTS:-}|$(printf '%s' "$RC_ERR" | tr '\n' ' ')|$(tr '\n' ' ' 2>/dev/null < "$RUN_DIR/selfcerts.list")"
  _last=''
  _ts=0
  if [ -f "$STATE_DIR/.receipt" ]; then
    _ts=$(sed -n '1p' "$STATE_DIR/.receipt" 2>/dev/null)
    _last=$(sed -n '2p' "$STATE_DIR/.receipt" 2>/dev/null)
  fi
  case "$_ts" in '' | *[!0-9]*) _ts=0 ;; esac
  _now=$(date +%s)
  if [ "$_last" = "$_sig" ] && [ $((_now - _ts)) -lt 600 ]; then
    return 0
  fi

  _err=$(printf '%s' "$RC_ERR" | receipt_escape)
  _ok=false
  [ "$RC_OK" = '1' ] && _ok=true
  # 自签证书指纹：nodeId → SHA-256（64 hex）。没有自签节点时整个字段不带
  _extra=''
  if [ -s "$RUN_DIR/selfcerts.list" ]; then
    _extra="\"selfCerts\":{$(awk '{ printf "%s\"%s\":\"%s\"", sep, $1, $2; sep="," }' "$RUN_DIR/selfcerts.list" 2>/dev/null)},"
  fi
  mkdir -p "$RUN_DIR" "$STATE_DIR" 2>/dev/null
  _f="$RUN_DIR/receipt.$$.json"
  printf '{"hash":"%s","ok":%s,"error":"%s","xray":"%s","hy":"%s","unbound":"%s",%s"nodes":%s,"users":%s,"agentVersion":"%s"}\n' \
    "${NP_HASH:-}" "$_ok" "$_err" "${RC_XRAY:-ok}" "${RC_HY:-0/0}" "${BAD_PORTS:-}" \
    "$_extra" "${NP_NODES:-0}" "${NP_USERS:-0}" "$VERSION" > "$_f" 2>/dev/null

  if http_post_json "$PANEL_URL/api/agent/receipt?token=$AGENT_TOKEN&v=$VERSION" "$_f" "Authorization: Bearer $AGENT_TOKEN" >/dev/null; then
    printf '%s\n%s\n' "$_now" "$_sig" > "$STATE_DIR/.receipt" 2>/dev/null
    if [ "$_ok" = 'true' ]; then
      log "✓ 已回执：配置 ${NP_HASH:-（空）} 已生效"
    else
      log "✗ 已回执：$RC_ERR"
    fi
  else
    log "! 回执上报失败（下一轮再试）"
  fi
  rm -f "$_f"
}

# -------------------------------- 自更新 ------------------------------------
# 面板在配置包的 state.env 里下发 NP_AGENT_VERSION。本机 VERSION 与之不同时，
# 从面板拉一份新脚本 → 语法检查 → 原子替换自身 → exec 重启。
#
# 为什么要做这件事：面板发版后如果 agent 脚本本身也改了，以前只能登每台机器
# 重跑一遍部署命令。有了自更新，升级面板 = 升级全部机器。
#
# 失败计数挂在目标版本上：同一个版本连续失败 3 次就停手，等下一版再试。
# 否则一个坏包会让每台机器每分钟都来拉一次，把面板和日志一起拖垮。

agent_update_mark() {
  printf '%s\n%s\n' "$1" "${2:-0}" > "$STATE_DIR/.agent-update" 2>/dev/null
}

agent_update_fail() {
  # $1 = 目标版本，$2 = 当前已失败次数
  log "✗ agent 自更新到 $1 失败（第 $(( $2 + 1 )) 次）"
  agent_update_mark "$1" "$(( $2 + 1 ))"
}

agent_self_update() {
  _want=${NP_AGENT_VERSION:-}
  [ -n "$_want" ] || return 0
  [ "$_want" = "$VERSION" ] && return 0

  _cnt=0
  _last=''
  if [ -f "$STATE_DIR/.agent-update" ]; then
    _last=$(sed -n '1p' "$STATE_DIR/.agent-update" 2>/dev/null)
    _cnt=$(sed -n '2p' "$STATE_DIR/.agent-update" 2>/dev/null)
    case "$_cnt" in '' | *[!0-9]*) _cnt=0 ;; esac
    if [ "$_last" = "$_want" ] && [ "$_cnt" -ge 3 ]; then
      return 0   # 这个版本已经试够次数了，安静等着
    fi
  fi
  [ "$_last" = "$_want" ] || _cnt=0

  log "发现新版本 agent $_want（当前 $VERSION），开始自更新"
  _tmp="$STATE_DIR/agent.sh.new"
  rm -f "$_tmp" 2>/dev/null
  if ! http_get "$PANEL_URL/api/agent/script?token=$AGENT_TOKEN&v=$VERSION" "Authorization: Bearer $AGENT_TOKEN" 30 > "$_tmp" 2>/dev/null; then
    agent_update_fail "$_want" "$_cnt"
    return 1
  fi

  # 三道闸：shebang 对、语法过、版本号确实是想要的那个
  if ! head -n 1 "$_tmp" 2>/dev/null | grep -q '^#!'; then
    log "✗ 下载内容不是脚本（可能是错误页），放弃更新"
    agent_update_fail "$_want" "$_cnt"
    rm -f "$_tmp"
    return 1
  fi
  if ! sh -n "$_tmp" 2>/dev/null; then
    log "✗ 新脚本语法检查未通过，保留当前版本"
    agent_update_fail "$_want" "$_cnt"
    rm -f "$_tmp"
    return 1
  fi
  if ! grep -q "^VERSION='$_want'\$" "$_tmp" 2>/dev/null; then
    log "✗ 下载的脚本版本号不是 $_want，放弃更新"
    agent_update_fail "$_want" "$_cnt"
    rm -f "$_tmp"
    return 1
  fi

  chmod 755 "$_tmp" 2>/dev/null
  cp -p "$SELF_PATH" "$SELF_PATH.bak" 2>/dev/null
  if ! mv "$_tmp" "$SELF_PATH" 2>/dev/null; then
    log "✗ 无法写入 $SELF_PATH（权限不足？agent 需要以 root 运行）"
    agent_update_fail "$_want" "$_cnt"
    rm -f "$_tmp"
    return 1
  fi

  rm -f "$STATE_DIR/.agent-update" 2>/dev/null
  log "✓ agent 已更新到 $_want，重启进程"
  # exec 在同一个 PID 上换成新脚本：systemd 看来服务没有中断，
  # 也不会出现「旧进程还在跑、又被拉起一个新进程」的双跑
  exec sh "$SELF_PATH" $RUN_ARGS
}

# --------------------------------- 主循环 -----------------------------------

tick() {
  # 每轮都重新读一次状态，--once 模式下也能拿到上一轮的结果
  [ -f "$STATE_DIR/state.env" ] && . "$STATE_DIR/state.env"
  [ -f "$STATE_DIR/changed.env" ] && . "$STATE_DIR/changed.env"

  # 回执状态按轮重置，避免上一轮的失败一直挂着
  RC_OK=1
  RC_XRAY=''
  RC_HY=''
  RC_HY_FAIL=''
  RC_ERR=''
  BAD_PORTS=''
  NP_JUST_RESTARTED=0
  NP_STARTED_HY=''
  SOCK_LIST=''
  LAST_FETCH_OK=0

  if apply_bundle; then
    apply_services changed
    log "面板在线 · ${NP_SCOPE:-未知} · ${NP_NODES:-0} 个节点 / ${NP_USERS:-0} 位可用用户"
  else
    # 配置没变也要跑：把意外挂掉的 Hysteria2 拉起来
    apply_services same
  fi

  # 只有和面板通上话才回执：离线时上报必然失败，没必要每分钟重试一次
  [ "$LAST_FETCH_OK" = '1' ] && send_receipt

  collect_stats
  report

  # 自更新放最后：这一轮的配置与流量都已经处理完，重启不会丢数据
  agent_self_update
}

# --------------------------------- 卸载 -------------------------------------
# 面板上的「卸载命令」是面板现场生成的脚本，必须联网才能取到
# （curl …/api/servers/<id>/uninstall?token=…）。面板被删、换域名、token 失效时
# 这条路就断了，机器上会留一个永远在喊「无法连接面板」的孤儿 agent。
#
# 0.1.16 起把同一套清理逻辑做成本地入口：部署脚本会写一份
# $STATE_DIR/uninstall.sh 转发到这里，断网也能一条命令摘干净。
# 清理顺序和面板那份完全一致 —— 先停服务（Restart=always 会把进程再拉回来），
# 再删文件；Xray 只动「确实带 StatsService 的那份配置」，不误删管理员自己的。
np_uninstall() {
  _purge=0
  for _arg in "$@"; do
    case "$_arg" in
      --purge | -p) _purge=1 ;;
      -h | --help)
        echo "用法：sh $STATE_DIR/uninstall.sh [--purge]"
        echo "  默认     停掉并清理 agent、Hysteria2 实例、Xray 配置与自签证书（配置会先备份）"
        echo "  --purge  连 $LOG_DIR 与配置备份一起删掉"
        return 0
        ;;
      --uninstall | __np_uninstall) ;;
      *) echo "! 忽略未知参数：$_arg" ;;
    esac
  done

  if [ "$(id -u 2>/dev/null)" != '0' ]; then
    echo "✗ 请用 root 执行（需要删除 $STATE_DIR、/etc 与注销系统服务）"
    return 1
  fi

  _bak="$XRAY_CONFIG.nodepanel.bak"

  echo "→ 停止并注销 nodepanel-agent"

  if [ -f /etc/systemd/system/nodepanel-agent.service ]; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl stop nodepanel-agent >/dev/null 2>&1
      systemctl disable nodepanel-agent >/dev/null 2>&1
    fi
    rm -f /etc/systemd/system/nodepanel-agent.service
    if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1; fi
    echo "  ✓ 已移除 systemd 服务"
  fi

  if [ -f /etc/init.d/nodepanel-agent ]; then
    if command -v rc-service >/dev/null 2>&1; then rc-service nodepanel-agent stop >/dev/null 2>&1; fi
    if command -v rc-update >/dev/null 2>&1; then rc-update del nodepanel-agent default >/dev/null 2>&1; fi
    rm -f /etc/init.d/nodepanel-agent
    echo "  ✓ 已移除 OpenRC 服务"
  fi

  if command -v crontab >/dev/null 2>&1; then
    if crontab -l 2>/dev/null | grep -q 'nodepanel/agent.sh'; then
      crontab -l 2>/dev/null | grep -v 'nodepanel/agent.sh' | crontab - 2>/dev/null
      echo "  ✓ 已移除 crontab 定时任务"
    fi
  fi

  # 兜底：手工 nohup 起来的进程。本脚本是从 /tmp 的副本跑的，不会误杀自己
  if command -v pkill >/dev/null 2>&1; then
    if pkill -f "$STATE_DIR/agent.sh" 2>/dev/null; then
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

  if ls "$HYSTERIA_DIR"/node-*.yaml >/dev/null 2>&1; then
    rm -f "$HYSTERIA_DIR"/node-*.yaml
    echo "  ✓ 已删除 agent 下发的 Hysteria2 配置（$HYSTERIA_DIR/node-*.yaml）"
  fi

  # pid 文件丢了（手删 / 机器重启）时按命令行兜底，只匹配 agent 自己下发的实例
  if command -v pkill >/dev/null 2>&1; then
    if pkill -f "$HYSTERIA_BIN server -c $HYSTERIA_DIR/node-" 2>/dev/null \
       || pkill -f '/usr/local/bin/streamd server -c /etc/streamd/node-' 2>/dev/null \
       || pkill -f 'hysteria server -c /etc/hysteria/node-' 2>/dev/null; then
      echo "  ✓ 已结束残留的 Hysteria2 实例"
    fi
  fi

  echo "→ 删除 agent 文件与运行时目录"
  rm -rf "$STATE_DIR" "$RUN_DIR"
  echo "  ✓ 已删除 $STATE_DIR 与 $RUN_DIR"

  if [ -d /etc/nodepanel ]; then
    rm -rf /etc/nodepanel
    echo "  ✓ 已删除自签证书目录 /etc/nodepanel"
  fi

  echo "→ 停掉 Xray 并清理面板生成的配置"
  # 服务名不一定是 xray：伪装名 / xray-core / x-ui 都见过
  _unit=''
  if command -v systemctl >/dev/null 2>&1; then
    for _u in "$XRAY_ALIAS" xray xray-core x-ui; do
      if systemctl list-unit-files 2>/dev/null | grep -q "^$_u\.service"; then
        _unit=$_u
        break
      fi
    done
  fi
  if [ -z "$_unit" ] && [ -f "/etc/init.d/$XRAY_ALIAS" ]; then _unit=$XRAY_ALIAS; fi
  if [ -z "$_unit" ] && [ -f /etc/init.d/xray ]; then _unit=xray; fi

  # 只动「确实是面板写的」那份配置：面板生成的配置一定带 StatsService。
  # 机器上原有的、管理员自己的 xray 配置一律不碰 —— 卸载命令不该误删别人的服务
  if [ ! -f "$XRAY_CONFIG" ]; then
    echo "  · 没有 $XRAY_CONFIG（这台机器可能还没部署过节点），跳过"
  elif ! grep -q 'StatsService' "$XRAY_CONFIG" 2>/dev/null; then
    echo "  · $XRAY_CONFIG 不是面板生成的（没有 StatsService），Xray 与配置都保留"
  else
    if [ -n "$_unit" ]; then
      if command -v systemctl >/dev/null 2>&1; then
        systemctl stop "$_unit" >/dev/null 2>&1
        systemctl disable "$_unit" >/dev/null 2>&1
      elif command -v rc-service >/dev/null 2>&1; then
        rc-service "$_unit" stop >/dev/null 2>&1
        command -v rc-update >/dev/null 2>&1 && rc-update del "$_unit" default >/dev/null 2>&1
      fi
      echo "  ✓ 已停止并取消开机自启 $_unit"
    fi

    if cp -f "$XRAY_CONFIG" "$_bak" 2>/dev/null; then
      echo "  ✓ 已备份 Xray 配置到 $_bak"
    fi
    rm -f "$XRAY_CONFIG"
    echo "  ✓ 已移除面板生成的 $XRAY_CONFIG"

    # 没有服务单元时（手工 nohup 起的），按进程名收尾 —— 否则端口会一直被占着
    if [ -z "$_unit" ] && command -v pkill >/dev/null 2>&1; then
      if pkill -x "$XRAY_ALIAS" 2>/dev/null || pkill -x xray 2>/dev/null; then
        echo "  ✓ 已结束手工启动的 Xray 进程"
      fi
    fi
  fi

  if [ "$_purge" = '1' ]; then
    echo "→ 深度清理（--purge）"
    rm -rf "$LOG_DIR"
    echo "  ✓ 已删除日志目录 $LOG_DIR"
    rm -f "$_bak"
    echo "  ✓ 已删除配置备份 $_bak"
  else
    echo ""
    echo "· 保留 $LOG_DIR（要一起清掉就加 --purge 重跑）"
    echo "· 保留 $_bak（面板覆盖前的配置备份，不需要可手动删）"
  fi

  if [ -x "/usr/local/bin/$XRAY_ALIAS" ] || [ -x /usr/local/bin/xray ]; then
    echo "· 保留 Xray 二进制与 geo 数据（可能是你自己装的；"
    echo "  确认是面板装的那份，可执行：rm -rf /usr/local/bin/$XRAY_ALIAS /usr/local/share/$XRAY_ALIAS）"
  fi

  echo ""
  echo "✓ 卸载完成：agent 已注销，节点端口不再监听"
  echo "  面板里的服务器 / 节点记录还在，重新执行部署命令即可恢复接入。"
  return 0
}

# 卸载模式在函数都定义好之后才执行：它会删掉 $STATE_DIR，
# 所以必须等这个脚本自己全部读完（--uninstall 已经把自己拷到 /tmp 了）
if [ "$NP_MODE" = 'uninstall' ]; then
  np_uninstall "$@"
  _np_rc=$?
  # 从 /tmp 副本跑的话顺手把自己删掉：真正要删的东西已经在 np_uninstall 里处理完了
  case "$SELF_PATH" in /tmp/.nodepanel-uninstall.*) rm -f "$SELF_PATH" 2>/dev/null ;; esac
  exit "$_np_rc"
fi

log "Node Panel Agent $VERSION 启动"
log "面板：$PANEL_URL"
log "HTTP：${HTTP:-未找到 curl/wget}"
log "Xray：$XRAY_CONFIG · Hysteria2：$HYSTERIA_DIR"
# 重载命令是「配置没生效」类问题的第一嫌疑，启动时先把它亮出来
_detect_cmd=$(detect_reload_cmd)
if [ -n "${RELOAD_CMD:-}" ]; then
  _reload_show=$RELOAD_CMD
elif [ -n "$_detect_cmd" ]; then
  _reload_show=$_detect_cmd
elif command -v systemctl >/dev/null 2>&1 || command -v rc-service >/dev/null 2>&1; then
  # 有服务管理器却没匹配到 xray 单元：这台机器的服务名可能不叫 xray / xray-core / x-ui
  _reload_show='未找到 xray 服务单元（配置写入后需手动重启）'
else
  _reload_show='无服务管理器（配置写入后需手动重启）'
fi
log "重载：$_reload_show · 轮询 ${INTERVAL}s"

if [ "${1:-}" = '--once' ]; then
  tick
  exit 0
fi

trap 'log "收到退出信号，agent 停止"; exit 0' TERM INT
while :; do
  tick
  # 面板已经不认这台机器时转低频：日志不刷屏、请求不空转，
  # 面板记录一旦恢复（重新部署 / 从备份恢复），最多一个 ORPHAN_INTERVAL 就自己回来
  if [ "$NP_ORPHAN" = '1' ]; then
    sleep "$ORPHAN_INTERVAL"
  else
    sleep "$INTERVAL"
  fi
done
