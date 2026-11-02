import fs from 'node:fs';
import { DB, MODULE_KINDS, KIND_LABEL, Reference } from '../core/types.js';
import { labelOf, Taxonomy } from '../core/config.js';
import { Workspace } from '../core/workspace.js';
import { lcsLength, norm } from '../ocr/service.js';
import { ScreenTextSegment } from '../ocr/types.js';
import { AnalysisInput, AnalysisResult, FilteredText, TimelineItem } from './types.js';

type Word = { text: string; start: number; end: number };

/** 말을 구(句) 단위로: 0.5초 넘게 쉬거나 4초가 넘으면 끊는다 */
export function speechPhrases(words: Word[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && w.start - last.end <= 0.5 && w.end - last.start <= 4) {
      last.text += ` ${w.text.trim()}`;
      last.end = w.end;
    } else out.push({ type: 'speech', start: w.start, end: w.end, text: w.text.trim() });
  }
  return out;
}

/**
 * 화면 글자 걸러내기 (위치·지속 시간·말과 겹치는지):
 *   caption   : 같은 시간대 말과 글자가 60% 이상 겹침 → 말 자막 (말 줄에 이미 있으니 뺌)
 *   notice    : 작은 글자가 화면 맨 위·아래에 오래 떠 있음 (깜빡여 나뉜 조각은 합쳐서) → 주의 문구·고정 표기
 *   packaging : 3초 이내로 잠깐, 한꺼번에 여러 줄 나오거나 아주 작음 → 제품 포장·성분표 등 배경 글자
 * 남은 것 중 오래 떠 있는 것은 고정 문구(headline), 나머지는 화면 문구(screen).
 */
export function classifyScreenText(segs: ScreenTextSegment[], words: Word[], durationSec: number) {
  const kept: TimelineItem[] = [];
  const filtered: FilteredText[] = [];
  const longDur = Math.max(4, durationSec * 0.3);
  const isCaption = (s: ScreenTextSegment) => {
    const key = norm(s.text);
    if (key.length < 2) return false;
    const spoken = norm(words.filter((w) => w.end >= s.start - 0.7 && w.start <= s.end + 0.7).map((w) => w.text).join(''));
    return spoken.length > 0 && lcsLength(key, spoken) / key.length >= 0.6;
  };
  const captions = new Set(segs.filter(isCaption));
  const short = segs.filter((s) => !captions.has(s) && s.end - s.start <= 3);
  // 주의 문구는 글자 인식이 깜빡여 짧은 조각 여러 개로 나뉜다 → 비슷한 조각(일부 포함)의 보인 시간을 합쳐서 본다
  const edgeSmall = segs.filter((s) => !captions.has(s) && s.size < 0.035 && (s.y >= 0.85 || s.y <= 0.1));
  const keyOf = new Map(edgeSmall.map((s) => [s, norm(s.text)]));
  const shownFor = (s: ScreenTextSegment) => {
    const k = keyOf.get(s)!;
    return edgeSmall.filter((o) => { const ok = keyOf.get(o)!; return Math.min(k.length, ok.length) >= 2 && lcsLength(k, ok) / Math.min(k.length, ok.length) >= 0.8; })
      .reduce((sum, o) => sum + (o.end - o.start), 0);
  };
  for (const s of segs) {
    const dur = s.end - s.start;
    const crowd = short.filter((o) => Math.abs(o.start - s.start) <= 0.5).length;
    const reason: FilteredText['reason'] | undefined = captions.has(s)
      ? 'caption'
      : keyOf.has(s) && shownFor(s) >= longDur
        ? 'notice'
        : dur <= 3 && (crowd >= 8 || s.size < 0.018)
          ? 'packaging'
          : undefined;
    if (reason) filtered.push({ text: s.text, start: s.start, end: s.end, reason });
    else kept.push({ type: dur >= longDur ? 'headline' : 'screen', start: s.start, end: s.end, text: s.text, y: s.y, size: s.size });
  }
  return { kept, filtered };
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const aspectOf = (w: number, h: number) => (w === h ? '1:1' : h / w > 1.7 ? '9:16' : h / w > 1.2 ? '4:5' : w / h > 1.7 ? '16:9' : `${w}x${h}`);

export function buildAnalysisInput(ws: Workspace, r: Reference): AnalysisInput {
  const tr = r.transcriptFile ? readJson(ws.abs(r.transcriptFile)) : { words: [] };
  const ocr = r.ocrFile ? readJson(ws.abs(r.ocrFile)) : undefined;
  const base = { referenceId: r.id, title: r.title, category: r.tags.category, transcriptIssues: r.transcriptIssues ?? [] };
  if (r.kind !== 'video' || !r.media) return { ...base, kind: 'image', timeline: [], filtered: [], imageText: r.screenText ?? ocr?.text ?? '' };
  const { kept, filtered } = classifyScreenText(ocr?.segments ?? [], tr.words, r.media.durationSec);
  const timeline = [...speechPhrases(tr.words), ...kept].sort((a, b) => a.start - b.start || (a.y ?? 0) - (b.y ?? 0));
  return { ...base, kind: 'video', durationSec: r.media.durationSec, aspect: aspectOf(r.media.width, r.media.height), timeline, filtered };
}

const f1 = (n: number) => n.toFixed(1);

/** 분석하는 쪽(Claude)이 읽는 형식 */
export function inputToMarkdown(a: AnalysisInput): string {
  const L: string[] = [`# ${a.referenceId}`, ''];
  L.push(`- 제목: ${a.title} · 카테고리: ${a.category ?? '-'} · ${a.kind === 'video' ? `영상 ${f1(a.durationSec!)}초 ${a.aspect}` : '이미지'}`);
  if (a.transcriptIssues.length) L.push(`- 받아쓰기 주의: ${a.transcriptIssues.join(' / ')}`);
  if (a.kind === 'image') {
    L.push('', '## 화면 글자 (위→아래)', '', a.imageText || '(없음)');
    return L.join('\n') + '\n';
  }
  const heads = a.timeline.filter((t) => t.type === 'headline');
  if (heads.length) {
    L.push('', '## 고정 문구 (오래 떠 있음)', '');
    for (const h of heads) L.push(`- ${f1(h.start)}–${f1(h.end)} | ${h.text} (위치 ${h.y}, 크기 ${h.size})`);
  }
  L.push('', '## 타임라인 (말 = 받아쓰기, 화면 = 말과 다른 화면 문구)', '');
  for (const t of a.timeline.filter((t) => t.type !== 'headline'))
    L.push(`${f1(t.start)}–${f1(t.end)} ${t.type === 'speech' ? '말  ' : '화면'} | ${t.text}${t.type === 'screen' ? ` (위치 ${t.y}, 크기 ${t.size})` : ''}`);
  const by = (k: FilteredText['reason']) => a.filtered.filter((f) => f.reason === k);
  const uniq = (xs: FilteredText[]) => [...new Set(xs.map((x) => x.text))];
  L.push('', '## 걸러낸 화면 글자', '');
  L.push(`- 말 자막 (말과 같음): ${by('caption').length}개`);
  L.push(`- 주의 문구·고정 표기: ${uniq(by('notice')).join(' / ') || '없음'}`);
  const pk = by('packaging');
  L.push(`- 포장·배경 글자 (잠깐·여러 줄 한꺼번에·아주 작음): ${pk.length}개${pk.length > 40 ? ', 앞 40개만' : ''}`);
  // 걸러진 것 중에도 진짜 문구가 섞일 수 있어 시간과 함께 남긴다
  for (const x of pk.slice(0, 40)) L.push(`  - ${f1(x.start)} ${x.text.slice(0, 40)}`);
  return L.join('\n') + '\n';
}

/** 결과를 분류 체계·영상 길이와 맞춰 본다. 문제가 있으면 오류 목록, 없으면 빈 배열 */
export function validateResult(res: AnalysisResult, r: Reference, tax: Taxonomy): string[] {
  const errs: string[] = [];
  const dur = r.media?.durationSec;
  for (const s of res.segments ?? []) {
    if (!MODULE_KINDS.includes(s.kind)) errs.push(`구간 종류 "${s.kind}"는 없음 (${MODULE_KINDS.join(', ')})`);
    if (!(s.start >= 0 && s.end > s.start)) errs.push(`구간 시간이 이상함: ${s.kind} ${s.start}–${s.end}`);
    if (dur !== undefined && s.end > dur + 0.5) errs.push(`구간이 영상 길이(${f1(dur)}초)를 넘음: ${s.kind} ${s.start}–${s.end}`);
  }
  if (r.kind === 'video' && !res.segments?.some((s) => s.kind === 'hook')) errs.push('영상인데 후킹 구간이 없음');
  for (const [axis, v] of Object.entries(res.tags ?? {})) {
    if (!v) continue;
    if (!tax[axis]) errs.push(`분류 축 "${axis}"는 없음`);
    else if (!(v in tax[axis].values) && !res.newTypes?.some((n) => n.axis === axis && n.value === v))
      errs.push(`${tax[axis].label} "${v}"는 분류 체계에 없음 → newTypes에 새 유형 후보로 적어 주세요`);
  }
  return errs;
}

export function applyResult(r: Reference, res: AnalysisResult, provider: string) {
  const { referenceId, tags, ...rest } = res;
  r.analysis = { ...rest, segments: [...rest.segments].sort((a, b) => a.start - b.start), risks: rest.risks ?? [], newTypes: rest.newTypes ?? [], provider, analyzedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(tags ?? {})) if (v) r.tags[k] = v;
}

/** 카테고리별 분포 + 새 유형 후보 + 영상별 요약. 작업 공간 reports/ 에만 저장 (저장소에 올리지 않음) */
export function analysisReport(db: DB, tax: Taxonomy): string {
  const refs = db.references.filter((r) => r.analysis);
  const cats = [...new Set(refs.map((r) => r.tags.category ?? '(없음)'))].sort();
  const label = (axis: string, v: string) => labelOf(tax, axis, v) !== v ? labelOf(tax, axis, v) : `${refs.flatMap((r) => r.analysis!.newTypes).find((n) => n.axis === axis && n.value === v)?.label ?? v} (새 후보)`;
  const L: string[] = [`# 레퍼런스 분석 보고서`, '', `만든 시각: ${new Date().toISOString()} · 분석된 레퍼런스 ${refs.length}개 / 전체 ${db.references.length}개`, ''];
  for (const axis of ['hookType', 'storyType', 'offerType']) {
    L.push(`## ${tax[axis].label} 분포 (카테고리별)`, '');
    const vals = [...new Set(refs.map((r) => r.tags[axis]).filter(Boolean) as string[])];
    const count = (c: string, v: string) => refs.filter((r) => (r.tags.category ?? '(없음)') === c && r.tags[axis] === v).length;
    vals.sort((a, b) => refs.filter((r) => r.tags[axis] === b).length - refs.filter((r) => r.tags[axis] === a).length);
    L.push(`| ${tax[axis].label} | ${cats.join(' | ')} | 합계 |`, `| --- | ${cats.map(() => '---').join(' | ')} | --- |`);
    for (const v of vals) L.push(`| ${label(axis, v)} | ${cats.map((c) => count(c, v) || '').join(' | ')} | ${refs.filter((r) => r.tags[axis] === v).length} |`);
    const none = cats.map((c) => refs.filter((r) => (r.tags.category ?? '(없음)') === c && !r.tags[axis]).length);
    if (none.some(Boolean)) L.push(`| (없음) | ${none.map((n) => n || '').join(' | ')} | ${none.reduce((a, b) => a + b, 0)} |`);
    L.push('');
  }
  L.push('## 새 유형 후보 (분류 체계에 없음)', '');
  const cand = new Map<string, { axis: string; value: string; label: string; refs: Reference[]; reasons: string[] }>();
  for (const r of refs)
    for (const n of r.analysis!.newTypes) {
      const k = `${n.axis}:${n.value}`;
      const c = cand.get(k) ?? { axis: n.axis, value: n.value, label: n.label, refs: [], reasons: [] };
      c.refs.push(r);
      c.reasons.push(n.reason);
      cand.set(k, c);
    }
  if (!cand.size) L.push('없음', '');
  for (const c of [...cand.values()].sort((a, b) => b.refs.length - a.refs.length)) {
    L.push(`### ${tax[c.axis]?.label ?? c.axis} · ${c.label} (\`${c.value}\`) — ${c.refs.length}개`, '');
    c.refs.forEach((r, i) => L.push(`- ${r.tags.category ?? ''}/${r.title}: ${c.reasons[i]}`));
    L.push('');
  }
  L.push('## 영상별', '');
  for (const c of cats)
    for (const r of refs.filter((x) => (x.tags.category ?? '(없음)') === c)) {
      const a = r.analysis!;
      L.push(`### ${c} / ${r.title}`, '');
      if (a.segments.length) L.push(`- 구간: ${a.segments.map((s) => `${KIND_LABEL[s.kind]} ${f1(s.start)}–${f1(s.end)}`).join(' → ')}`);
      L.push(`- 후킹 문구: ${a.hookText}`);
      L.push(`- 유형: ${['hookType', 'storyType', 'offerType'].map((ax) => `${tax[ax].label}=${r.tags[ax] ? label(ax, r.tags[ax]!) : '-'}`).join(' · ')}`);
      if (a.risks.length) L.push(`- 심의 위험: ${a.risks.map((x) => `"${x.phrase}"${x.at !== undefined ? ` (${f1(x.at)}초)` : ''} — ${x.reason}`).join(' / ')}`);
      if (a.notes) L.push(`- 메모: ${a.notes}`);
      L.push('');
    }
  return L.join('\n');
}
