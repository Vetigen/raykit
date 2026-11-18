import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
const dwvWorkers = join(dirname(require.resolve('dwv')), 'assets/workers');
const installed = process.env.RAYKIT_WEB_DIST;

export default defineConfig({
  publicDir: fileURLToPath(new URL('../fixtures/generated/', import.meta.url)),
  optimizeDeps: { exclude: ['@vetigen/raykit-web', '@cornerstonejs/dicom-image-loader'] },
  resolve: { alias: { events: require.resolve('events/'), url: require.resolve('url/'),
    ...(installed ? { '@vetigen/raykit-web': resolve(installed, 'index.js') } : {}),
  } },
  worker: { format: 'es' },
  plugins: [{
    name: 'dwv-benchmark-workers',
    generateBundle() {
      for (const name of readdirSync(dwvWorkers).filter(name => name.endsWith('.min.js'))) {
        this.emitFile({ type: 'asset', fileName: `assets/workers/${name}`, source: readFileSync(join(dwvWorkers, name)) });
      }
    },
  }],
});
