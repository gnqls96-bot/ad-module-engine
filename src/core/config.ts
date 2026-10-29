import fs from 'node:fs';
import path from 'node:path';
import { Brand, BrandKit, RuleFinding } from './types.js';
import { ENGINE_ROOT, Workspace } from './workspace.js';

/**
 * 설정 파일 읽기.
 * 기본값(엔진 config/) → 조직 덮어쓰기(작업 공간 config/) → 브랜드 덮어쓰기 순서로 합친다.
 * 업종 지식은 코드에 없고 전부 이 파일들에 있다.
 */

export type Taxonomy = Record<string, { label: string; values: Record<string, string> }>;

export interface RulePack {
  id: string;
  name: string;
  description?: string;
  blocked: { phrase: string; reason: string }[];
  caution: { phrase: string; reason: string }[];
  requiredNotices: string[];
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

export function loadTaxonomy(ws: Workspace, brand?: Brand): Taxonomy {
  const base: Taxonomy = readJson(path.join(ENGINE_ROOT, 'config', 'taxonomy.default.json'));
  delete (base as any).$comment;
  const orgFile = path.join(ws.root, 'config', 'taxonomy.json');
  const layers = [fs.existsSync(orgFile) ? readJson(orgFile) : {}, brand?.taxonomyOverride ?? {}];
  for (const layer of layers) {
    for (const [axis, def] of Object.entries<any>(layer)) {
      if (axis.startsWith('$')) continue;
      base[axis] ??= { label: def.label ?? axis, values: {} };
      if (def.label) base[axis].label = def.label;
      Object.assign(base[axis].values, def.values ?? {});
    }
  }
  return base;
}

export function labelOf(tax: Taxonomy, axis: string, value?: string) {
  if (!value) return '';
  return tax[axis]?.values[value] ?? value;
}

/** 분류 체계에 없는 값이면 경고 메시지를 돌려준다 (등록은 막지 않는다: 새 유형 후보가 될 수 있음) */
export function unknownTagWarnings(tax: Taxonomy, tags: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [axis, v] of Object.entries(tags)) {
    if (!v || !tax[axis]) continue;
    if (Object.keys(tax[axis].values).length && !(v in tax[axis].values)) {
      out.push(`분류 체계에 없는 ${tax[axis].label} "${v}" (새 유형 후보로 기록)`);
    }
  }
  return out;
}

export function loadRulePack(ws: Workspace, id: string): RulePack {
  const candidates = [path.join(ws.root, 'config', 'rulepacks', `${id}.json`), path.join(ENGINE_ROOT, 'config', 'rulepacks', `${id}.json`)];
  const f = candidates.find((c) => fs.existsSync(c));
  if (!f) throw new Error(`규칙 팩 "${id}"를 찾을 수 없어요. config/rulepacks/${id}.json 을 만들어 주세요.`);
  return readJson(f);
}

export function listRulePacks(ws: Workspace): string[] {
  const ids = new Set<string>();
  for (const d of [path.join(ENGINE_ROOT, 'config', 'rulepacks'), path.join(ws.root, 'config', 'rulepacks')]) {
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) ids.add(f.replace(/\.json$/, ''));
  }
  return [...ids].sort();
}

/** 대사·자막 텍스트를 브랜드의 규칙 팩들로 검사 */
export function scanText(ws: Workspace, brand: Brand, text: string): RuleFinding[] {
  const out: RuleFinding[] = [];
  const t = text.replace(/\s+/g, ' ');
  for (const id of brand.rulePackIds) {
    const pack = loadRulePack(ws, id);
    for (const r of pack.blocked) if (t.includes(r.phrase)) out.push({ level: 'blocked', phrase: r.phrase, reason: r.reason, rulePackId: id });
    for (const r of pack.caution) if (t.includes(r.phrase)) out.push({ level: 'caution', phrase: r.phrase, reason: r.reason, rulePackId: id });
  }
  return out;
}

export function loadBrandKit(brand: Brand): BrandKit {
  const base: BrandKit = readJson(path.join(ENGINE_ROOT, 'config', 'brandkit.default.json'));
  delete (base as any).$comment;
  const o = brand.brandKit ?? {};
  return {
    ...base,
    ...o,
    caption: { ...base.caption, ...(o.caption ?? {}) },
    offerCard: { ...base.offerCard, ...(o.offerCard ?? {}) },
  };
}
