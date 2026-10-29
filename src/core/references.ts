import fs from 'node:fs';
import path from 'node:path';
import { Account, Brand, DB, Reference } from './types.js';
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
}

export function addReference(ws: Workspace, db: DB, actor: Account, input: ReferenceInput): Reference {
  let file: string | undefined;
  if (input.file) {
    const abs = path.resolve(input.file);
    if (!fs.existsSync(abs)) throw new Error(`파일이 없어요: ${input.file}`);
    const dir = path.join(ws.root, 'references', actor.role === 'admin' ? 'common' : actor.id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}_${path.basename(abs)}`);
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
    createdAt: now(),
    ...ownedBy(actor),
  };
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
    if (r.notes) lines.push(`- 메모: ${r.notes}`);
    lines.push('');
  }
  return lines.join('\n');
}
