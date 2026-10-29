import { CaptionCue, TimedText } from './types.js';
import { splitCaption } from '../render/remotion/captions.js';

/**
 * 대본 ↔ 음성 타이밍 맞추기.
 *
 * 받아쓰기(Whisper) 결과는 대본과 글자가 조금씩 다를 수 있다 (띄어쓰기, 숫자 표기, 오인식).
 * 그래서 자막 글자는 항상 "대본 원문"을 쓰고, 받아쓰기 결과에서는 시간만 가져온다:
 *   1) 대본과 받아쓰기를 글자(한글·영문·숫자)만 남겨 정규화
 *   2) 최장 공통 부분열(LCS)로 대본 글자 ↔ 받아쓰기 글자를 짝짓기
 *   3) 짝지어진 대본 글자는 그 시간을, 못 짝지은 글자는 앞뒤 시간 사이로 보간
 *   4) 대본을 자막 조각으로 나누고, 조각의 첫 글자 시작 ~ 다음 조각 시작을 자막 구간으로
 */

const isKeep = (c: string) => /[\p{L}\p{N}]/u.test(c);

/** 단어 단위 시간을 글자 단위로 펼친다 (단어 안에서는 글자 수로 균등 분배) */
export function wordsToChars(words: TimedText[]): TimedText[] {
  const out: TimedText[] = [];
  for (const w of words) {
    const chars = [...w.text].filter(isKeep);
    if (!chars.length) continue;
    const span = Math.max(0, w.end - w.start);
    chars.forEach((c, i) => {
      out.push({ text: c.toLowerCase(), start: w.start + (span * i) / chars.length, end: w.start + (span * (i + 1)) / chars.length });
    });
  }
  return out;
}

/** 대본의 각 글자(정규화 기준)에 시작 시간을 매긴다. 반환: 대본 원문 글자 인덱스 → 시작 시간 */
export function timeScriptChars(script: string, timed: TimedText[], totalSec: number): (number | null)[] {
  const raw = [...script];
  const keepIdx: number[] = [];
  raw.forEach((c, i) => isKeep(c) && keepIdx.push(i));
  const a = keepIdx.map((i) => raw[i].toLowerCase());
  const b = timed.filter((t) => isKeep(t.text)).map((t) => ({ ...t, text: t.text.toLowerCase() }));
  const n = a.length, m = b.length;
  const times: (number | null)[] = new Array(raw.length).fill(null);
  if (!n) return times;

  // LCS (글자 수가 수백 단위라 O(n·m) 로 충분)
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const matched: (number | null)[] = new Array(n).fill(null);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j].text) {
      matched[i] = b[j].start;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }

  // 못 짝지은 글자는 앞뒤 짝지은 글자 시간 사이로 보간 (양 끝은 0 / 전체 길이)
  const anchors: [number, number][] = [[-1, b.length ? Math.max(0, b[0].start - 0.05) : 0]];
  matched.forEach((t, k) => t !== null && anchors.push([k, t]));
  anchors.push([n, b.length ? Math.min(totalSec, b[b.length - 1].end) : totalSec]);
  for (let s = 0; s < anchors.length - 1; s++) {
    const [k0, t0] = anchors[s], [k1, t1] = anchors[s + 1];
    for (let k = k0 + 1; k < k1; k++) matched[k] = t0 + ((t1 - t0) * (k - k0)) / (k1 - k0);
  }
  keepIdx.forEach((rawI, k) => (times[rawI] = matched[k]));
  return times;
}

/** 대본 + 시간 정보 → 자막 구간 */
export function cuesFromTimings(script: string, timed: TimedText[], totalSec: number, maxCharsPerLine: number): CaptionCue[] {
  const chunks = splitCaption(script, maxCharsPerLine);
  if (!chunks.length) return [];
  const clean = script.replace(/\s+/g, ' ').trim();
  const times = timeScriptChars(clean, timed, totalSec);
  const firstTime = (from: number, len: number) => {
    for (let k = from; k < from + len; k++) if (times[k] !== null && times[k] !== undefined) return times[k]!;
    return null;
  };
  let cursor = 0;
  const starts: number[] = [];
  for (const ch of chunks) {
    const at = clean.indexOf(ch, cursor);
    const pos = at >= 0 ? at : cursor;
    starts.push(firstTime(pos, ch.length) ?? (starts.at(-1) ?? 0));
    cursor = pos + ch.length;
  }
  const endOfSpeech = timed.length ? Math.min(totalSec, timed[timed.length - 1].end + 0.3) : totalSec;
  return chunks.map((text, k) => {
    const start = Math.max(0, Math.min(starts[k], totalSec));
    const nextStart = k + 1 < chunks.length ? starts[k + 1] : Math.max(endOfSpeech, start + 0.5);
    return { text, start: round(start), end: round(Math.min(totalSec, Math.max(start + 0.3, nextStart))) };
  });
}

/** 타이밍 정보가 없을 때: 글자 수 비례 추정 (기존 방식) */
export function estimateCues(script: string, totalSec: number, maxCharsPerLine: number): CaptionCue[] {
  const chunks = splitCaption(script, maxCharsPerLine);
  const w = chunks.map((c) => Math.max(4, c.length));
  const sum = w.reduce((x, y) => x + y, 0);
  let t = 0;
  return chunks.map((text, k) => {
    const d = (w[k] / sum) * totalSec;
    const cue = { text, start: round(t), end: round(t + d) };
    t += d;
    return cue;
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;
