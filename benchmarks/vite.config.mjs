import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);

export default defineConfig({
  publicDir: fileURLToPath(new URL('../fixtures/generated/', import.meta.url)),
  optimizeDeps: { exclude: ['@raykit/web', '@cornerstonejs/dicom-image-loader'] },
  resolve: { alias: { events: require.resolve('events/'), url: require.resolve('url/') } },
  worker: { format: 'es' },
});
