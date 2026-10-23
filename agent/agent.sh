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
#     「比对 hash → 执行配置包 → 收敛服务 → 采流量上报」
#   · Hysteria2 用 pid 文件自己托管，不依赖 systemd / OpenRC 的模板单元
#
# 环境变量（写在同目录 agent.env，或用环境变量覆盖）：
#   PANEL_URL        面板地址，必填
#   AGENT_TOKEN      服务器 token 或独立节点 token，必填
#   INTERVAL         轮询间隔秒数，默认 60
#   XRAY_CONFIG      Xray 配置路径，默认 /usr/local/etc/xray/config.json
#   RELOAD_CMD       重载 Xray 的命令，默认自动探测
#   HYSTERIA_DIR     Hysteria2 配置目录，默认 /etc/hysteria
#   HYSTERIA_BIN     hysteria 可执行文件，默认 /usr/local/bin/hysteria
#   STATE_DIR        状态目录，默认 /opt/nodepanel
#   RUN_DIR          运行时目录（pid），默认 /run/nodepanel
#   LOG_DIR          日志目录，默认 /var/log/nodepanel
#
# 用法：
#   sh agent.sh           常驻循环（systemd / OpenRC 用这个）
#   sh agent.sh --once    只跑一轮（cron 用这个）
#   sh agent.sh --version
# ============================================================================

VERSION='2.1.0'

SELF_DIR=$(dirname "$0")
[ -f "$SELF_DIR/agent.env" ] && . "$SELF_DIR/agent.env"
[ -n "${AGENT_ENV:-}" ] && [ -f "$AGENT_ENV" ] && . "$AGENT_ENV"

PANEL_URL=${PANEL_URL:-}
AGENT_TOKEN=${AGENT_TOKEN:-}
INTERVAL=${INTERVAL:-60}
XRAY_CONFIG=${XRAY_CONFIG:-/usr/local/etc/xray/config.json}
HYSTERIA_DIR=${HYSTERIA_DIR:-/etc/hysteria}
HYSTERIA_BIN=${HYSTERIA_BIN:-/usr/local/bin/hysteria}
STATE_DIR=${STATE_DIR:-/opt/nodepanel}
RUN_DIR=${RUN_DIR:-/run/nodepanel}
LOG_DIR=${LOG_DIR:-/var/log/nodepanel}
HTTP_TIMEOUT=${HTTP_TIMEOUT:-15}
LOG_MAX=${LOG_MAX:-5242880}

if [ -z "$PANEL_URL" ] || [ -z "$AGENT_TOKEN" ]; then
  echo "✗ 缺少 PANEL_URL 或 AGENT_TOKEN，请检查 $SELF_DIR/agent.env" >&2
  exit 1
fi
PANEL_URL=${PANEL_URL%/}

mkdir -p "$STATE_DIR" "$RUN_DIR" "$LOG_DIR" 2>/dev/null

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

http_post() {
  _u=$1
  _f=$2
  [ -n "$HTTP" ] || return 1
  if [ "$HTTP" = 'curl' ]; then
    curl -fsS -m "$HTTP_TIMEOUT" -X POST -H 'Content-Type: text/plain' --data-binary "@$_f" "$_u" 2>/dev/null
  else
    wget -q -T "$HTTP_TIMEOUT" -O - --header='Content-Type: text/plain' --post-file="$_f" "$_u" 2>/dev/null
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

# ACME：acme.sh 是纯 shell，正好符合「不装运行时」的诉求；失败不影响其它节点
ACME_SH=${ACME_SH:-${HOME:-/root}/.acme.sh/acme.sh}

ensure_acme_cert() {
  _cn=$1
  _crt=$2
  _key=$3
  [ -n "$_crt" ] || return 0
  [ -f "$_crt" ] && return 0
  [ -f "$ACME_SH" ] || return 0

  mkdir -p "$(dirname "$_crt")" 2>/dev/null
  if [ -d "${HOME:-/root}/.acme.sh/${_cn}_ecc" ]; then
    if "$ACME_SH" --install-cert -d "$_cn" --fullchain-file "$_crt" --key-file "$_key" >/dev/null 2>&1; then
      log "ACME 证书已安装：$_cn"
    fi
    return 0
  fi

  log "申请 ACME 证书：$_cn（需要 80 端口可用且域名已解析到本机）"
  if "$ACME_SH" --issue -d "$_cn" --standalone --keylength ec-256 >/dev/null 2>&1; then
    "$ACME_SH" --install-cert -d "$_cn" --fullchain-file "$_crt" --key-file "$_key" >/dev/null 2>&1 \
      && log "ACME 证书就绪：$_crt"
  else
    log "! ACME 申请失败：$_cn（检查域名解析与 80 端口）"
  fi
}

# ------------------------------ 服务收敛 ------------------------------------

# 重载 Xray 前先自检，坏配置绝不顶掉线上正在跑的
reload_xray() {
  _bin=$(command -v xray 2>/dev/null)
  [ -n "$_bin" ] || _bin=/usr/local/bin/xray
  if [ -x "$_bin" ] && [ -f "$XRAY_CONFIG" ]; then
    if ! "$_bin" -test -config "$XRAY_CONFIG" >/dev/null 2>&1; then
      log "✗ Xray 配置自检未通过，放弃重载（线上配置保持不变）"
      return 1
    fi
  fi
  if [ -z "${RELOAD_CMD:-}" ]; then
    log "! 未配置 RELOAD_CMD，跳过 Xray 重载"
    return 1
  fi
  if sh -c "$RELOAD_CMD" >/dev/null 2>&1; then
    log "✓ Xray 已重载"
  else
    log "✗ Xray 重载失败：$RELOAD_CMD"
  fi
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

  if [ ! -x "$HYSTERIA_BIN" ]; then
    log "! 未找到 hysteria（$HYSTERIA_BIN），跳过 $_inst"
    return 1
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
  for _item in ${NP_HY2_LIST:-}; do
    _inst=${_item%%:*}
    case "$_restart" in
      *" $_inst "*) hy_stop "$_inst" ;;
    esac
    hy_ensure "$_inst"
  done
}

# ------------------------------- 配置包 -------------------------------------

fetch_bundle() {
  _url="$PANEL_URL/api/agent/bundle?token=$AGENT_TOKEN&v=$VERSION&hash=${NP_HASH:-}"
  _ip=$(public_ip)
  [ -n "$_ip" ] && _url="$_url&ip=$_ip"
  http_get "$_url"
}

# 返回 0 = 应用了配置，1 = 没变化或失败
apply_bundle() {
  _out=$(fetch_bundle)
  if [ -z "$_out" ]; then
    log "✗ 无法连接面板：$PANEL_URL"
    return 1
  fi

  case "$_out" in
    '#UNCHANGED'*) return 1 ;;
    '#ERROR'*)
      log "✗ 面板拒绝：${_out#\#ERROR }"
      return 1
      ;;
  esac

  _tmp="$RUN_DIR/bundle.$$.sh"
  printf '%s\n' "$_out" > "$_tmp" || return 1
  if sh "$_tmp" >> "$LOG_DIR/agent.log" 2>&1; then
    log "✓ 配置已更新"
    rm -f "$_tmp"
    # state.env 给下一轮用；changed.env 记录这一轮哪些文件真的变了，决定要不要重载服务
    . "$STATE_DIR/state.env" 2>/dev/null
    . "$STATE_DIR/changed.env" 2>/dev/null
    return 0
  fi

  log "✗ 配置包执行失败，详见 $LOG_DIR/agent.log"
  rm -f "$_tmp"
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

  if [ "$1" = 'changed' ]; then
    [ "${NP_CHANGED_XRAY:-0}" = '1' ] && reload_xray
    hy_sync "${NP_CHANGED_HY:-}"
    # 用完即清，避免下一轮把实例又重启一遍
    printf "NP_CHANGED_XRAY=0\nNP_CHANGED_HY=''\n" > "$STATE_DIR/changed.env" 2>/dev/null
  else
    hy_sync ''
  fi
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
  _bin=$(command -v xray 2>/dev/null)
  [ -n "$_bin" ] || _bin=/usr/local/bin/xray
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

collect_hysteria() {
  for _item in ${NP_HY2_LIST:-}; do
    _rest=${_item#*:}
    _port=${_rest%%:*}
    _secret=${_rest#*:}
    _resp=$(http_get "http://127.0.0.1:$_port/traffic?clear=1" "Authorization: $_secret" 5)
    [ -n "$_resp" ] || continue
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
        }'
  done
}

collect_stats() {
  _raw="$RUN_DIR/stats.$$.raw"
  : > "$_raw"
  collect_xray >> "$_raw" 2>/dev/null
  collect_hysteria >> "$_raw" 2>/dev/null

  awk '
    { up[$1] += ($2 == "uplink" ? $3 : 0); down[$1] += ($2 == "downlink" ? $3 : 0); seen[$1] = 1 }
    END { for (e in seen) printf "%s %d %d\n", e, up[e], down[e] }
  ' "$_raw" > "$RUN_DIR/stats.agg" 2>/dev/null
  rm -f "$_raw"
}

report() {
  [ -s "$RUN_DIR/stats.agg" ] || return 0
  _url="$PANEL_URL/api/agent/report?token=$AGENT_TOKEN&v=$VERSION"
  _ip=$(public_ip)
  [ -n "$_ip" ] && _url="$_url&ip=$_ip"

  _res=$(http_post "$_url" "$RUN_DIR/stats.agg")
  if [ -n "$_res" ]; then
    log "↑ 已上报 $(wc -l < "$RUN_DIR/stats.agg" 2>/dev/null | tr -d ' ') 位用户流量"
    : > "$RUN_DIR/stats.agg"
  else
    log "✗ 流量上报失败（增量数据丢失，下一轮重新采集）"
  fi
}

# --------------------------------- 主循环 -----------------------------------

tick() {
  # 每轮都重新读一次状态，--once 模式下也能拿到上一轮的结果
  [ -f "$STATE_DIR/state.env" ] && . "$STATE_DIR/state.env"
  [ -f "$STATE_DIR/changed.env" ] && . "$STATE_DIR/changed.env"

  if apply_bundle; then
    apply_services changed
    log "面板在线 · ${NP_SCOPE:-未知} · ${NP_NODES:-0} 个节点 / ${NP_USERS:-0} 位可用用户"
  else
    # 配置没变也要跑：把意外挂掉的 Hysteria2 拉起来
    apply_services same
  fi

  collect_stats
  report
}

case "${1:-}" in
  --version | -v)
    echo "nodepanel-agent $VERSION (shell)"
    exit 0
    ;;
esac

log "Node Panel Agent $VERSION 启动"
log "面板：$PANEL_URL"
log "HTTP：${HTTP:-未找到 curl/wget}"
log "Xray：$XRAY_CONFIG · Hysteria2：$HYSTERIA_DIR"

if [ "${1:-}" = '--once' ]; then
  tick
  exit 0
fi

trap 'log "收到退出信号，agent 停止"; exit 0' TERM INT
while :; do
  tick
  sleep "$INTERVAL"
done
