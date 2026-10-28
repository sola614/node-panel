# syntax=docker/dockerfile:1
# node:sqlite 从 Node 22.13 起默认可用（无需 flag）。镜像跟随 Active LTS（24，维护到 2028-04），
# 自建部署的最低版本写在 package.json 的 engines 里（>=22.13）
FROM node:24-alpine

# 版本号由 CI 从 package.json 读取后传进来，保证镜像 tag 与应用版本一致
ARG APP_VERSION=0.1.0

LABEL org.opencontainers.image.title="node-panel" \
      org.opencontainers.image.description="轻量节点管理面板：用户 / 套餐 / 节点 / 服务器 + 订阅与流量配额" \
      org.opencontainers.image.source="https://github.com/sola614/node-panel" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PANEL_DATA_DIR=/app/data

# 零 npm 依赖项目（SQLite 用 Node 内置的 node:sqlite），不需要 npm install
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY agent ./agent

# 入口脚本负责把数据目录属主修好再降权运行，su-exec 是 Alpine 上的 gosu 等价物
# openssl：面板侧签证书时 acme.sh 要用它生成 EC 私钥（镜像里默认只有 libssl，没有 CLI）
# curl：acme.sh 的下载与部分 DNS 插件依赖它，busybox wget 能凑合但不稳
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && apk add --no-cache su-exec openssl curl

RUN mkdir -p /app/data && chown -R node:node /app

VOLUME ["/app/data"]
EXPOSE 8080

# 用 node 自带的 fetch 做探针，镜像里不需要装 curl
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 以 root 启动，由入口脚本降权到 node：这样绑定挂载的数据目录也能被修好属主
USER root
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
