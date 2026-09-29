import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served by the gateway at /dashboard/. `pnpm dev` proxies the API to a running gateway.
const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4300'
export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(['/info', '/calls', '/events', '/reconcile', '/proofs', '/services'].map((p) => [p, gateway])),
  },
})
