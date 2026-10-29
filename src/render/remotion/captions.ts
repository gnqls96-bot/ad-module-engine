/**
 * 모듈 대사를 자막 조각으로 나누고, 글자 수에 비례해 구간 길이를 배분한다.
 * (실제 음성 타이밍 맞추기는 받아쓰기 단계가 붙으면 단어 타임스탬프로 바꾼다)
 */
export interface CaptionChunk {
  text: string;
  from: number;
  durationInFrames: number;
}

export function splitCaption(text: string, maxCharsPerLine: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?。…~])\s+|\n/).filter(Boolean);
  const maxChunk = maxCharsPerLine * 2;
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChunk) {
      out.push(s);
      continue;
    }
    // 긴 문장은 띄어쓰기 단위로 끊는다
    let cur = '';
    for (const w of s.split(' ')) {
      if ((cur + ' ' + w).trim().length > maxChunk && cur) {
        out.push(cur.trim());
        cur = w;
      } else cur = `${cur} ${w}`;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

/** 한 조각을 최대 두 줄로 나눈다 (가운데에 가까운 띄어쓰기에서) */
export function toLines(chunk: string, maxCharsPerLine: number): string[] {
  if (chunk.length <= maxCharsPerLine) return [chunk];
  const mid = chunk.length / 2;
  // 가운데에 가까운 띄어쓰기에서 끊되, 한 글자 단어("세 방울"의 "세")가 줄 끝에 혼자 남지 않게 한다
  // (한국어에서 한 글자 관형어·수사는 뒤 단어에 붙어 읽히므로, 줄 앞에 오는 것은 자연스럽다)
  const wordLenAround = (i: number) => {
    const before = chunk.slice(0, i).split(' ').at(-1)!.length;
    const after = chunk.slice(i + 1).split(' ')[0].length;
    return { before, after };
  };
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] !== ' ') continue;
    const { before, after } = wordLenAround(i);
    const score = Math.abs(i - mid) + (before === 1 ? 6 : 0) + (after > maxCharsPerLine ? 3 : 0);
    if (score < bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best < 0) return [chunk.slice(0, Math.ceil(mid)), chunk.slice(Math.ceil(mid))];
  return [chunk.slice(0, best), chunk.slice(best + 1)];
}

export function timeCaptions(text: string, totalFrames: number, maxCharsPerLine: number): CaptionChunk[] {
  const chunks = splitCaption(text, maxCharsPerLine);
  if (!chunks.length) return [];
  const weight = chunks.map((c) => Math.max(4, c.length));
  const sum = weight.reduce((a, b) => a + b, 0);
  let from = 0;
  return chunks.map((c, i) => {
    const d = i === chunks.length - 1 ? totalFrames - from : Math.round((weight[i] / sum) * totalFrames);
    const r = { text: c, from, durationInFrames: Math.max(1, d) };
    from += d;
    return r;
  });
}
