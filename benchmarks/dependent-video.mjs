import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { serve } from '../tests/static-server.mjs';

const directory = 'benchmarks/results/video';
const ffmpeg = process.env.RAYKIT_FFMPEG ?? 'ffmpeg';
const count = 350, width = 1260, height = 910, fps = 35, gop = 35, tolerance = 7;
const indices = [0, 175, 349];
const color = i => [32 + i % 192, 64 + (i * 3) % 128, 64 + (i * 7) % 128];
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/index.html`, '<!doctype html><meta charset="utf-8"><title>Synthetic dependent video</title>');
const encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24',
  '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0', '-c:v', 'libvpx-vp9', '-g', String(gop),
  '-keyint_min', String(gop), '-lag-in-frames', '0', '-cpu-used', '6', '-row-mt', '1',
  '-pix_fmt', 'yuv420p', '-crf', '18', '-b:v', '0', '-threads', '4', `${directory}/cine.webm`], { stdio: ['pipe', 'ignore', 'inherit'] });
const finished = once(encoder, 'close');
const row = Buffer.alloc(width * 3);
const frame = Buffer.alloc(row.length * height);
for (let i = 0; i < count; i++) {
  const rgb = color(i);
  row.fill(Buffer.from(rgb), 0, row.length / 2);
  row.fill(Buffer.from([rgb[2], rgb[0], rgb[1]]), row.length / 2);
  for (let y = 0; y < height; y++) row.copy(frame, y * row.length);
  await new Promise((resolve, reject) => encoder.stdin.write(frame, error => error ? reject(error) : resolve()));
}
encoder.stdin.end();
assert.equal((await finished)[0], 0);

const server = await serve(directory);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.RAYKIT_CHROMIUM });
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      runs.push(await page.evaluate(async ({ indices, fps }) => {
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.preload = 'auto';
        document.body.append(video);
        const response = await fetch('cine.webm');
        const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'video/webm' }));
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        try {
          const result = [];
          for (const index of indices) {
            const start = performance.now();
            const mediaTime = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(`No video frame presentation for ${index}`)), 10_000);
              const failure = () => {
                clearTimeout(timer);
                reject(new Error(`Host video decode failed (${video.error?.code})`));
              };
              video.addEventListener('error', failure, { once: true });
              const observe = (_, metadata) => {
                if (Math.abs(metadata.mediaTime - index / fps) > 0.5 / fps) { video.requestVideoFrameCallback(observe); return; }
                clearTimeout(timer); video.removeEventListener('error', failure); resolve(metadata.mediaTime);
              };
              video.requestVideoFrameCallback(observe);
              if (index === 0) video.src = url;
              else video.currentTime = (index + 0.1) / fps;
            });
            const milliseconds = performance.now() - start;
            context.drawImage(video, 0, 0, 2, 2, 0, 0, 1, 1);
            result.push({ index, mediaTime, milliseconds, sample: Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3) });
          }
          return result;
        } finally { video.remove(); URL.revokeObjectURL(url); }
      }, { indices, fps }));
    } finally { await page.close(); }
  }
  for (const run of runs) for (const entry of run) {
    assert.ok(entry.sample.every((v, i) => Math.abs(v - color(entry.index)[i]) <= tolerance));
  }
  const summary = indices.map((index, i) => {
    const sorted = runs.map(run => run[i].milliseconds).toSorted((a, b) => a - b);
    return { index, preceding_gop_frames: index % gop, median_ms: sorted[2], p95_ms: sorted.at(-1) };
  });
  const evidence = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    browser: browser.version(), encoder: execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n')[0],
    codec: 'VP9 in WebM', dimensions: [width, height], count, fps, gop, tolerance,
    bytes: (await stat(`${directory}/cine.webm`)).size, summary, runs };
  await writeFile('benchmarks/results/dependent-video.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(summary));
} finally { await browser?.close(); server.close(); }
