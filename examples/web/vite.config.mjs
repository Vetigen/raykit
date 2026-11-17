import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { syntheticDicomweb } from './dicomweb-fixture.mjs';

export default defineConfig({
  publicDir: fileURLToPath(new URL('../../fixtures/generated/', import.meta.url)),
  optimizeDeps: { exclude: ['@raykit/web', '@raykit/web-component'] },
  worker: { format: 'es' },
  plugins: [{ name: 'raykit-synthetic-dicomweb',
    configureServer(server) { server.middlewares.use(syntheticDicomweb); },
    configurePreviewServer(server) { server.middlewares.use(syntheticDicomweb); },
  }],
});
