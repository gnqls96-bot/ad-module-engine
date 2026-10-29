import { Account, Brand, DB, OfferData, Product } from './types.js';
import { newId, now } from './store.js';
import { requireAdmin } from './access.js';

/** 브랜드·제품 약칭 규칙: 영문 대문자·숫자 2~6자 (소재 코드에 그대로 들어간다) */
export function normalizeCode(code: string, what: string) {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,5}$/.test(c)) throw new Error(`${what} 약칭은 영문으로 시작하는 2~6자 (영문 대문자·숫자)여야 해요: "${code}"`);
  return c;
}

export function createBrand(
  db: DB,
  actor: Account,
  input: { code: string; name: string; industry?: string; rulePackIds?: string[] },
): Brand {
  requireAdmin(actor, '브랜드 생성');
  const code = normalizeCode(input.code, '브랜드');
  if (db.brands.some((b) => b.code === code)) throw new Error(`이미 ${code} 브랜드가 있어요.`);
  const b: Brand = {
    id: newId('brd'),
    code,
    name: input.name,
    industry: input.industry ?? '미정',
    rulePackIds: input.rulePackIds?.length ? input.rulePackIds : ['empty'],
    brandKit: {},
    requireReview: true,
    requireBatchApproval: true,
    diversityMaxShare: 0.5,
    createdBy: actor.id,
    createdAt: now(),
  };
  db.brands.push(b);
  return b;
}

export function createProduct(db: DB, actor: Account, brand: Brand, input: { code: string; name: string; offer?: OfferData }): Product {
  requireAdmin(actor, '제품 생성');
  const code = normalizeCode(input.code, '제품');
  if (db.products.some((p) => p.brandId === brand.id && p.code === code)) throw new Error(`${brand.code}에 이미 ${code} 제품이 있어요.`);
  const p: Product = { id: newId('prd'), brandId: brand.id, code, name: input.name, offer: input.offer ?? {}, createdBy: actor.id, createdAt: now() };
  db.products.push(p);
  return p;
}

/** "price=39000 originalPrice=59000 deadline=2026-11-30 gift=미니어처" 같은 key=value 목록을 오퍼 데이터로 */
export function parseOffer(pairs: string[]): OfferData {
  const o: any = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 1) throw new Error(`오퍼 값은 key=value 형식이어야 해요: "${pair}"`);
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (!['price', 'originalPrice', 'discountRate', 'deadline', 'gift', 'headline', 'cta'].includes(k)) throw new Error(`모르는 오퍼 항목: ${k}`);
    o[k] = ['price', 'originalPrice', 'discountRate'].includes(k) ? Number(v.replace(/,/g, '')) : v;
  }
  return o;
}

/**
 * 기존 오퍼에 변경분을 합친다. 가격이나 정가가 바뀌었는데 할인율을 직접 주지 않았으면 할인율을 다시 계산한다
 * (가격만 바꾸고 할인율은 옛날 값이 남는 실수 방지).
 */
export function mergeOffer(base: OfferData, patch: OfferData): OfferData {
  const out = { ...base, ...patch };
  const priceChanged = patch.price !== undefined || patch.originalPrice !== undefined;
  if (priceChanged && patch.discountRate === undefined && out.price && out.originalPrice) {
    out.discountRate = Math.round((1 - out.price / out.originalPrice) * 100);
  }
  return out;
}
