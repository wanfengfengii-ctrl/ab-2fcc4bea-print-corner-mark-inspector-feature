# syntax=docker/dockerfile:1

# ---------- web：构建并以静态方式托管核验页 ----------
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 5173
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]

# ---------- verify：一次性验收（单元测试 + 端到端测试，跑完即退出） ----------
FROM mcr.microsoft.com/playwright:v1.48.2-jammy AS verify
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV BASE_URL=http://web:5173
CMD ["npm", "run", "verify"]
