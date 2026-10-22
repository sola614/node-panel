# syntax=docker/dockerfile:1
FROM node:20-alpine

LABEL org.opencontainers.image.title="node-panel" \
      org.opencontainers.image.description="轻量节点管理面板：用户 / 套餐 / 节点 / 服务器 + 订阅与流量配额" \
      org.opencontainers.image.source="https://github.com/sola614/node-panel" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PANEL_DATA_DIR=/app/data

# 零依赖项目，不需要 npm install，直接拷源码
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY agent ./agent

RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 8080

# 用 node 自带的 fetch 做探针，镜像里不需要装 curl
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
