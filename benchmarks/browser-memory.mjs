import { readFile } from 'node:fs/promises';

export async function browserMemory(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const readings = await Promise.all(processInfo.map(async process => {
    if (!['renderer', 'GPU', 'browser'].includes(process.type)) return null;
    const text = await readFile('/proc/' + process.id + '/status', 'utf8').catch(() => '');
    const rss = /^VmRSS:\s+(\d+)/m.exec(text);
    return rss ? [process.type, Number(rss[1]) * 1024] : null;
  }));
  const totals = {};
  for (const reading of readings) if (reading) totals[reading[0]] = (totals[reading[0]] ?? 0) + reading[1];
  return totals;
}
