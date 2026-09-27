// Spike probe for the browser room image (issue #89): runs INSIDE the room.
// Launches headless Chromium, opens a page, takes a screenshot into /artifacts,
// prints timings and cgroup memory as one JSON line.
/* global process, console, performance -- node globals; this file runs in the room, outside tsc */
import { chromium } from 'playwright';
import { readFileSync, statSync } from 'node:fs';

const url = process.argv[2] ?? 'data:text/html,<h1>sar browser room</h1>';
const out = process.argv[3] ?? '/artifacts/shot.png';
const cg = f => { try { return Number(readFileSync(`/sys/fs/cgroup/${f}`, 'utf8').trim()); } catch { return null; } };
const mb = n => n == null ? null : Math.round(n / 1048576);
const t0 = performance.now();
const browser = await chromium.launch();
const tLaunch = performance.now();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
const tLoad = performance.now();
await page.screenshot({ path: out, fullPage: false });
const tShot = performance.now();
const memNow = cg('memory.current');
await browser.close();
console.log(JSON.stringify({
  url: url.slice(0, 60), uid: process.getuid(),
  launch_ms: Math.round(tLaunch - t0), goto_ms: Math.round(tLoad - tLaunch), shot_ms: Math.round(tShot - tLoad),
  total_ms: Math.round(tShot - t0), mem_current_mb: mb(memNow), mem_peak_mb: mb(cg('memory.peak')),
  png_bytes: statSync(out).size,
}));
