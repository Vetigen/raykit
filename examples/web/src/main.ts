import { registerRaykitViewer } from '@raykit/web-component';
import { indexedBlob, open } from '@raykit/web';
import { extras } from './extras';
import { delivery } from './delivery';

registerRaykitViewer();
const viewer = document.querySelector('raykit-viewer')!;
const status = document.querySelector<HTMLOutputElement>('#sample-error')!;
extras(viewer);
delivery(viewer);
let opening: AbortController | undefined;

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-fixture]')) {
  button.onclick = () => {
    opening?.abort();
    const scope = opening = new AbortController();
    status.value = '';
    const filename = button.dataset.fixture;
    void viewer.open({
      async read(signal) {
        const response = await fetch(`${import.meta.env.BASE_URL}${filename}`, { signal });
        if (!response.ok || !response.body) throw new Error('Synthetic fixture is unavailable.');
        return response.body;
      },
    }, { signal: scope.signal }).catch(error => {
      if (error.code !== 'cancelled') status.value = 'The synthetic file could not be opened. Generate the fixtures using the repository instructions.';
    });
  };
}

document.querySelector<HTMLButtonElement>('#open-indexed')!.onclick = () => {
  opening?.abort();
  const scope = opening = new AbortController();
  const { signal } = scope;
  status.value = 'Verifying ultrasound and preparing frame index…';
  void (async () => {
    const base = import.meta.env.BASE_URL;
    const [source, manifest] = await Promise.all([
      fetch(`${base}cine-350.dcm`, { signal }).then(r => r.blob()),
      fetch(`${base}manifest.json`, { signal }).then(r => r.json()),
    ]);
    const expected = manifest['cine-350.dcm'];
    const options = { expected_sha256: expected.sha256, expected_size: expected.bytes, signal };
    const full = await open(source, options);
    try {
      const index = await full.createFrameIndex(signal);
      await viewer.open(indexedBlob(source, index), options);
    } finally { full.close(); }
    if (!signal.aborted) status.value = '';
  })().catch(error => { if (!signal.aborted) status.value = error.message; });
};

viewer.addEventListener('raykit-document', event => {
  const { session } = (event as CustomEvent).detail;
  void session.document().then((pdf: Blob) => {
    const url = URL.createObjectURL(pdf);
    const link = document.createElement('a');
    link.href = url; link.download = 'document.pdf'; link.textContent = 'Download encapsulated PDF';
    status.replaceChildren(link);
    link.onclick = () => setTimeout(() => URL.revokeObjectURL(url), 1000);
    viewer.viewport?.addEventListener('closed', () => URL.revokeObjectURL(url), { once: true });
  }, () => { status.value = 'The encapsulated PDF could not be read.'; });
});
