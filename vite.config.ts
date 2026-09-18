/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  preview: {
    // Docker Compose 验收中 verify 容器以 http://web:5173 访问预览服务，
    // Host 为 compose 服务名 web；vite preview 默认只放行 localhost/IP，
    // 不声明会以 403 拦截该主机名，导致端到端验收全部失败。
    allowedHosts: ['web'],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
