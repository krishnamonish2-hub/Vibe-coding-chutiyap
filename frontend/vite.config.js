import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The browser only ever calls the MessMind backend (/api). In development Vite proxies /api to it,
// so no CORS is needed. The ML service is never called from the frontend.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', 'VITE_'); // shared .env at the repository root
  const backend = env.VITE_BACKEND_URL || 'http://127.0.0.1:4000';
  return {
    plugins: [react()],
    server: { port: 5173, proxy: { '/api': backend } },
    preview: { port: 4173, proxy: { '/api': backend } },
    // Component tests (npm test): jsdom, no network — every test mocks fetch.
    test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'], restoreMocks: true },
  };
});
