import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Account, Brand, DB, KIND_LABEL, MediaInfo, Reference } from './types.js';
import { newId, now } from './store.js';
import { Workspace } from './workspace.js';
import { appliedForGeneration, ownedBy, visible } from './access.js';
import { labelOf, loadTaxonomy, Taxonomy } from './config.js';

/**
 * 레퍼런스 = 참고할 광고 (타사·자사 고효율 광고).
 * 관리자가 넣으면 공통, 팀원이 넣으면 개인. 2단계 레퍼런스 분석기가 transcript·tags를 자동으로 채우게 된다.
 * 뼈대에서는 사람이 태그를 직접 넣거나 .meta.json으로 넣는다.
 */

export interface ReferenceInput {
  title: string;
  source?: string;
  url?: string;
  file?: string;
  runDays?: number;
  transcript?: string;
  tags?: Reference['tags'];
  notes?: string;
  brandId?: string;
  kind?: Reference['kind'];
  media?: MediaInfo;
  /** 받아쓰기 결과 (단어 시간 포함). 레퍼런스 파일 옆에 transcript.json으로 저장 */
  transcriptData?: unknown;
  transcriptIssues?: string[];
  /** 화면 글자 읽기 결과. 레퍼런스 파일 옆에 ocr.json으로 저장 */
  ocrData?: unknown;
  screenText?: string;
}

export type ReferenceAnalysis = Pick<ReferenceInput, 'transcript' | 'transcriptData' | 'transcriptIssues' | 'ocrData' | 'screenText'>;

/** 분석 결과(받아쓰기·화면 글자)를 레퍼런스 파일 옆에 저장하고 레코드에 반영. 다시 분석할 때도 쓴다 */
export function applyAnalysis(ws: Workspace, r: Reference, a: ReferenceAnalysis) {
  if (!r.file) return;
  const dir = path.dirname(ws.abs(r.file));
  const save = (name: string, data: unknown) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(data, null, 2));
    return ws.rel(f);
  };
  if (a.transcriptData !== undefined) {
    r.transcriptFile = save('transcript.json', a.transcriptData);
    r.transcript = a.transcript || undefined;
    r.transcriptIssues = a.transcriptIssues;
  }
  if (a.ocrData !== undefined) {
    r.ocrFile = save('ocr.json', a.ocrData);
    r.screenText = a.screenText || undefined;
  }
}

/** 파일 내용 지문. 이름이 달라도 내용이 같으면 같은 값 */
export function fileSha256(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** 이 계정이 볼 수 있는 레퍼런스 중 내용이 같은 파일 */
export function findBySha(db: DB, viewer: Account, sha: string): Reference | undefined {
  return visible(viewer, db.references).find((r) => r.sha256 === sha);
}

export function addReference(ws: Workspace, db: DB, actor: Account, input: ReferenceInput): Reference {
  let file: string | undefined;
  let sha: string | undefined;
  let originalName: string | undefined;
  if (input.file) {
    const abs = path.resolve(input.file);
    if (!fs.existsSync(abs)) throw new Error(`파일이 없어요: ${input.file}`);
    sha = fileSha256(abs);
    const dup = findBySha(db, actor, sha);
    if (dup) throw new Error(`이미 등록된 파일이에요 (내용이 같음): "${dup.title}" · ID ${dup.id}`);
    originalName = path.basename(abs);
    // 원본 이름 그대로 보관. 이름이 같은 다른 파일과 섞이지 않게 내용 지문 폴더에 넣는다
    const dir = path.join(ws.root, 'references', actor.role === 'admin' ? 'common' : actor.id, sha.slice(0, 16));
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, originalName);
    fs.copyFileSync(abs, dest);
    file = ws.rel(dest);
  }
  const r: Reference = {
    id: newId('ref'),
    brandId: input.brandId,
    title: input.title,
    source: input.source ?? (input.url ? new URL(input.url).hostname : '직접 등록'),
    url: input.url,
    file,
    runDays: input.runDays,
    transcript: input.transcript,
    tags: input.tags ?? {},
    notes: input.notes,
    kind: input.kind,
    sha256: sha,
    originalName,
    media: input.media,
    createdAt: now(),
    ...ownedBy(actor),
  };
  applyAnalysis(ws, r, input);
  db.references.push(r);
  return r;
}

export function listReferences(db: DB, viewer: Account, brand?: Brand): Reference[] {
  return visible(viewer, db.references).filter((r) => !brand || !r.brandId || r.brandId === brand.id);
}

/**
 * 생성용 레퍼런스 묶음.
 * 대본·후킹을 만들 때 Claude 스킬이 이 결과를 읽고 반영한다.
 * 게재 일수(runDays)가 긴 레퍼런스를 앞에 두고, 분류 축별로 많이 쓰인 유형을 집계한다.
 */
export function generationContext(ws: Workspace, db: DB, viewer: Account, brand?: Brand) {
  const refs = appliedForGeneration(viewer, db.references)
    .filter((r) => !brand || !r.brandId || r.brandId === brand.id)
    .sort((a, b) => (b.runDays ?? 0) - (a.runDays ?? 0));
  const tax = loadTaxonomy(ws, brand);
  const patterns: Record<string, { value: string; label: string; count: number; weightedDays: number }[]> = {};
  for (const axis of Object.keys(tax)) {
    const counter = new Map<string, { count: number; days: number }>();
    for (const r of refs) {
      const v = r.tags[axis];
      if (!v) continue;
      const c = counter.get(v) ?? { count: 0, days: 0 };
      c.count++;
      c.days += r.runDays ?? 0;
      counter.set(v, c);
    }
    if (counter.size)
      patterns[axis] = [...counter.entries()]
        .map(([value, c]) => ({ value, label: labelOf(tax, axis, value), count: c.count, weightedDays: c.days }))
        .sort((a, b) => b.weightedDays - a.weightedDays || b.count - a.count);
  }
  return { viewer: { name: viewer.name, role: viewer.role }, references: refs, patterns, taxonomy: tax };
}

export function contextToMarkdown(ctx: ReturnType<typeof generationContext>, db: DB): string {
  const owner = (id: string) => db.accounts.find((a) => a.id === id)?.name ?? id;
  const lines: string[] = [];
  lines.push(`# 생성용 레퍼런스 (${ctx.viewer.name}, ${ctx.viewer.role === 'admin' ? '관리자: 공통 + 모든 팀원' : '팀원: 공통 + 본인'})`, '');
  lines.push(`총 ${ctx.references.length}개`, '');
  if (Object.keys(ctx.patterns).length) {
    lines.push('## 많이 쓰인 패턴 (게재 일수 가중)', '');
    for (const [axis, rows] of Object.entries(ctx.patterns)) {
      lines.push(`- ${ctx.taxonomy[axis].label}: ${rows.map((r) => `${r.label} ${r.count}건/${r.weightedDays}일`).join(', ')}`);
    }
    lines.push('');
  }
  lines.push('## 레퍼런스 목록 (게재 일수 긴 순)', '');
  for (const r of ctx.references) {
    const tags = Object.entries(r.tags)
      .filter(([, v]) => v)
      .map(([k, v]) => `${ctx.taxonomy[k]?.label ?? k}=${labelOf(ctx.taxonomy, k, v)}`)
      .join(', ');
    lines.push(`### ${r.title}`);
    lines.push(`- 범위: ${r.scope === 'common' ? '공통' : `개인(${owner(r.ownerId)})`} · 출처: ${r.source}${r.url ? ` (${r.url})` : ''} · 게재 ${r.runDays ?? '?'}일`);
    if (tags) lines.push(`- 태그: ${tags}`);
    if (r.transcript) lines.push(`- 대사: ${r.transcript}`);
    if (r.analysis) {
      lines.push(`- 후킹 문구: ${r.analysis.hookText}`);
      if (r.analysis.segments.length) lines.push(`- 구간: ${r.analysis.segments.map((s) => `${KIND_LABEL[s.kind]} ${s.start}–${s.end}초`).join(' → ')}`);
      if (r.analysis.risks.length) lines.push(`- 심의 위험 (따라 하지 말 것): ${r.analysis.risks.map((x) => x.phrase).join(' / ')}`);
    }
    if (r.screenText) lines.push(`- 화면 글자: ${r.screenText.replace(/\n/g, ' / ')}`);
    if (r.notes) lines.push(`- 메모: ${r.notes}`);
    lines.push('');
  }
  return lines.join('\n');
}
