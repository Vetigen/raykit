import { App, AppOptions, Index, Scalar3D, WindowLevel } from 'dwv';
import { observeDraw } from './presentation.js';

export async function create(host, file, expectedCount, probe) {
  const app = new App();
  app.init(new AppOptions({ '*': [{ divId: host.id }] }));
  let id;
  let first;
  let loadError;
  const close = () => { app.reset(); host.replaceChildren(); };
  const identify = (event, index, point) => {
    if (event.dataid !== id) return;
    const layer = app.getViewLayersByDataId(id).find(layer => layer.getId() === event.layerid);
    const position = layer?.getViewController().getCurrentIndex().getValues();
    if (!position || position[frameDimension(position)] !== index) return;
    return { source_id: id, frame: index, sample: point && originalPixel(app.getImage(id), index, point) };
  };
  const firstDraw = event => {
    const at = performance.now();
    if (first) return;
    try {
      const frame = identify(event, 0, probe);
      if (frame) first = { at, ...frame };
    } catch (error) { loadError ??= error; }
  };
  const onError = event => { loadError ??= new Error(event.error?.message ?? 'DWV load error'); };
  app.addEventListener('renderend', firstDraw);
  app.addEventListener('error', onError);
  try {
    const seriesReadyAt = await new Promise((resolve, reject) => {
      const onLoadEnd = event => {
        const at = performance.now();
        if (event.dataid !== id || event.source?.[0] !== file) return;
        app.removeEventListener('loadend', onLoadEnd);
        resolve(at);
      };
      app.addEventListener('loadend', onLoadEnd);
      id = app.loadFiles([file]);
      if (id === '-1') reject(new Error('DWV did not accept the fixture'));
    });
    if (loadError) throw loadError;
    if (!first) throw new Error('DWV did not draw the selected original frame');
    const image = app.getImage(id);
    const layer = app.getViewLayersByDataId(id)[0];
    const view = layer.getViewController();
    const pixels = image.getBuffer();
    const [cols, rows] = image.getGeometry().getSize().getValues();
    const count = pixels.length / (cols * rows * image.getNumberOfComponents());
    if (count !== expectedCount) throw new Error(`DWV loaded ${count} frames, expected ${expectedCount}`);
    const present = (index, draw, point) => observeDraw(app, 'renderend', event => identify(event, index, point), draw);
    return {
      name: 'DWV', count, first, seriesReadyAt,
      seek(index, point) { return present(index, () => {
        const position = view.getCurrentIndex().getValues();
        const dim = frameDimension(position);
        if (position[dim] === index) layer.draw();
        else {
          position[dim] = index;
          if (!view.setCurrentIndex(new Index(position))) throw new Error('DWV frame index out of range');
        }
      }, point); },
      window(center, width) { return present(0, () => view.setWindowLevel(new WindowLevel(center, width))); },
      panZoom(x, y, zoom) { return present(0, () => {
        layer.setScale(new Scalar3D(zoom, zoom, 1)); layer.setOffset(new Scalar3D(x, y, 0)); layer.draw();
      }); },
      metrics() { return { decoded_buffer_bytes: pixels.byteLength }; },
      close,
    };
  } catch (error) { close(); throw error; }
  finally {
    app.removeEventListener('renderend', firstDraw);
    app.removeEventListener('error', onError);
  }
}

function frameDimension(position) { return position.length > 3 ? 3 : 2; }

function originalPixel(image, index, { row, col }) {
  const [cols, rows] = image.getGeometry().getSize().getValues();
  const pixels = image.getBuffer();
  const components = image.getNumberOfComponents();
  const start = ((index * rows + row) * cols + col) * components;
  return components === 1 ? pixels[start] : Array.from(pixels.slice(start, start + 3));
}
