import { Dicomweb, LiveSeries, LiveViewport, ProgressiveSeries, RaykitViewport, SharedView } from '@raykit/web';
import type { RaykitSession, SharedViewEvent, SliceOrientation, Slab, Triple, Volume } from '@raykit/web';
import type { RaykitViewer } from '@raykit/web-component';

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

export function extras(viewer: RaykitViewer): void {
  const volumeSection = byId('volume');
  const status = byId<HTMLOutputElement>('volume-status');
  const acquisition = byId<HTMLSelectElement>('volume-acquisition');
  const canvas = byId<HTMLCanvasElement>('mpr');
  const windowCenter = byId<HTMLInputElement>('volume-center');
  const windowWidth = byId<HTMLInputElement>('volume-width');
  const offsetInput = byId<HTMLInputElement>('volume-offset');
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
    const cross = (a: readonly number[], b: readonly number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const normal = cross(col, row);
    const tilted: Triple = [(row[0] + normal[0]) * Math.SQRT1_2, (row[1] + normal[1]) * Math.SQRT1_2,
      (row[2] + normal[2]) * Math.SQRT1_2];
    const orientation: SliceOrientation = selected === 'source' ? { kind: 'oblique', axes: [...col, ...row] }
      : selected === 'oblique' ? { kind: 'oblique', axes: [...col, ...tilted] }
      : { kind: selected as 'axial' | 'coronal' | 'sagittal' };
    const slabMode = byId<HTMLSelectElement>('volume-slab').value;
    const thickness = byId<HTMLInputElement>('volume-thickness').valueAsNumber;
    if (slabMode !== 'single' && !(thickness > 0 && thickness <= 500)) return;
    const slab = (slabMode === 'single' ? { kind: 'single' } : { kind: slabMode, thickness_mm: thickness }) as Slab;
    const offset = offsetInput.valueAsNumber;
    const direction = selected === 'axial' ? [0, 0, 1] : selected === 'coronal' ? [0, 1, 0] : selected === 'sagittal' ? [1, 0, 0]
      : selected === 'source' ? normal : cross(col, tilted);
    const center = volume.center.map((value, i) => value + offset * direction[i]) as unknown as Triple;
    resliceScope?.abort();
    const scope = resliceScope = new AbortController();
    const size = 256;
    const spacing = Math.max(...volume.dimensions.map((d, i) => d * (i < 2 ? volume!.plane.spacing_xy[i] : Math.hypot(...volume!.slice_step_mm)))) / 200;
    const window = { center: windowCenter.valueAsNumber, width: windowWidth.valueAsNumber, function: 'linear' } as const;
    if (!Number.isFinite(window.center) || !(window.width >= 1)) return;
    const palette = byId<HTMLSelectElement>('volume-palette').value === 'hot' ? 'hot' : 'gray';
    const sampling = byId<HTMLSelectElement>('volume-sampling').value === 'nearest' ? 'nearest' : 'trilinear';
    const dimensions = selected === 'source' ? [volume.dimensions[0], volume.dimensions[1]] as const : [size, size] as const;
    const spacing_xy = selected === 'source' ? volume.plane.spacing_xy : [spacing, spacing] as const;
    const image = await session.reslice({ center, orientation, dimensions, spacing_xy, slab }, window, scope.signal, { palette, sampling });
    if (scope.signal.aborted || session !== viewer.viewport?.session) return;
    canvas.width = dimensions[0]; canvas.height = dimensions[1];
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.pixels.buffer), ...dimensions), 0, 0);
    status.value = `${selected} · ${slabMode} · ${volume.frames.length} source slices · center ${center.map(v => v.toFixed(2)).join(', ')} mm`;
  };

  const build = async () => {
    refresh();
    if (!session) return;
    buildScope?.abort();
    resliceScope?.abort();
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
    const display = viewer.viewport?.frame?.display;
    const window = display?.voi.kind === 'window' ? display.voi.window : display?.automatic_window;
    if (window) { windowCenter.valueAsNumber = window.center; windowWidth.valueAsNumber = Math.max(1, window.width); }
    const span = Math.max(6, Math.ceil(Math.hypot(...built.slice_step_mm) * (built.dimensions[2] - 1) / 2));
    offsetInput.min = String(-span); offsetInput.max = String(span); offsetInput.value = '0';
    await reslice();
  };
  const report = (error: unknown) => {
    if (error instanceof Error && error.message !== 'cancelled') byId<HTMLOutputElement>('sample-error').value = error.message;
  };
  byId('build-volume').onclick = () => void build().catch(report);
  acquisition.onchange = () => void build().catch(report);
  for (const id of ['volume-plane', 'volume-slab', 'volume-thickness', 'volume-sampling', 'volume-offset', 'volume-center', 'volume-width', 'volume-palette']) {
    byId(id).oninput = () => void reslice().catch(report);
  }

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

  const preview = byId('series-preview');
  let seriesScope: AbortController | undefined;
  byId('open-dicomweb').onclick = () => void (async () => {
    seriesScope?.abort();
    const scope = seriesScope = new AbortController();
    const revision = 'synthetic-1';
    const dicom = new Dicomweb(new URL(`${import.meta.env.BASE_URL}dicomweb/`, location.href));
    const [[first, ...later], manifest, thumbnail] = await Promise.all([
      dicom.listInstances('2.25.100', '2.25.901', { signal: scope.signal }),
      fetch(`${import.meta.env.BASE_URL}manifest.json`, { signal: scope.signal }).then(response => response.json() as Promise<Record<string, { sha256: string; bytes: number }>>),
      fixture('classic-ct-preview.jpg', scope.signal),
    ]);
    if (!first) return;
    const dataset = new ProgressiveSeries(revision);
    const member = (instance: typeof first) => {
      const index = Number(instance.instanceUid.slice(-3)) - 911;
      const expected = manifest[`classic-ct-${index}.dcm`];
      if (!expected) throw new Error('Synthetic series member is missing from the manifest.');
      return { instanceUid: instance.instanceUid, revision,
        sha256: expected.sha256, byteLength: expected.bytes,
        source: dicom.instance(instance.studyUid, instance.seriesUid, instance.instanceUid) };
    };
    const initial = { ...member(first), preview: thumbnail };
    dataset.append({ sequence: 1, manifestRevision: revision, expected: later.length + 1, members: [initial] });
    const url = URL.createObjectURL(dataset.preview(initial)!.document);
    const image = preview.querySelector('img')!;
    image.src = url; preview.hidden = false;
    try {
      await viewer.open(initial.source, { revision, expected_sha256: initial.sha256, expected_size: initial.byteLength, signal: scope.signal });
      const opened = viewer.viewport?.session;
      if (!opened || opened.revision !== revision || opened.inspection.content_sha256 !== initial.sha256) return;
      image.removeAttribute('src'); preview.hidden = true;
      status.value = `${dataset.progress.available}/${dataset.progress.expected} original instances available.`;
      for (const [index, item] of later.entries()) {
        const additional = member(item);
        await opened.addVolumeSource(additional.source, {
          expected_sha256: additional.sha256, expected_size: additional.byteLength, signal: scope.signal,
        });
        if (opened !== viewer.viewport?.session) return;
        dataset.append({ sequence: index + 2, manifestRevision: revision, members: [additional] });
        status.value = `${dataset.progress.available}/${dataset.progress.expected} original instances available.`;
      }
    } finally {
      URL.revokeObjectURL(url);
      if (seriesScope === scope) { image.removeAttribute('src'); preview.hidden = true; }
    }
  })().catch(error => { if (!(error instanceof DOMException && error.name === 'AbortError')) report(error); });

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
  const original = new RaykitViewport(byId('live-original'));
  const button = byId<HTMLButtonElement>('live');
  const freeze = byId<HTMLButtonElement>('freeze-preview');
  const disconnect = byId<HTMLButtonElement>('disconnect-preview');
  const bind = byId<HTMLButtonElement>('bind-preview');
  let sequence = 0;
  let bindingPreview = false;
  const updateLive = () => {
    const state = live.status;
    byId('live-original').hidden = !state.original && !bindingPreview;
    freeze.disabled = !live.presented;
    disconnect.disabled = liveCanvas.hidden;
    bind.disabled = !live.frozen;
    disconnect.textContent = state.connection === 'streaming' ? 'Disconnect' : 'Reconnect';
    freeze.textContent = state.frozen ? 'Return to live' : 'Freeze';
    const quality = state.original ? 'Verified original' : state.frozen ? 'Frozen preview' : 'Live preview';
    liveStatus.value = liveCanvas.hidden ? '' : `${quality} · ${state.connection} · ${state.unseen} new · ${state.dropped} skipped`
      + (state.lastImageAgeMs === undefined ? '' : ` · ${Math.round(state.lastImageAgeMs)} ms old`);
  };
  live.addEventListener('presented', updateLive);
  live.addEventListener('state', updateLive);
  const timer = setInterval(() => { if (!liveCanvas.hidden && live.status.connection !== 'streaming') updateLive(); }, 1000);
  const connect = () => {
    void live.start({ id: 'synthetic-live', revision: '1', async *frames(signal) {
      while (!signal.aborted) {
        const frame = sequence++;
        const pixels = new ImageData(8, 6);
        const capture = frame % 3 === 0 ? { acquisition: 'synthetic-us-1', frame: '0' } : undefined;
        for (let i = 0; i < pixels.data.length; i += 4) {
          pixels.data.set([capture ? 12 : (i + frame) % 255, 34, 56, 255], i);
        }
        yield { id: frame, timestampMs: performance.now(), pixels, capture };
        await new Promise(resolve => setTimeout(resolve, 70));
      }
    } }).catch(report);
  };
  button.onclick = () => {
    if (!liveCanvas.hidden) {
      liveCanvas.hidden = true; live.close(); button.textContent = 'Start synthetic live stream'; return;
    }
    liveCanvas.hidden = false; button.textContent = 'Stop synthetic live stream'; connect();
  };
  freeze.onclick = () => { if (live.frozen) live.goLive(); else live.freeze(); };
  disconnect.onclick = () => { if (live.status.connection === 'streaming') live.disconnect(); else connect(); };
  bind.onclick = () => void (async () => {
    // The bundled source uses the synthetic acquisition ID above and exact original bytes.
    const file = 'us-rgb-planar.dcm';
    const expected = await fetch(`${import.meta.env.BASE_URL}manifest.json`).then(r => r.json());
    bindingPreview = true;
    updateLive();
    try {
      await live.bindOriginal(original, async (_frame, signal) => ({
        capture: { acquisition: 'synthetic-us-1', frame: '0' }, source: await fixture(file, signal),
        sha256: expected[file].sha256, instanceUid: '2.25.840', dicomFrame: 0,
      }));
    } finally { bindingPreview = false; updateLive(); }
    const record = await original.session!.measure(0, { id: 'verified-live-length', method: 'raykit:length', version: 1,
      points: [{ x: 0, y: 0 }, { x: 3, y: 0 }], parameters: { require_mm: true } });
    liveStatus.value += ` · ruler ${record.values[0].value} mm`;
  })().catch(error => { updateLive(); liveStatus.value += ' · ' + error.message; });

  let following: LiveSeries | undefined;
  let acquisitionTimers: ReturnType<typeof setTimeout>[] = [];
  const seriesSurface = new RaykitViewport(byId('series-surface'));
  const seriesStatus = byId<HTMLOutputElement>('live-series-status');
  const freezeSeries = byId<HTMLButtonElement>('freeze-series'), disconnectSeries = byId<HTMLButtonElement>('disconnect-series');
  const picker = byId<HTMLSelectElement>('series-member');
  byId('live-series').onclick = () => void (async () => {
    following?.close();
    for (const timer of acquisitionTimers) clearTimeout(timer);
    acquisitionTimers = [];
    const manifest = await fetch(`${import.meta.env.BASE_URL}manifest.json`).then(r => r.json());
    byId('series-live-section').hidden = false;
    const dataset = new ProgressiveSeries('demo-series');
    const controller = following = new LiveSeries(dataset, seriesSurface);
    controller.addEventListener('state', () => {
      const state = controller.status;
      seriesStatus.value = `${state.connected ? state.following ? 'Following acquisitions' : 'Frozen original' : 'Disconnected'} · ${state.unseen} new`
        + (state.lastImageAgeMs === undefined ? '' : ` · ${Math.round(state.lastImageAgeMs)} ms old`);
      freezeSeries.textContent = state.following ? 'Freeze' : 'Return to live';
      disconnectSeries.textContent = state.connected ? 'Disconnect' : 'Reconnect';
      picker.replaceChildren(new Option('Follow latest', ''), ...dataset.members.map((_, i) => new Option('Acquisition ' + (i + 1), String(i))));
    });
    freezeSeries.onclick = () => { if (controller.status.following) controller.freeze(); else controller.goLive(); };
    disconnectSeries.onclick = () => { if (controller.status.connected) controller.disconnect(); else controller.reconnect(); };
    picker.onchange = () => {
      if (picker.value === '') controller.goLive();
      else void controller.show(dataset.members[Number(picker.value)]).catch(report);
    };
    for (const [arrival, index] of [0, 2, 1].entries()) {
      acquisitionTimers.push(setTimeout(() => {
        if (following !== controller) return;
        const file = `classic-ct-${index}.dcm`;
        dataset.append({ sequence: index, manifestRevision: 'demo-series', expected: 3, members: [{
          instanceUid: '2.25.' + (911 + index), revision: 'demo-series', acquisitionTimeMs: index,
          sha256: manifest[file].sha256, byteLength: manifest[file].bytes,
          source: { read: signal => fixture(file, signal) },
        }] });
      }, 30 + arrival * 850));
    }
  })().catch(report);
  window.addEventListener('pagehide', () => {
    seriesScope?.abort(); live.close(); original.dispose(); following?.close(); seriesSurface.dispose();
    clearInterval(timer); for (const timer of acquisitionTimers) clearTimeout(timer);
    for (const peer of peers) peer.close(); second?.dispose();
  });
}

async function fixture(file: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${import.meta.env.BASE_URL}${file}`, { signal });
  if (!response.ok) throw new Error('Synthetic fixture is unavailable.');
  return response.blob();
}
