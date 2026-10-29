import { Aspect, Brand, Combination, KIND_PREFIX, Module, ModuleKind, Product } from './types.js';

/**
 * 소재 코드 규칙 (설계서 "소재 코드와 폴더 규칙")
 *   모듈 코드: H014, B003, S007, O002
 *   조합 코드: H014-B003-S007-O002 (브릿지 없음 = B000)
 *   소재 코드: 브랜드_제품_조합코드_비율_길이_버전  예) DEMO_SERUM_H014-B003-S007-O002_916_30_v1
 * 소재 코드는 매체 광고 이름에 그대로 쓰고, 나중에 성과를 모듈 단위로 다시 쪼갤 때 parseMaterialCode로 읽는다.
 */

export function nextModuleCode(existing: Module[], brandId: string, productId: string, kind: ModuleKind): string {
  const prefix = KIND_PREFIX[kind];
  const nums = existing
    .filter((m) => m.brandId === brandId && m.productId === productId && m.kind === kind)
    .map((m) => Number(m.code.slice(1)));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  if (next > 999) throw new Error(`${prefix} 모듈 번호가 999를 넘었어요.`);
  return `${prefix}${String(next).padStart(3, '0')}`;
}

export function comboCode(hook: Module, bridge: Module | null, story: Module, offer: Module) {
  return [hook.code, bridge?.code ?? 'B000', story.code, offer.code].join('-');
}

export function materialCode(brand: Brand, product: Product, combo: Pick<Combination, 'comboCode'>, aspect: Aspect, length: number, version: number) {
  return `${brand.code}_${product.code}_${combo.comboCode}_${aspect}_${length}_v${version}`;
}

export interface ParsedMaterialCode {
  brand: string;
  product: string;
  hook: string;
  bridge: string | null;
  story: string;
  offer: string;
  aspect: Aspect;
  length: number;
  version: number;
}

const RE = /^([A-Z][A-Z0-9]{1,5})_([A-Z][A-Z0-9]{1,5})_(H\d{3})-(B\d{3})-(S\d{3})-(O\d{3})_(916|45|11|169)_(\d+)_v(\d+)$/;

export function parseMaterialCode(code: string): ParsedMaterialCode | null {
  const m = RE.exec(code.trim());
  if (!m) return null;
  return {
    brand: m[1],
    product: m[2],
    hook: m[3],
    bridge: m[4] === 'B000' ? null : m[4],
    story: m[5],
    offer: m[6],
    aspect: m[7] as Aspect,
    length: Number(m[8]),
    version: Number(m[9]),
  };
}
