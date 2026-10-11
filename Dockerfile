# 基础镜像沿用 node:20-alpine（服务器本地已缓存）：部署环境无法访问 Docker Hub，
# 固定小版本标签会触发远端 manifest 解析失败；musl 版本以 sharp 官方预编译兼容为准。
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 TZ=Asia/Shanghai
COPY package*.json ./
RUN npm ci --omit=dev --include=optional --no-fund --no-audit && npm cache clean --force
COPY . .
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "server.js"]
