import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, newId, now } from './store.js';
import { Account, AuditEntry, Brand, DB, Product } from './types.js';
import { AccessError, findAccount, requireActive } from './access.js';

/** 엔진 코드가 있는 폴더 (기본 설정 파일 위치) */
export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 작업 공간 = 조직 하나의 데이터 폴더.
 *   .ame/db.json         데이터
 *   .ame/session.json    지금 로그인한 계정 (CLI용)
 *   config/              조직 설정 덮어쓰기 (taxonomy.json, rulepacks/*.json)
 *   brands/<브랜드>/<제품>/modules/{hook,bridge,story,offer}/
 *   brands/<브랜드>/<제품>/renders/<배치>/
 *   references/          레퍼런스 파일
 *
 * 영상 저장 위치를 바꿀 때(구글 드라이브 동기화 폴더 등)는 작업 공간 경로만 바꾸면 된다.
 */
export class Workspace {
  readonly store: JsonStore;

  constructor(readonly root: string) {
    this.store = new JsonStore(path.join(root, '.ame'));
  }

  static resolve(explicit?: string): Workspace {
    const root = path.resolve(explicit ?? process.env.AME_WORKSPACE ?? process.cwd());
    return new Workspace(root);
  }

  get initialized() {
    return this.store.exists();
  }

  abs(rel: string) {
    return path.isAbsolute(rel) ? rel : path.join(this.root, rel);
  }

  rel(abs: string) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  productDir(brand: Brand, product: Product) {
    return path.join(this.root, 'brands', brand.code, product.code);
  }

  moduleDir(brand: Brand, product: Product, kind: string) {
    return path.join(this.productDir(brand, product), 'modules', kind);
  }

  renderDir(brand: Brand, product: Product, batchName: string) {
    return path.join(this.productDir(brand, product), 'renders', batchName);
  }

  ensureProductFolders(brand: Brand, product: Product) {
    for (const k of ['hook', 'bridge', 'story', 'offer']) fs.mkdirSync(this.moduleDir(brand, product, k), { recursive: true });
    fs.mkdirSync(path.join(this.productDir(brand, product), 'renders'), { recursive: true });
  }

  // ── 세션 (CLI에서 "지금 누구로 작업 중인지") ─────────────────────────
  private sessionFile() {
    return path.join(this.root, '.ame', 'session.json');
  }

  setSession(accountId: string) {
    fs.writeFileSync(this.sessionFile(), JSON.stringify({ accountId, at: now() }, null, 2));
  }

  /** 우선순위: --as 옵션 > AME_ACCOUNT 환경변수 > 마지막 로그인 */
  currentAccount(db: DB, as?: string): Account {
    const key = as ?? process.env.AME_ACCOUNT ?? this.readSession();
    if (!key) throw new AccessError('로그인한 계정이 없어요. `ame login <이름>`으로 먼저 로그인하세요.');
    const acc = findAccount(db, key);
    if (!acc) throw new AccessError(`"${key}" 계정을 찾을 수 없어요.`);
    requireActive(acc);
    return acc;
  }

  private readSession(): string | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile(), 'utf8')).accountId;
    } catch {
      return undefined;
    }
  }
}

export function audit(db: DB, actor: Account, action: string, target?: string, detail?: string) {
  const e: AuditEntry = { id: newId('log'), at: now(), actorId: actor.id, action, target, detail };
  db.audit.push(e);
}

export function findBrand(db: DB, key: string): Brand {
  const b = db.brands.find((x) => x.code === key.toUpperCase() || x.id === key || x.name === key);
  if (!b) throw new Error(`브랜드 "${key}"를 찾을 수 없어요.`);
  return b;
}

export function findProduct(db: DB, brand: Brand, key: string): Product {
  const p = db.products.find((x) => x.brandId === brand.id && (x.code === key.toUpperCase() || x.id === key || x.name === key));
  if (!p) throw new Error(`${brand.code} 브랜드에서 제품 "${key}"를 찾을 수 없어요.`);
  return p;
}
