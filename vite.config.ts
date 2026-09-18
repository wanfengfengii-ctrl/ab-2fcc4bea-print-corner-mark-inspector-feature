/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Docker 验收环境在 compose 网络内以服务名访问预览（Host: web:5173）。
  // Vite ≥5.4.17 的 DNS 重绑定保护默认只放行 localhost 与 IP 字面量，
  // 对 "web" 这类主机名直接 403，需显式放行，否则容器内页面全部打不开。
  preview: {
    allowedHosts: ['web'],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
