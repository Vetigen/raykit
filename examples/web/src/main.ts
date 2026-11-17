import { registerRaykitViewer } from '@raykit/web-component';
import { extras } from './extras';

registerRaykitViewer();
const viewer = document.querySelector('raykit-viewer')!;
const status = document.querySelector<HTMLOutputElement>('#sample-error')!;
extras(viewer);

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-fixture]')) {
  button.onclick = () => {
    status.value = '';
    const filename = button.dataset.fixture;
    void viewer.open({
      async read(signal) {
        const response = await fetch(`${import.meta.env.BASE_URL}${filename}`, { signal });
        if (!response.ok || !response.body) throw new Error('Synthetic fixture is unavailable.');
        return response.body;
      },
    }).catch(error => {
      if (error.code !== 'cancelled') status.value = 'The synthetic file could not be opened. Generate the fixtures using the repository instructions.';
    });
  };
}

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
