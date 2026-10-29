import { Account, Aspect, ASPECTS, Batch, BatchMode, Brand, CheckResult, Combination, DB, Module, ModuleKind, Product } from './types.js';
import { newId, now } from './store.js';
import { canSee, ownedBy, requireAdmin, requireCanEdit } from './access.js';
import { comboCode } from './naming.js';
import { labelOf, loadTaxonomy } from './config.js';
import { Workspace } from './workspace.js';
import { mergeOffer } from './catalog.js';

/**
 * 배치 = 목적을 정해 만든 조합 묶음 (설계서 "조합 규칙").
 *   hook-test  : 브릿지·스토리·오퍼 고정, 후킹 N개  (기본 모드)
 *   offer-test : 후킹·스토리 고정, 오퍼 N개
 *   story-test : 후킹·오퍼 고정, 스토리 N개
 *   full       : 전부 조합 (상한 필수)
 * 모든 조합은 검사 4단계(호환·심의·길이·다양성)를 거치고, 실패하면 렌더링에서 빠진다(이유는 남는다).
 */

export interface BatchInput {
  mode: BatchMode;
  name?: string;
  targetLength: 15 | 30 | 60;
  aspects: Aspect[];
  hooks?: string[];
  bridges?: string[]; // 비우면 브릿지 없음(B000)
  stories?: string[];
  offers?: string[];
  maxCombos?: number;
}

export const LENGTH_RANGE: Record<15 | 30 | 60, [number, number]> = { 15: [10, 18], 30: [22, 38], 60: [45, 70] };

const FIXED: Record<BatchMode, ModuleKind[]> = {
  'hook-test': ['story', 'offer'],
  'offer-test': ['hook', 'story'],
  'story-test': ['hook', 'offer'],
  full: [],
};

const VARYING_AXES: Record<BatchMode, { kind: ModuleKind; axis: 'hookType' | 'storyType' | 'offerType' | 'visualType' }[]> = {
  'hook-test': [
    { kind: 'hook', axis: 'hookType' },
    { kind: 'hook', axis: 'visualType' },
  ],
  'offer-test': [{ kind: 'offer', axis: 'offerType' }],
  'story-test': [
    { kind: 'story', axis: 'storyType' },
    { kind: 'story', axis: 'visualType' },
  ],
  full: [
    { kind: 'hook', axis: 'hookType' },
    { kind: 'hook', axis: 'visualType' },
  ],
};

export function createBatch(ws: Workspace, db: DB, actor: Account, brand: Brand, product: Product, input: BatchInput) {
  if (!input.aspects.length) throw new Error('비율을 하나 이상 골라주세요 (916, 45, 11, 169).');
  for (const a of input.aspects) if (!(a in ASPECTS)) throw new Error(`모르는 비율: ${a}`);
  if (!LENGTH_RANGE[input.targetLength]) throw new Error('목표 길이는 15, 30, 60 중 하나예요.');

  const pool = (kind: ModuleKind, codes?: string[]): Module[] => {
    const all = db.modules.filter((m) => m.brandId === brand.id && m.productId === product.id && m.kind === kind && canSee(actor, m));
    if (!codes || !codes.length) return all.filter((m) => m.review !== 'rejected');
    return codes.map((c) => {
      const m = all.find((x) => x.code === c.toUpperCase());
      if (!m) throw new Error(`${kind} 모듈 ${c}를 찾을 수 없거나 볼 권한이 없어요.`);
      return m;
    });
  };

  const hooks = pool('hook', input.hooks);
  const stories = pool('story', input.stories);
  const offers = pool('offer', input.offers);
  const bridges: (Module | null)[] = input.bridges?.length ? pool('bridge', input.bridges) : [null];

  const sets: Record<ModuleKind, (Module | null)[]> = { hook: hooks, story: stories, offer: offers, bridge: bridges };
  for (const k of FIXED[input.mode]) {
    if (sets[k].length !== 1) throw new Error(`${input.mode} 모드에서는 ${k} 모듈을 정확히 1개 지정해야 해요 (지금 ${sets[k].length}개).`);
  }
  if (input.mode !== 'full' && bridges.length > 1) throw new Error('테스트 모드에서는 브릿지를 1개만 지정할 수 있어요.');
  for (const k of ['hook', 'story', 'offer'] as const) if (!sets[k].length) throw new Error(`쓸 수 있는 ${k} 모듈이 없어요.`);

  const total = hooks.length * stories.length * offers.length * bridges.length;
  const cap = input.maxCombos ?? 200;
  if (total > cap) throw new Error(`조합이 ${total}개로 상한(${cap})을 넘어요. 모듈을 줄이거나 --max 로 상한을 올리세요.`);

  const seq = db.batches.filter((b) => b.brandId === brand.id && b.productId === product.id).length + 1;
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const batch: Batch = {
    id: newId('bat'),
    name: input.name ?? `${ymd}_${input.mode}_${String(seq).padStart(2, '0')}`,
    brandId: brand.id,
    productId: product.id,
    mode: input.mode,
    targetLength: input.targetLength,
    aspects: input.aspects,
    status: actor.role === 'admin' || !brand.requireBatchApproval ? 'approved' : 'draft',
    approvedBy: actor.role === 'admin' ? actor.id : undefined,
    offerOverride: { ...product.offer },
    version: 1,
    createdAt: now(),
    ...ownedBy(actor),
  };

  const combos: Combination[] = [];
  for (const h of hooks)
    for (const b of bridges)
      for (const s of stories)
        for (const o of offers) {
          const mods = [h, b, s, o].filter(Boolean) as Module[];
          const checks: CheckResult[] = [checkCompat(mods), checkReview(brand, mods), checkLength(mods, input.targetLength)];
          combos.push({
            id: newId('cmb'),
            batchId: batch.id,
            hookId: h!.id,
            bridgeId: b?.id ?? null,
            storyId: s!.id,
            offerId: o!.id,
            comboCode: comboCode(h!, b, s!, o!),
            durationSec: round(mods.reduce((t, m) => t + m.media.durationSec, 0)),
            checks,
            valid: false,
          });
        }

  applyDiversity(ws, db, brand, input.mode, combos);
  for (const c of combos) c.valid = c.checks.every((x) => x.status !== 'fail');
  for (const c of combos.filter((x) => x.valid)) for (const id of [c.hookId, c.bridgeId, c.storyId, c.offerId]) {
    const m = db.modules.find((x) => x.id === id);
    if (m) m.useCount++;
  }

  db.batches.push(batch);
  db.combinations.push(...combos);
  return { batch, combos };
}

// ── 검사 1: 호환 ────────────────────────────────────────────────
/**
 * - 'topic:' 태그를 가진 모듈끼리는 같은 topic을 하나 이상 공유해야 한다 (술자리 후킹 ↔ 위 건강 스토리)
 * - 어떤 모듈의 excludeTags가 다른 모듈의 태그(compatTags, 분류 태그 axis:value)와 겹치면 금지 조합
 */
export function checkCompat(mods: Module[]): CheckResult {
  const problems: string[] = [];
  const topics = mods.map((m) => ({ m, t: m.compatTags.filter((x) => x.startsWith('topic:')) })).filter((x) => x.t.length);
  for (let i = 0; i < topics.length; i++)
    for (let j = i + 1; j < topics.length; j++) {
      const a = topics[i], b = topics[j];
      if (!a.t.some((x) => b.t.includes(x))) problems.push(`${a.m.code}(${a.t.join(',')})와 ${b.m.code}(${b.t.join(',')})의 주제가 달라요`);
    }
  const tagsOf = (m: Module) => [...m.compatTags, ...Object.entries(m.tags).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`), m.code];
  for (const a of mods)
    for (const b of mods) {
      if (a === b) continue;
      const hit = a.excludeTags.filter((x) => tagsOf(b).includes(x));
      if (hit.length) problems.push(`${a.code}는 ${b.code}(${hit.join(',')})와 함께 쓰지 않도록 설정됨`);
    }
  return problems.length ? { name: 'compat', status: 'fail', detail: problems.join(' / ') } : { name: 'compat', status: 'pass', detail: '호환' };
}

// ── 검사 2: 심의 ────────────────────────────────────────────────
export function checkReview(brand: Brand, mods: Module[]): CheckResult {
  const rejected = mods.filter((m) => m.review === 'rejected').map((m) => m.code);
  const pending = mods.filter((m) => m.review === 'pending').map((m) => m.code);
  if (rejected.length) return { name: 'review', status: 'fail', detail: `반려된 모듈 포함: ${rejected.join(', ')}` };
  if (pending.length)
    return brand.requireReview
      ? { name: 'review', status: 'fail', detail: `심의 대기 모듈 포함: ${pending.join(', ')}` }
      : { name: 'review', status: 'warn', detail: `심의 대기 모듈 포함(브랜드 설정상 허용): ${pending.join(', ')}` };
  return { name: 'review', status: 'pass', detail: '심의 통과 모듈 조합' };
}

// ── 검사 3: 길이 ────────────────────────────────────────────────
export function checkLength(mods: Module[], target: 15 | 30 | 60): CheckResult {
  const total = round(mods.reduce((t, m) => t + m.media.durationSec, 0));
  const [lo, hi] = LENGTH_RANGE[target];
  if (total < lo || total > hi) return { name: 'length', status: 'fail', detail: `${total}초 (목표 ${target}초 범위 ${lo}~${hi}초 밖)` };
  return { name: 'length', status: 'pass', detail: `${total}초` };
}

// ── 검사 4: 다양성 ──────────────────────────────────────────────
/**
 * 배치에서 바뀌는 모듈의 유형(후킹 유형·화면 유형 등)이 한쪽으로 쏠리지 않게 한다.
 * 같은 값이 (통과한 조합 수 × 최대 비율)을 넘으면 넘는 조합부터 제외한다.
 * 값이 한 종류뿐이면 쏠림을 피할 수 없으니 제외하지 않고 경고만 남긴다.
 */
export function applyDiversity(ws: Workspace, db: DB, brand: Brand, mode: BatchMode, combos: Combination[]) {
  const tax = loadTaxonomy(ws, brand);
  const byId = new Map(db.modules.map((m) => [m.id, m]));
  const kindId = (c: Combination, k: ModuleKind) => (k === 'hook' ? c.hookId : k === 'story' ? c.storyId : k === 'offer' ? c.offerId : c.bridgeId);
  const candidates = combos.filter((c) => c.checks.every((x) => x.status !== 'fail'));
  const failed = new Set<string>();
  const notes = new Map<string, string[]>();

  for (const { kind, axis } of VARYING_AXES[mode]) {
    const vals = candidates.map((c) => byId.get(kindId(c, kind) ?? '')?.tags[axis]);
    const distinct = new Set(vals.filter(Boolean));
    if (distinct.size === 0) continue;
    if (distinct.size === 1) {
      for (const c of candidates) push(notes, c.id, `${tax[axis]?.label ?? axis}가 모두 "${labelOf(tax, axis, [...distinct][0])}"로 같아요`);
      continue;
    }
    const cap = Math.max(1, Math.floor(candidates.length * brand.diversityMaxShare));
    const count = new Map<string, number>();
    candidates.forEach((c, i) => {
      const v = vals[i];
      if (!v) return;
      const n = (count.get(v) ?? 0) + 1;
      count.set(v, n);
      if (n > cap) {
        failed.add(c.id);
        push(notes, c.id, `${tax[axis]?.label ?? axis} "${labelOf(tax, axis, v)}"가 배치의 ${Math.round(brand.diversityMaxShare * 100)}%(${cap}개)를 넘어요`);
      }
    });
  }

  for (const c of combos) {
    if (!candidates.includes(c)) {
      c.checks.push({ name: 'diversity', status: 'pass', detail: '다른 검사에서 제외됨' });
      continue;
    }
    const n = notes.get(c.id);
    c.checks.push(
      failed.has(c.id)
        ? { name: 'diversity', status: 'fail', detail: n!.join(' / ') }
        : n
          ? { name: 'diversity', status: 'warn', detail: n.join(' / ') }
          : { name: 'diversity', status: 'pass', detail: '쏠림 없음' },
    );
  }
}

export function approveBatch(db: DB, actor: Account, batch: Batch) {
  requireAdmin(actor, '배치 승인');
  if (batch.status !== 'draft') throw new Error(`이미 ${batch.status} 상태인 배치예요.`);
  batch.status = 'approved';
  batch.approvedBy = actor.id;
}

/** 오퍼 데이터(가격 등)를 바꾸면 버전이 올라가고, 다시 렌더링하면 새 버전 소재가 만들어진다 */
export function updateBatchOffer(db: DB, actor: Account, batch: Batch, patch: Batch['offerOverride']) {
  requireCanEdit(actor, batch, '배치');
  batch.offerOverride = mergeOffer(batch.offerOverride ?? {}, patch ?? {});
  batch.version++;
  const brand = db.brands.find((b) => b.id === batch.brandId)!;
  // 팀원이 오퍼를 바꾸면 다시 승인을 받아야 한다 (가격 오기입 방지)
  batch.status = actor.role !== 'admin' && brand.requireBatchApproval ? 'draft' : 'approved';
  if (batch.status === 'approved') batch.approvedBy = actor.id;
}

export function findBatch(db: DB, viewer: Account, key: string): Batch {
  const b = db.batches.find((x) => x.id === key || x.name === key);
  if (!b || !canSee(viewer, b)) throw new Error(`배치 "${key}"를 찾을 수 없어요.`);
  return b;
}

const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
const round = (n: number) => Math.round(n * 100) / 100;
