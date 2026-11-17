import { cache, Enums, init as coreInit, RenderingEngine } from '@cornerstonejs/core';
import { init as loaderInit, wadouri } from '@cornerstonejs/dicom-image-loader';
import { observeDraw } from './presentation.js';

let init;
let instance = 0;

export async function create(host, file, count, probe) {
  await (init ??= (async () => { await coreInit(); loaderInit({ maxWebWorkers: 1 }); cache.setMaxCacheSize(64 * 1024 * 1024); })());
  const engine = new RenderingEngine(`comparison-${++instance}`);
  const close = () => {
    engine.destroy(); cache.purgeCache(); wadouri.fileManager.purge(); wadouri.dataSetCacheManager.purge(); host.replaceChildren();
  };
  try {
    engine.enableElement({ viewportId: 'stack', type: Enums.ViewportType.STACK, element: host });
    const view = engine.getViewport('stack');
    const id = wadouri.fileManager.add(file);
    const images = count === 1 ? [id] : Array.from({ length: count }, (_, i) => `${id}?frame=${i + 1}`);
    const present = (index, draw, point) => observeDraw(host, Enums.Events.IMAGE_RENDERED, ({ detail }) => {
      if (detail.viewportId !== view.id || detail.renderingEngineId !== engine.id) return;
      const image = view.getCornerstoneImage();
      if (view.getCurrentImageIdIndex() !== index || image?.imageId !== images[index] ||
          image.imageQualityStatus !== Enums.ImageQualityStatus.FULL_RESOLUTION) return;
      const work = image.totalTimeInMS - image.loadTimeInMS;
      return { source_id: image.imageId, frame: index, sample: point && originalPixel(image, point),
        work_ms: Number.isFinite(work) ? work : null };
    }, draw);
    const first = await present(0, () => view.setStack(images, 0), probe);
    const initialPan = view.getPan();
    const initialZoom = view.getZoom();
    return {
      name: 'Cornerstone3D', count: view.getImageIds().length, first,
      seek(i, point) {
        return present(i, () => view.getCurrentImageIdIndex() === i ? view.render() : view.setImageIdIndex(i), point);
      },
      window(center, width) { return present(0, () => {
        const lower = center - 0.5 - (width - 1) / 2;
        view.setProperties({ voiRange: { lower, upper: lower + width - 1 } }); view.render();
      }); },
      panZoom(x, y, zoom) { return present(0, () => {
        view.setZoom(initialZoom * zoom);
        view.setPan([initialPan[0] + x, initialPan[1] + y]);
        view.render();
      }); },
      metrics() { return { cache_bytes: cache.getCacheSize() }; },
      close,
    };
  } catch (error) { close(); throw error; }
}

function originalPixel(image, { row, col }) {
  const pixels = image.getPixelData();
  const components = pixels.length / (image.columns * image.rows);
  const start = (row * image.columns + col) * components;
  if (components !== 1) return Array.from(pixels.slice(start, start + 3));
  if (!image.preScale?.scaled) return pixels[start];
  return (pixels[start] - image.intercept) / image.slope;
}
