import { App, AppOptions, Index, Scalar3D, WindowLevel } from 'dwv';

export async function create(host, file, expectedCount) {
  const app = new App();
  app.init(new AppOptions({ '*': [{ divId: host.id }] }));
  let loadError;
  let readyTime;
  const started = performance.now();
  const finished = new Promise(resolve => {
    app.addEventListener('renderend', () => { readyTime ??= performance.now() - started; });
    app.addEventListener('error', event => { loadError = event.error?.message ?? 'DWV load error'; });
    app.addEventListener('loadend', resolve);
  });
  const id = app.loadFiles([file]);
  await finished;
  const image = app.getImage(id);
  const layers = app.getViewLayersByDataId(id);
  if (loadError || !image || !layers.length) { app.reset(); throw new Error(loadError || 'DWV did not render'); }
  const layer = layers[0];
  const view = layer.getViewController();
  const pixels = image.getBuffer();
  const [cols, rows] = image.getGeometry().getSize().getValues();
  const components = image.getNumberOfComponents();
  const count = pixels.length / (cols * rows * components);
  return {
    name: 'DWV', count, readyTime,
    async seek(index) {
      const position = view.getCurrentIndex().getValues();
      const dim = position.length > 3 ? 3 : 2;
      position[dim] = index;
      view.setCurrentIndex(new Index(position));
      if (expectedCount > 1 && view.getCurrentIndex().getValues()[dim] !== index) throw new Error('DWV frame index did not change');
      await new Promise(requestAnimationFrame);
    },
    sample(index, row, col) {
      const start = ((index * rows + row) * cols + col) * components;
      return components === 1 ? pixels[start] : Array.from(pixels.slice(start, start + 3));
    },
    async window(center, width) { view.setWindowLevel(new WindowLevel(center, width)); await new Promise(requestAnimationFrame); },
    async panZoom(x, y, zoom) { layer.setScale(new Scalar3D(zoom, zoom, 1)); layer.setOffset(new Scalar3D(x, y, 0)); layer.draw(); await new Promise(requestAnimationFrame); },
    metrics() { return { decoded_buffer_bytes: pixels.byteLength }; },
    close() { app.reset(); host.replaceChildren(); },
  };
}
