import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireTool } from '../core/tools.js';
import { OcrLine, OcrProvider, ScreenTextSegment } from './types.js';

/** 글자 인식 결과에서 버리는 것: 확신도 낮음, 글자 1개 이하 (화면 잡음) */
const MIN_CONF = 0.3;
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** 두 문구가 얼마나 같은지 (0~1). 프레임마다 글자 인식이 한두 글자씩 흔들리는 것을 같은 문구로 본다 */
export function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const dp = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return (2 * dp[b.length]) / (a.length + b.length);
}

/**
 * 프레임별 글자 → "몇 초~몇 초에 이 문구".
 * 두 프레임(0.5초 간격이면 약 1초) 이상 보인 문구만 남긴다.
 * 같은(비슷한) 문구가 이어지는 프레임은 하나로 합친다. 한 프레임 놓쳐도(인식 흔들림) 이어진 것으로 본다.
 * 문구 글자는 가장 많이 읽힌 형태를 쓴다.
 */
export function mergeFrames(frames: OcrLine[][], intervalSec: number, durationSec: number, minSim = 0.8): ScreenTextSegment[] {
  type Open = { key: string; variants: Map<string, number>; start: number; last: number; y: number; size: number; seen: number };
  const open: Open[] = [];
  const done: ScreenTextSegment[] = [];
  const close = (o: Open) => {
    // 한 프레임에만 보인 문구는 버린다: 제품 포장 글자가 프레임마다 다르게 읽히는 잡음이 대부분 (원본 프레임 결과는 따로 보관)
    if (o.seen < 2) return;
    const text = [...o.variants.entries()].sort((a, b) => b[1] - a[1])[0][0];
    done.push({ text, start: round(o.start), end: round(Math.min(durationSec, o.last + intervalSec)), y: round(o.y), size: Math.round(o.size * 1000) / 1000 });
  };
  frames.forEach((lines, k) => {
    const t = k * intervalSec;
    const used = new Set<Open>();
    for (const l of lines) {
      const key = norm(l.text);
      if (l.conf < MIN_CONF || key.length < 2) continue;
      let best: Open | undefined;
      let bestSim = minSim;
      for (const o of open) {
        if (used.has(o)) continue;
        const s = similarity(key, o.key);
        if (s >= bestSim) [best, bestSim] = [o, s];
      }
      if (!best) {
        best = { key, variants: new Map(), start: t, last: t, y: l.y, size: l.h, seen: 0 };
        open.push(best);
      }
      best.last = t;
      best.seen++;
      best.size = Math.max(best.size, l.h);
      best.variants.set(l.text.trim(), (best.variants.get(l.text.trim()) ?? 0) + 1);
      used.add(best);
    }
    // 두 프레임 연속으로 안 보이면 끝난 문구
    for (let i = open.length - 1; i >= 0; i--)
      if (t - open[i].last > intervalSec * 1.5) {
        close(open[i]);
        open.splice(i, 1);
      }
  });
  open.forEach(close);
  return done.sort((a, b) => a.start - b.start || a.y - b.y);
}

const round = (n: number) => Math.round(n * 100) / 100;

/** 위에서 아래 순서로 한 줄씩 */
export const linesToText = (lines: OcrLine[]) =>
  [...lines].filter((l) => l.conf >= MIN_CONF && norm(l.text).length >= 1).sort((a, b) => a.y - b.y || a.x - b.x).map((l) => l.text.trim()).join('\n');

export async function readImageText(ocr: OcrProvider, file: string) {
  const [lines] = await ocr.readImages([file]);
  return { provider: ocr.id, text: linesToText(lines), lines };
}

/** 영상: intervalSec마다 화면을 읽어 문구 구간으로 합친다 */
export async function readVideoText(ocr: OcrProvider, file: string, durationSec: number, intervalSec = 0.5) {
  requireTool('ffmpeg');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-ocr-'));
  try {
    // fps 필터: k번째 프레임 = k × intervalSec 초 지점
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', file, '-vf', `fps=${1 / intervalSec}`, '-q:v', '2', path.join(tmp, 'f%05d.jpg')]);
    const frames = fs.readdirSync(tmp).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(tmp, f));
    const lines = await ocr.readImages(frames);
    return {
      provider: ocr.id,
      intervalSec,
      frames: frames.length,
      segments: mergeFrames(lines, intervalSec, durationSec),
      // 프레임별 원본 결과 (구간 합치기 규칙을 바꿔도 다시 읽지 않고 다시 계산할 수 있게)
      frameLines: lines.map((ls, k) => ({ t: k * intervalSec, lines: ls })),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
