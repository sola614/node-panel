#!/bin/sh
# ============================================================================
# Node Panel 容器入口
#
# 存在的理由：绑定挂载数据目录时，Docker 不会把镜像里的属主带过去，
# 宿主机上 ./data 会是 root 所有，而容器默认以 node 用户运行，
# 于是 SQLite 打不开数据库文件（unable to open database file）。
#
# 所以这里以 root 起容器，把数据目录属主修好，再降权回 node 用户跑面板。
# 命名卷和绑定挂载就都能用了，用户不必记得 chown。
# ============================================================================
set -eu

DATA_DIR="${PANEL_DATA_DIR:-/app/data}"
RUN_USER="node"
RUN_UID="${RUN_UID:-1000}"

log() { echo "[entrypoint] $*"; }

# ------------------------------ root 启动 ------------------------------
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true

  # 修属主。-R 是因为历史数据可能已经用 root 建过；
  # 绑定挂载时这一步会顺带把宿主机目录的属主改掉，效果等同于命名卷的自动处理。
  if id "$RUN_USER" >/dev/null 2>&1; then
    chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR" 2>/dev/null || true
  else
    chown -R "$RUN_UID":"$RUN_UID" "$DATA_DIR" 2>/dev/null || true
  fi

  # 降权：su-exec 是 Alpine 上等价 gosu 的小工具
  if command -v su-exec >/dev/null 2>&1 && id "$RUN_USER" >/dev/null 2>&1; then
    exec su-exec "$RUN_USER" "$0" "$@"
  fi

  log "未找到 su-exec 或 $RUN_USER 用户，继续以 root 运行（功能不受影响）"
  exec "$@"
fi

# ---------------------------- 已是非 root 用户 ----------------------------
# 用户可能用 user: 1000:1000 或 --user 覆盖了运行身份，这时没资格修属主，
# 只能把问题说清楚，别让面板带着一句看不懂的 SQLite 报错挂掉。
if [ ! -d "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || {
    echo "[entrypoint] ✗ 无法创建数据目录 $DATA_DIR" >&2
    exit 1
  }
fi

if [ ! -w "$DATA_DIR" ]; then
  cat >&2 <<EOF
[entrypoint] ✗ 数据目录 $DATA_DIR 不可写（当前 uid=$(id -u)）。

绑定宿主机目录时 Docker 不会沿用镜像里的属主，目录会是 root 所有。
在宿主机上执行一次即可：

    mkdir -p ./data && sudo chown -R 1000:1000 ./data

或者干脆用命名卷，属主由 Docker 自动处理：

    volumes:
      - panel-data:/app/data
EOF
  exit 1
fi

exec "$@"
