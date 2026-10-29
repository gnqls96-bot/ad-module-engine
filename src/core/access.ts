import { Account, DB, Owned, Role, Scope } from './types.js';
import { newId, now } from './store.js';

/**
 * 계정·공개 범위 규칙 (설계서 "계정 구조")
 *
 * - 관리자: 모든 팀원의 데이터를 보고, 등록하는 것은 자동으로 "공통"이 된다.
 * - 팀원: 공통 데이터 + 본인 데이터만 본다. 등록하는 것은 "개인"이 된다.
 * - 생성(대본·조합)에 적용되는 레퍼런스: 관리자 = 전부, 팀원 = 공통 + 본인.
 * - 관리자는 관리자 계정을 포함해 계정을 언제든 발급할 수 있다.
 */

export class AccessError extends Error {}

export function canSee(viewer: Account, item: Owned): boolean {
  if (viewer.role === 'admin') return true;
  return item.scope === 'common' || item.ownerId === viewer.id;
}

export function visible<T extends Owned>(viewer: Account, items: T[]): T[] {
  return items.filter((i) => canSee(viewer, i));
}

/** 생성에 적용되는 레퍼런스. 지금은 "볼 수 있는 것 = 적용되는 것"과 같지만, 규칙이 갈라질 수 있어 분리해 둔다 */
export function appliedForGeneration<T extends Owned>(viewer: Account, items: T[]): T[] {
  if (viewer.role === 'admin') return items;
  return items.filter((i) => i.scope === 'common' || i.ownerId === viewer.id);
}

export function defaultScope(actor: Account): Scope {
  return actor.role === 'admin' ? 'common' : 'private';
}

export function ownedBy(actor: Account): Owned {
  return { ownerId: actor.id, scope: defaultScope(actor) };
}

export function requireAdmin(actor: Account, what: string) {
  if (actor.role !== 'admin') throw new AccessError(`${what}은(는) 관리자 계정만 할 수 있어요.`);
}

export function requireActive(actor: Account) {
  if (actor.status !== 'active') throw new AccessError('정지된 계정입니다. 관리자에게 문의하세요.');
}

/** 본인 것이거나 관리자일 때만 수정 가능 */
export function requireCanEdit(actor: Account, item: Owned, what: string) {
  if (actor.role === 'admin') return;
  if (item.ownerId !== actor.id) throw new AccessError(`다른 사람의 ${what}은(는) 수정할 수 없어요.`);
}

export function promoteToCommon(actor: Account, item: Owned) {
  requireAdmin(actor, '공통으로 올리기');
  item.scope = 'common';
  item.promotedBy = actor.id;
  item.promotedAt = now();
}

/** 첫 관리자 계정. 조직을 만들 때 한 번만 쓴다 */
export function bootstrapAdmin(db: DB, name: string, email?: string): Account {
  if (db.accounts.length > 0) throw new AccessError('이미 계정이 있습니다. 관리자 계정으로 새 계정을 발급하세요.');
  const acc: Account = { id: newId('acc'), name, email, role: 'admin', status: 'active', createdBy: null, createdAt: now() };
  db.accounts.push(acc);
  return acc;
}

export function createAccount(db: DB, actor: Account, name: string, role: Role, email?: string): Account {
  requireAdmin(actor, '계정 발급');
  if (db.accounts.some((a) => a.name === name)) throw new AccessError(`이미 "${name}" 이름의 계정이 있어요.`);
  const acc: Account = { id: newId('acc'), name, email, role, status: 'active', createdBy: actor.id, createdAt: now() };
  db.accounts.push(acc);
  return acc;
}

export function setAccountStatus(db: DB, actor: Account, target: Account, status: Account['status']) {
  requireAdmin(actor, '계정 정지·복구');
  if (status === 'suspended' && target.role === 'admin') {
    const activeAdmins = db.accounts.filter((a) => a.role === 'admin' && a.status === 'active');
    if (activeAdmins.length <= 1) throw new AccessError('마지막 관리자 계정은 정지할 수 없어요.');
  }
  target.status = status;
}

export function findAccount(db: DB, key: string): Account | undefined {
  return db.accounts.find((a) => a.id === key || a.name === key || a.email === key);
}
