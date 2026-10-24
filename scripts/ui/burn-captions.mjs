// Burn VO captions into janis-pitch.mp4 using Playwright-rendered PNGs.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OUT = '/tmp/janis-pitch-out';
const ass = readFileSync(`${OUT}/vo.ass`, 'utf8');
const caps = [];
for (const line of ass.split('\n')) {
  const m = /^Dialogue: 0,(\d+):(\d+):([\d.]+),(\d+):(\d+):([\d.]+),VO,(.+)$/.exec(line);
  if (!m) continue;
  const t = (h, mm, s) => +h * 3600 + +mm * 60 + +s;
  caps.push({ start: t(m[1], m[2], m[3]), end: t(m[4], m[5], m[6]), text: m[7].replace(/\\N/g, '\n') });
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const paths = [];
for (let i = 0; i < caps.length; i++) {
  await page.setContent(`<body style="margin:0"><div style="position:absolute;left:50%;bottom:44px;transform:translateX(-50%);max-width:1080px;text-align:center;font:600 27px/1.35 -apple-system,'Helvetica Neue',Arial,sans-serif;color:#fff;background:rgba(10,12,16,.66);padding:12px 26px;border-radius:12px;white-space:pre-line">${caps[i].text}</div></body>`);
  const p = `${OUT}/cap-${i}.png`;
  await page.screenshot({ path: p, omitBackground: true });
  paths.push(p);
}
await browser.close();
const inputs = ['-i', `${OUT}/janis-pitch.mp4`, ...paths.flatMap((p) => ['-i', p])];
let chain = '[0:v]';
caps.forEach((c, i) => { chain += `[${i + 1}:v]overlay=enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'${i === caps.length - 1 ? '' : '[tmp' + i + '];[tmp' + i + ']'}`; });
execSync(`ffmpeg -y ${inputs.join(' ')} -filter_complex "${chain}" -c:v libx264 -preset fast -crf 20 ${OUT}/janis-pitch-readalong.mp4`, { stdio: 'inherit' });
console.log('done');
