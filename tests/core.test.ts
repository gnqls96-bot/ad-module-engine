import { describe, expect, it } from 'vitest';
import { appliedForGeneration, bootstrapAdmin, canSee, createAccount, defaultScope, promoteToCommon, setAccountStatus } from '../src/core/access';
import { checkCompat, checkLength, checkReview } from '../src/core/combinator';
import { comboCode, materialCode, nextModuleCode, parseMaterialCode } from '../src/core/naming';
import { mergeOffer, parseOffer } from '../src/core/catalog';
import { splitCaption, timeCaptions, toLines } from '../src/render/remotion/captions';
import { Brand, EMPTY_DB, Module, Product } from '../src/core/types';

const mod = (over: Partial<Module>): Module => ({
  id: over.code ?? 'x', code: 'H001', kind: 'hook', brandId: 'b', productId: 'p', file: '', originalName: '',
  media: { durationSec: 3, width: 1080, height: 1920, fps: 30, hasAudio: true }, specIssues: [], transcript: '',
  tags: {}, compatTags: [], excludeTags: [], review: 'approved', ruleFindings: [], useCount: 0, createdAt: '',
  ownerId: 'a', scope: 'common', ...over,
});

describe('계정과 공개 범위', () => {
  const db = EMPTY_DB();
  const admin = bootstrapAdmin(db, '후빈');
  const a = createAccount(db, admin, '팀원A', 'member');
  const b = createAccount(db, admin, '팀원B', 'member');
  const common = { ownerId: admin.id, scope: 'common' as const };
  const aPrivate = { ownerId: a.id, scope: 'private' as const };

  it('관리자가 등록하면 공통, 팀원이 등록하면 개인', () => {
    expect(defaultScope(admin)).toBe('common');
    expect(defaultScope(a)).toBe('private');
  });
  it('팀원은 다른 팀원의 개인 데이터를 못 본다', () => {
    expect(canSee(a, aPrivate)).toBe(true);
    expect(canSee(b, aPrivate)).toBe(false);
    expect(canSee(b, common)).toBe(true);
  });
  it('관리자는 전부 보고, 생성에 전부 적용된다', () => {
    expect(canSee(admin, aPrivate)).toBe(true);
    expect(appliedForGeneration(admin, [common, aPrivate])).toHaveLength(2);
    expect(appliedForGeneration(b, [common, aPrivate])).toHaveLength(1);
  });
  it('관리자는 관리자 계정을 추가 발급할 수 있고, 팀원은 발급할 수 없다', () => {
    const boss = createAccount(db, admin, '팀장님', 'admin');
    expect(boss.role).toBe('admin');
    expect(() => createAccount(db, a, '몰래', 'member')).toThrow();
  });
  it('공통으로 올리기: 관리자만, 원래 소유자는 유지', () => {
    const item = { ...aPrivate };
    expect(() => promoteToCommon(a, item)).toThrow();
    promoteToCommon(admin, item);
    expect(item.scope).toBe('common');
    expect(item.ownerId).toBe(a.id);
    expect(canSee(b, item)).toBe(true);
  });
  it('마지막 관리자는 정지할 수 없다', () => {
    const solo = EMPTY_DB();
    const only = bootstrapAdmin(solo, '혼자');
    expect(() => setAccountStatus(solo, only, only, 'suspended')).toThrow();
  });
});

describe('조합 검사', () => {
  const brand = { requireReview: true } as Brand;
  it('주제(topic)가 다르면 호환 실패', () => {
    const h = mod({ code: 'H001', compatTags: ['topic:acne'] });
    const s = mod({ code: 'S001', kind: 'story', compatTags: ['topic:dryness'] });
    expect(checkCompat([h, s]).status).toBe('fail');
    expect(checkCompat([mod({ code: 'H002', compatTags: ['topic:dryness'] }), s]).status).toBe('pass');
  });
  it('excludeTags로 지정한 조합은 실패', () => {
    const h = mod({ code: 'H001', excludeTags: ['offerType:gift'] });
    const o = mod({ code: 'O001', kind: 'offer', tags: { offerType: 'gift' } });
    expect(checkCompat([h, o]).status).toBe('fail');
  });
  it('심의 대기·반려 모듈이 있으면 실패', () => {
    expect(checkReview(brand, [mod({ review: 'pending' })]).status).toBe('fail');
    expect(checkReview(brand, [mod({ review: 'rejected' })]).status).toBe('fail');
    expect(checkReview({ requireReview: false } as Brand, [mod({ review: 'pending' })]).status).toBe('warn');
  });
  it('길이 범위 밖이면 실패', () => {
    const m = (s: number) => mod({ media: { durationSec: s, width: 1080, height: 1920, fps: 30, hasAudio: true } });
    expect(checkLength([m(2.5), m(7.5), m(3.5)], 15).status).toBe('pass');
    expect(checkLength([m(40)], 15).status).toBe('fail');
  });
});

describe('소재 코드', () => {
  it('모듈 번호는 종류별로 1씩 증가', () => {
    expect(nextModuleCode([mod({ code: 'H007' })], 'b', 'p', 'hook')).toBe('H008');
    expect(nextModuleCode([mod({ code: 'H007' })], 'b', 'p', 'story')).toBe('S001');
  });
  it('소재 코드를 만들고 다시 읽을 수 있다', () => {
    const cc = comboCode(mod({ code: 'H014' }), null, mod({ code: 'S007' }), mod({ code: 'O002' }));
    expect(cc).toBe('H014-B000-S007-O002');
    const code = materialCode({ code: 'DEMO' } as Brand, { code: 'SERUM' } as Product, { comboCode: cc }, '916', 30, 2);
    expect(code).toBe('DEMO_SERUM_H014-B000-S007-O002_916_30_v2');
    expect(parseMaterialCode(code)).toMatchObject({ hook: 'H014', bridge: null, aspect: '916', version: 2 });
  });
  it('오퍼 데이터 파싱 + 할인율 자동 계산', () => {
    expect(mergeOffer({}, parseOffer(['price=39,000', 'originalPrice=59000']))).toEqual({ price: 39000, originalPrice: 59000, discountRate: 34 });
    expect(mergeOffer({ price: 39000, originalPrice: 59000, discountRate: 34 }, { price: 29000 }).discountRate).toBe(51);
  });
});

describe('자막', () => {
  it('문장 단위로 나누고 두 줄로 접는다', () => {
    const chunks = splitCaption('세안 후 바로 세럼을 바르면 수분이 날아가요. 토너로 결을 정돈하세요.', 16);
    expect(chunks.length).toBe(2);
    expect(toLines(chunks[0], 16).length).toBeLessThanOrEqual(2);
  });
  it('구간 길이 합이 전체 프레임과 같다', () => {
    const t = timeCaptions('하나. 둘 셋 넷. 다섯 여섯.', 90, 16);
    expect(t.reduce((s, c) => s + c.durationInFrames, 0)).toBe(90);
  });
});
