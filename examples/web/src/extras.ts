import { Dicomweb, LiveViewport, ProgressiveSeries, RaykitViewport, SharedView } from '@raykit/web';
import type { RaykitSession, SharedViewEvent, SliceOrientation, Slab, Triple, Volume } from '@raykit/web';
import type { RaykitViewer } from '@raykit/web-component';

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

export function extras(viewer: RaykitViewer): void {
  const volumeSection = byId('volume');
  const status = byId<HTMLOutputElement>('volume-status');
  const acquisition = byId<HTMLSelectElement>('volume-acquisition');
  const canvas = byId<HTMLCanvasElement>('mpr');
  let session: RaykitSession | undefined;
  let volume: Volume | undefined;
  let resliceScope: AbortController | undefined;
  let buildScope: AbortController | undefined;

  const refresh = () => {
    const active = viewer.viewport?.session;
    if (session !== active) {
      resliceScope?.abort(); buildScope?.abort();
      session = active; volume = undefined; acquisition.replaceChildren(); status.value = '';
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    }
    volumeSection.hidden = !active?.inspection.capabilities.volume_candidate;
  };
  viewer.addEventListener('raykit-presented', refresh);
  viewer.addEventListener('raykit-closed', refresh);

  const reslice = async () => {
    if (!volume || !session || session !== viewer.viewport?.session) return;
    const selected = byId<HTMLSelectElement>('volume-plane').value.toLowerCase();
    const { column_axis: col, row_axis: row } = volume.plane;
    const orientation = selected === 'oblique' ? { kind: 'oblique', axes: [...col, ...row] } as SliceOrientation : { kind: selected } as SliceOrientation;
    const slabMode = byId<HTMLSelectElement>('volume-slab').value;
    const slab = (slabMode === 'single' ? { kind: 'single' } : { kind: slabMode, thickness_mm: 5 }) as Slab;
    const offset = byId<HTMLInputElement>('volume-offset').valueAsNumber;
    const direction = selected === 'axial' ? [0, 0, 1] : selected === 'coronal' ? [0, 1, 0] : selected === 'sagittal' ? [1, 0, 0]
      : [col[1] * row[2] - col[2] * row[1], col[2] * row[0] - col[0] * row[2], col[0] * row[1] - col[1] * row[0]];
    const center = volume.center.map((value, i) => value + offset * direction[i]) as unknown as Triple;
    resliceScope?.abort();
    const scope = resliceScope = new AbortController();
    const size = 256;
    const spacing = Math.max(...volume.dimensions.map((d, i) => d * (i < 2 ? volume!.plane.spacing_xy[i] : Math.hypot(...volume!.slice_step_mm)))) / 200;
    const frame = viewer.viewport?.frame?.display;
    const window = frame?.voi.kind === 'window' ? frame.voi.window : frame?.automatic_window ?? { center: 200, width: 400 };
    const image = await session.reslice({ center, orientation, dimensions: [size, size], spacing_xy: [spacing, spacing], slab }, window, scope.signal);
    if (scope.signal.aborted) return;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.pixels.buffer), size, size), 0, 0);
    status.value = `${selected} · ${volume.frames.length} source slices · center ${center.map(v => v.toFixed(2)).join(', ')} mm`;
  };

  const build = async () => {
    refresh();
    if (!session) return;
    buildScope?.abort();
    const scope = buildScope = new AbortController();
    const candidate = Number(acquisition.value) || 0;
    const result = await session.volumeCandidates(scope.signal);
    acquisition.replaceChildren(...result.candidates.map((entry, index) => {
      const option = document.createElement('option');
      option.value = String(index); option.textContent = `Acquisition ${index + 1} (${entry.frames} slices)`;
      return option;
    }));
    acquisition.value = String(candidate);
    const selected = result.candidates[candidate];
    if (!selected?.available) { status.value = selected?.limitation?.detail ?? 'Volume geometry unavailable.'; return; }
    const built = await session.buildVolume(candidate, result.revision, scope.signal);
    if (scope.signal.aborted) return;
    volume = built;
    await reslice();
  };
  const report = (error: unknown) => {
    if (error instanceof Error && error.message !== 'cancelled') byId<HTMLOutputElement>('sample-error').value = error.message;
  };
  byId('build-volume').onclick = () => void build().catch(report);
  acquisition.onchange = () => void build().catch(report);
  for (const id of ['volume-plane', 'volume-slab', 'volume-offset']) byId(id).oninput = () => void reslice().catch(report);

  byId('read-seg').onclick = () => void (async () => {
    const scope = viewer.viewport?.session;
    const index = viewer.viewport?.presented?.source.frame;
    if (!scope || index === undefined) return;
    const segment = await scope.segmentation(await fixture('phantom-seg.dcm'), index, 1);
    if (scope === viewer.viewport?.session) viewer.setSegmentation(segment);
  })().catch(report);
  byId('read-pr').onclick = () => void (async () => {
    const viewport = viewer.viewport;
    const scope = viewport?.session;
    const index = viewport?.presented?.source.frame;
    if (!viewport || !scope || index === undefined) return;
    const state = await scope.presentation(await fixture('phantom-gsps.dcm'), index);
    if (scope !== viewport.session || viewport.presented?.source.frame !== index) return;
    await viewport.showFrame(index, false, { view: { ...viewport.view, quarter_turns: state.quarter_turns },
      render: { window: state.window, invert: state.inverse !== viewport.frame?.display?.inverse } });
  })().catch(report);

  byId('open-dicomweb').onclick = () => void (async () => {
    const dicom = new Dicomweb(new URL(`${import.meta.env.BASE_URL}dicomweb/`, location.href));
    const [first, ...later] = await dicom.listInstances('2.25.100', '2.25.901');
    if (!first) return;
    const dataset = new ProgressiveSeries();
    const member = (instance: typeof first) => ({ instanceUid: instance.instanceUid, revision: 'synthetic-1',
      source: dicom.instance(instance.studyUid, instance.seriesUid, instance.instanceUid) });
    const initial = member(first);
    dataset.append({ sequence: 1, manifestRevision: 'synthetic-1', expected: later.length + 1, members: [initial] });
    await viewer.open(initial.source, { revision: initial.revision });
    const opened = viewer.viewport?.session;
    if (!opened) return;
    for (const [index, item] of later.entries()) {
      const additional = member(item);
      dataset.append({ sequence: index + 2, manifestRevision: 'synthetic-1', members: [additional] });
      await opened.addVolumeSource(additional.source);
      if (opened !== viewer.viewport?.session) return;
      status.value = `${dataset.progress.available}/${dataset.progress.expected} original instances available.`;
    }
  })().catch(report);

  const shared = byId('shared');
  let second: RaykitViewport | undefined;
  let peers: SharedView[] = [];
  byId('share-view').onclick = () => void (async () => {
    for (const peer of peers) peer.close();
    second?.dispose();
    const file = await fixture('signed12.dcm');
    await viewer.open(file, { revision: 'synthetic-1' });
    const primary = viewer.viewport!;
    shared.style.cssText = 'position:relative;height:16rem;margin-top:.75rem;background:#020307'; shared.hidden = false;
    second = new RaykitViewport(shared);
    second.addEventListener('presented', event => {
      shared.dataset.rotation = String((event as CustomEvent).detail.view.quarter_turns);
    });
    await second.load(file, { revision: 'synthetic-1' });
    const allowed = async (event: SharedViewEvent) => event.revision === 'synthetic-1' && event.source.instance_uid === '2.25.101';
    const left = new SharedView(primary, 'left', allowed);
    const right = new SharedView(second, 'right', allowed);
    peers = [left, right];
    left.addEventListener('view', event => void right.apply((event as CustomEvent<SharedViewEvent>).detail).catch(report));
    right.addEventListener('view', event => void left.apply((event as CustomEvent<SharedViewEvent>).detail).catch(report));
    primary.addEventListener('closed', () => { for (const peer of peers) peer.close(); second?.dispose(); shared.hidden = true; }, { once: true });
  })().catch(report);

  const liveCanvas = byId<HTMLCanvasElement>('live-canvas');
  const liveStatus = byId<HTMLOutputElement>('live-status');
  const live = new LiveViewport(liveCanvas);
  const button = byId<HTMLButtonElement>('live');
  live.addEventListener('presented', event => {
    const detail = (event as CustomEvent).detail;
    liveStatus.value = `Preview frame ${detail.frame + 1} · measurement unavailable · ${detail.dropped} skipped`;
  });
  button.onclick = () => {
    if (!liveCanvas.hidden) { live.close(); liveCanvas.hidden = true; liveStatus.value = ''; button.textContent = 'Start synthetic live stream'; return; }
    liveCanvas.hidden = false; button.textContent = 'Stop synthetic live stream';
    void live.start({ id: 'synthetic-live', revision: '1', async *frames(signal) {
      for (let frame = 0; !signal.aborted; frame++) {
        const pixels = new ImageData(160, 96);
        for (let i = 0; i < pixels.data.length; i += 4) {
          const x = (i / 4) % pixels.width;
          const v = Math.abs(((x + frame * 4) % 200) - 100) * 2;
          pixels.data.set([v / 4, v, v, 255], i);
        }
        yield { id: frame, timestampMs: performance.now(), pixels };
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    } }).catch(report);
  };
  window.addEventListener('pagehide', () => { live.close(); for (const peer of peers) peer.close(); second?.dispose(); });
}

async function fixture(file: string): Promise<Blob> {
  const response = await fetch(`${import.meta.env.BASE_URL}${file}`);
  if (!response.ok) throw new Error('Synthetic fixture is unavailable.');
  return response.blob();
}
