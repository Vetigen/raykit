import { cache, Enums, imageLoader, init as coreInit, RenderingEngine } from '@cornerstonejs/core';
import { init as loaderInit, wadouri } from '@cornerstonejs/dicom-image-loader';

let init;
let instance = 0;

export async function create(host, file, count) {
  await (init ??= (async () => { await coreInit(); loaderInit({ maxWebWorkers: 1 }); cache.setMaxCacheSize(64 * 1024 * 1024); })());
  const engine = new RenderingEngine(`comparison-${++instance}`);
  try {
    engine.enableElement({ viewportId: 'stack', type: Enums.ViewportType.STACK, element: host });
    const view = engine.getViewport('stack');
    const id = wadouri.fileManager.add(file);
    const images = count === 1 ? [id] : Array.from({ length: count }, (_, i) => `${id}?frame=${i + 1}`);
    await view.setStack(images, 0);
    await paint(host, () => view.render());
    const initialPan = view.getPan();
    const initialZoom = view.getZoom();
    const readTimes = new Map();
    return {
      name: 'Cornerstone3D', count,
      readTime(index) { return readTimes.get(index); },
      async seek(i) { await view.setImageIdIndex(i); await paint(host, () => view.render()); },
      async sample(index, row, col) {
        const image = await imageLoader.loadAndCacheImage(images[index]);
        if (Number.isFinite(image.totalTimeInMS) && Number.isFinite(image.loadTimeInMS)) {
          readTimes.set(index, image.totalTimeInMS - image.loadTimeInMS);
        }
        const pixels = image.getPixelData();
        const components = pixels.length / (image.columns * image.rows);
        const start = (row * image.columns + col) * components;
        if (components !== 1) return Array.from(pixels.slice(start, start + 3));
        if (!image.preScale?.scaled) return pixels[start];
        return (pixels[start] - image.intercept) / image.slope;
      },
      window(center, width) { return paint(host, () => {
        const lower = center - 0.5 - (width - 1) / 2;
        view.setProperties({ voiRange: { lower, upper: lower + width - 1 } }); view.render();
      }); },
      panZoom(x, y, zoom) { return paint(host, () => {
        view.setZoom(initialZoom * zoom);
        view.setPan([initialPan[0] + x, initialPan[1] + y]);
        view.render();
      }); },
      metrics() { return { cache_bytes: cache.getCacheSize() }; },
      close() { engine.destroy(); cache.purgeCache(); wadouri.fileManager.purge(); wadouri.dataSetCacheManager.purge(); host.replaceChildren(); },
    };
  } catch (error) { engine.destroy(); throw error; }
}

function paint(host, action) {
  return new Promise(resolve => {
    host.addEventListener(Enums.Events.IMAGE_RENDERED, resolve, { once: true });
    action();
  });
}
