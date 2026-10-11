FROM node:20.20.0-alpine3.23
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 TZ=Asia/Shanghai
COPY package*.json ./
RUN npm ci --omit=dev --include=optional --no-fund --no-audit && npm cache clean --force
COPY . .
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "server.js"]
