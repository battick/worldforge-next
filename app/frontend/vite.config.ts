import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiTarget = process.env.WORLDFORGE_API_URL ?? `http://127.0.0.1:${process.env.WORLDFORGE_API_PORT ?? 4318}`;
const port = Number(process.env.WORLDFORGE_WEB_PORT ?? process.env.PORT ?? 4317);
const webBuildId = randomUUID();
const proxy = { '/api': { target: apiTarget, changeOrigin: true } };
const headers = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${new URL(apiTarget).origin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
};
export default defineConfig({
  root, plugins: [react(), {
    name: 'web-version', apply: 'build',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'web-version.json', source: JSON.stringify({ buildId: webBuildId }) }); },
  }],
  define: { 'import.meta.env.WORLDFORGE_WEB_BUILD_ID': JSON.stringify(webBuildId) },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port, strictPort: true, proxy, fs: { allow: [root, path.resolve(root, '../contracts'), path.resolve(root, '../client'), path.resolve(root, '../node_modules')] } },
  preview: { host: '127.0.0.1', port, strictPort: true, proxy, headers },
});
