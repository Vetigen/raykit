import { frameProofHttp, open, openTiled, TiledViewport } from '@raykit/web';
import type { FrameProof, PixelPoint } from '@raykit/web';
import type { RaykitViewer } from '@raykit/web-component';

export function delivery(viewer: RaykitViewer): void {
  const field = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const status = field<HTMLOutputElement>('sample-error');
  const base = new URL(import.meta.env.BASE_URL, location.href);
  const blob = async (name: string, signal?: AbortSignal) => {
    const response = await fetch(new URL(name, base), { signal });
    if (!response.ok) throw new Error('Generate the synthetic fixtures first.');
    return response.blob();
  };
  const pins = async () => {
    const response = await fetch(new URL('delivery/pins.json', base));
    if (!response.ok) throw new Error('Run npm run fixtures:delivery first.');
    return response.json() as Promise<{
      proof: { index: Omit<FrameProof, 'bytes'> };
      tiles: { manifest: { sha256: string; revision: string } };
    }>;
  };
  const run = (work: Promise<unknown>) => {
    status.value = '';
    void work.catch(error => { if (error.code !== 'cancelled') status.value = error.message; });
  };

  field('open-proof').onclick = () => run((async () => {
    const { proof: { index } } = await pins();
    await viewer.open(frameProofHttp(new URL('delivery/proof/', base), {
      rootSha256: index.root_sha256, revision: index.revision,
    }), { expected_sha256: index.source.content_sha256 });
  })());

  field('open-mr-pair').onclick = () => run((async () => {
    while (viewer.viewports.length > 1) {
      const last = viewer.viewports.at(-1)!;
      last.surface.focus();
      (viewer.shadowRoot?.querySelector('[data-action=close]') as HTMLButtonElement).click();
    }
    const [t1, t2] = await Promise.all([blob('comparison-mr-t1.dcm'), blob('comparison-mr-t2.dcm')]);
    await viewer.open(t1);
    const left = viewer.viewport!;
    const right = await viewer.openPanel(t2);
    const a = left.presented!, b = right.presented!;
    viewer.registerPair(left, right, {
      left: { sha256: a.source.content_sha256, revision: a.revision },
      right: { sha256: b.source.content_sha256, revision: b.revision },
      frameOfReference: a.source.frame_of_reference_uid!,
    });
  })());

  let workerScope: AbortController | undefined;
  field('custom-worker').onclick = () => run((async () => {
    workerScope?.abort();
    const { signal } = workerScope = new AbortController();
    const source = await open(await blob('signed12.dcm', signal), {
      signal, workerFactory: () => new Worker(new URL('./custom-worker.ts', import.meta.url), { type: 'module' }),
    });
    try {
      const [preview, sample, length] = await Promise.all([
        source.readFrame(0, { output: 'rgba', signal }),
        source.sampleAt(0, 10, 10, signal),
        source.measure(0, { id: 'worker-ruler', method: 'raykit:length', version: 1,
          points: [{ x: 3, y: 5 }, { x: 9, y: 21 }] }, signal),
      ]);
      if (sample.sample.kind !== 'monochrome') throw new Error('Expected a monochrome sample.');
      status.value = source.inspection.instance_uid + ' · ' + preview.pixels.byteLength
        + ' preview bytes · stored ' + sample.sample.stored + ' · ' + length.values[0].value + ' mm';
    } finally { source.close(); }
  })());

  let tiled: TiledViewport | undefined;
  const canvas = field<HTMLCanvasElement>('tiled-canvas');
  const output = field<HTMLOutputElement>('tiled-status');
  let center: PixelPoint = { x: 0, y: 0 };
  let zoom = 1;
  let drag: { x: number; y: number; moved: boolean } | undefined;
  field('open-tiles').onclick = () => run((async () => {
    const { tiles: { manifest } } = await pins();
    tiled?.close();
    const source = await openTiled({ baseUrl: new URL('delivery/tiles/', base).href, manifestSha256: manifest.sha256, revision: manifest.revision });
    field('tiled-section').hidden = false;
    center = { x: (source.inspection.format.columns - 1) / 2, y: (source.inspection.format.rows - 1) / 2 };
    zoom = 1;
    tiled = new TiledViewport(canvas, source);
    await tiled.draw().catch(error => { if (error.code !== 'cancelled') throw error; });
    output.value = 'Original resolution · drag to pan, scroll to zoom, click to sample.';
  })());
  canvas.onpointerdown = event => {
    drag = { x: event.clientX, y: event.clientY, moved: false };
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = event => {
    if (!drag || !tiled) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY, moved: drag.moved || Math.hypot(dx, dy) > 2 };
    if (drag.moved) {
      center = { x: center.x - dx / zoom, y: center.y - dy / zoom };
      run(tiled.setView(center, zoom));
    }
  };
  canvas.onpointerup = event => {
    if (tiled && drag && !drag.moved) {
      const rect = canvas.getBoundingClientRect();
      run(tiled.sample({ x: event.clientX - rect.left, y: event.clientY - rect.top }).then(({ pixel, sample }) => {
        if (sample.kind === 'monochrome') output.value = 'Pixel ' + Math.round(pixel.x) + ', ' + Math.round(pixel.y)
          + ' · stored ' + sample.stored + ' · modality ' + sample.modality;
      }));
    }
    drag = undefined;
  };
  canvas.onpointercancel = () => { drag = undefined; };
  canvas.onwheel = event => {
    if (!tiled) return;
    event.preventDefault();
    zoom = Math.min(16, Math.max(1, zoom * Math.exp(-event.deltaY / 240)));
    run(tiled.setView(center, zoom));
  };
  window.addEventListener('pagehide', () => { tiled?.close(); workerScope?.abort(); });
}
