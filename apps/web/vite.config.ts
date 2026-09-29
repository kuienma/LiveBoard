import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 手机要通过局域网访问，默认监听所有网卡
    host: true,
    // 走代理而不是 CORS：手机访问的是 Vite 这个源，/api 由 Vite 转给后端
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
})
