import fs from 'node:fs';
import path from 'node:path';

/**
 * 레퍼런스 폴더 일괄 등록 (`ame reference ingest <폴더>`) 도우미.
 *
 * 폴더 규칙: <폴더>/<카테고리>/<파일>. 하위 폴더 이름이 그대로 카테고리 태그가 된다 (업종 코드로 고정하지 않음).
 * 파일 이름에서는 정보를 읽지 않는다 (규칙이 없어서).
 */

const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const IMAGE = new Set(['.webp', '.jpg', '.jpeg', '.png', '.heic', '.gif']);

export interface FoundFile {
  file: string;
  /** 첫 단계 하위 폴더 이름. 폴더 바로 아래 파일은 없음 */
  category?: string;
  kind: 'video' | 'image';
  /** iCloud·OneDrive 등에서 클라우드에만 있고 내 컴퓨터에는 없는 파일 */
  cloudOnly: boolean;
}

export function scanReferenceFolder(root: string): FoundFile[] {
  const out: FoundFile[] = [];
  const walk = (dir: string, category?: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) walk(p, category ?? e.name.normalize('NFC'));
        continue;
      }
      // 맥 옛 iCloud 방식: 내려받지 않은 파일은 ".이름.icloud" 자리표시 파일로 보인다
      const icloud = e.name.startsWith('.') && e.name.endsWith('.icloud');
      const name = icloud ? e.name.slice(1, -'.icloud'.length) : e.name;
      if (!icloud && e.name.startsWith('.')) continue;
      const ext = path.extname(name).toLowerCase();
      const kind = VIDEO.has(ext) ? 'video' : IMAGE.has(ext) ? 'image' : undefined;
      if (!kind) continue;
      out.push({ file: icloud ? path.join(dir, name) : p, category, kind, cloudOnly: icloud || !isLocal(p) });
    }
  };
  walk(root);
  return out;
}

/**
 * 파일 내용이 실제로 디스크에 있는지.
 * 맥 최신 iCloud는 클라우드 전용 파일도 이름·크기는 그대로 보이지만 디스크 블록이 0이다.
 * (윈도우는 blocks 값을 주지 않아 이 방법으로 알 수 없으므로 로컬로 본다)
 */
export function isLocal(file: string): boolean {
  if (process.platform === 'win32') return true;
  const st = fs.statSync(file);
  return st.size === 0 || st.blocks > 0;
}

/** 받아쓰기가 이상해 보이는 이유. 다음 단계(화면 자막 읽기)에서 무엇을 먼저 볼지 고르는 데 쓴다 */
export function transcriptIssues(
  words: { text: string; start: number; end: number; p: number }[],
  media: { durationSec: number; hasAudio: boolean },
): string[] {
  const issues: string[] = [];
  const d = media.durationSec;
  if (!media.hasAudio) issues.push('음성 트랙 없음');
  if (d < 5) issues.push(`너무 짧음 (${d.toFixed(1)}초)`);
  if (!words.length) {
    if (media.hasAudio) issues.push('말소리 없음 (사람 목소리 구간이 감지되지 않음): 음악만 있거나 자막으로만 전달하는 영상');
    return issues;
  }
  const text = words.map((w) => w.text).join(' ');
  const chars = text.replace(/[\s.,!?·~…'"]/g, '').length;
  // 보통 한국어 광고 내레이션은 초당 5~8글자
  const cps = d > 0 ? chars / d : 0;
  if (cps < 1.5) issues.push(`말이 거의 없음 (초당 ${cps.toFixed(1)}글자): 음악 위주이거나 자막만 있는 영상일 수 있음`);
  const avgP = words.reduce((s, w) => s + w.p, 0) / words.length;
  if (avgP < 0.5) issues.push(`받아쓰기 확신도 낮음 (평균 ${avgP.toFixed(2)}): 음악·잡음 위에서 잘못 들었을 수 있음`);
  if (words.length >= 6) {
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w.text, (counts.get(w.text) ?? 0) + 1);
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n / words.length > 0.3) issues.push(`같은 말 반복 ("${top}" ${n}번): Whisper가 지어낸 내용일 수 있음`);
  }
  // 말소리가 없을 때 Whisper가 자주 지어내는 문구
  if (/시청해\s?주셔서|구독과\s?좋아요|자막\s?제공|자막\s?by|다음\s?영상에서\s?만나요|MBC|KBS|\[음악\]|♪|^(감사합니다[.!]?\s*)+$/i.test(text)) issues.push('Whisper가 소리 없는 구간에서 자주 지어내는 문구가 들어 있음');
  const lastEnd = Math.max(...words.map((w) => w.end));
  if (d > 10 && lastEnd < d * 0.4) issues.push(`말소리가 앞쪽 ${lastEnd.toFixed(0)}초에만 있음 (전체 ${d.toFixed(0)}초)`);
  return issues;
}
