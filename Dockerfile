# 基础镜像：Node 24 LTS（当前 v24.22.1）。
# 2026-10-22 从 node:20-alpine 升级：Node 20 已 EOL 且不提供 CVE-2026-111497
# （Brotli 解码器越界写 → RCE，HIGH）等 2026-10 安全公告的修复；Node 24.22.1 已含全部修复。
# sharp 走 N-API，与 Node 版本无关；linuxmusl 预编译包已锁定在 lockfile 中。
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 TZ=Asia/Shanghai
COPY package*.json ./
RUN npm ci --omit=dev --include=optional --no-fund --no-audit && npm cache clean --force
COPY . .
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "server.js"]
