import fs from 'node:fs';
import path from 'node:path';
import { Account, Brand, DB, Module, ModuleKind, ModuleTags, MODULE_KINDS, Product, ReviewStatus } from './types.js';
import { newId, now } from './store.js';
import { Workspace } from './workspace.js';
import { checkSpec, probe } from './media.js';
import { nextModuleCode } from './naming.js';
import { scanText } from './config.js';
import { canSee, ownedBy, requireAdmin } from './access.js';

/**
 * 모듈 등록.
 * 파일은 어떤 이름이든 받는다. 등록하면 모듈 코드가 붙은 이름으로 정리된다(H014_원래이름.mp4).
 * 같은 이름의 .meta.json 파일이 옆에 있으면 대사·태그를 거기서 읽는다 (팀이 엑셀 등으로 정리한 값을 넣는 통로).
 */

export interface ModuleInput {
  kind: ModuleKind;
  transcript?: string;
  tags?: ModuleTags;
  compatTags?: string[];
  excludeTags?: string[];
}

export interface SidecarMeta extends Partial<ModuleInput> {}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

export function readSidecar(file: string): SidecarMeta | null {
  const candidates = [file.replace(/\.[^.]+$/, '.meta.json'), `${file}.meta.json`];
  const f = candidates.find((c) => fs.existsSync(c));
  return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export function registerModule(
  ws: Workspace,
  db: DB,
  actor: Account,
  brand: Brand,
  product: Product,
  srcFile: string,
  input: ModuleInput,
  opts: { move?: boolean } = {},
): { module: Module; warnings: string[] } {
  const abs = path.resolve(srcFile);
  if (!fs.existsSync(abs)) throw new Error(`파일이 없어요: ${srcFile}`);
  if (db.modules.some((m) => ws.abs(m.file) === abs)) throw new Error(`이미 등록된 파일이에요: ${srcFile}`);

  const sidecar = readSidecar(abs) ?? {};
  const kind = input.kind ?? sidecar.kind;
  if (!MODULE_KINDS.includes(kind)) throw new Error(`모듈 종류는 hook / bridge / story / offer 중 하나여야 해요.`);

  const media = probe(abs);
  const specIssues = checkSpec(media);
  const fails = specIssues.filter((i) => i.level === 'fail');
  if (fails.length) throw new Error(`규격 미달로 등록할 수 없어요: ${fails.map((f) => f.message).join(' / ')}`);

  const code = nextModuleCode(db.modules, brand.id, product.id, kind);
  ws.ensureProductFolders(brand, product);
  const destDir = ws.moduleDir(brand, product, kind);
  const base = path.basename(abs).replace(/^[HBSO]\d{3}_/, '');
  const dest = path.join(destDir, `${code}_${base}`);
  if (path.dirname(abs) === destDir || opts.move) {
    moveFile(abs, dest);
    const sc = abs.replace(/\.[^.]+$/, '.meta.json');
    if (fs.existsSync(sc)) moveFile(sc, dest.replace(/\.[^.]+$/, '.meta.json'));
  } else {
    fs.copyFileSync(abs, dest);
  }

  const transcript = (input.transcript ?? sidecar.transcript ?? '').trim();
  const ruleFindings = transcript ? scanText(ws, brand, transcript) : [];
  const m: Module = {
    id: newId('mod'),
    code,
    kind,
    brandId: brand.id,
    productId: product.id,
    file: ws.rel(dest),
    originalName: path.basename(abs),
    media,
    specIssues,
    transcript,
    tags: { ...(sidecar.tags ?? {}), ...stripEmpty(input.tags ?? {}) },
    compatTags: uniq([...(sidecar.compatTags ?? []), ...(input.compatTags ?? [])]),
    excludeTags: uniq([...(sidecar.excludeTags ?? []), ...(input.excludeTags ?? [])]),
    review: ruleFindings.some((f) => f.level === 'blocked') ? 'rejected' : brand.requireReview ? 'pending' : 'approved',
    reviewNote: ruleFindings.some((f) => f.level === 'blocked') ? '규칙 팩 차단 표현 포함 (자동 반려)' : undefined,
    ruleFindings,
    useCount: 0,
    createdAt: now(),
    ...ownedBy(actor),
  };
  db.modules.push(m);

  const warnings = specIssues.map((i) => i.message);
  for (const f of ruleFindings) warnings.push(`${f.level === 'blocked' ? '차단' : '주의'} 표현 "${f.phrase}": ${f.reason}`);
  return { module: m, warnings };
}

/** 모듈 폴더(modules/hook 등)에 넣어둔 미등록 파일을 한 번에 등록 */
export function scanProductFolders(ws: Workspace, db: DB, actor: Account, brand: Brand, product: Product) {
  ws.ensureProductFolders(brand, product);
  const results: { file: string; module?: Module; warnings?: string[]; error?: string }[] = [];
  for (const kind of MODULE_KINDS) {
    const dir = ws.moduleDir(brand, product, kind);
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      if (!VIDEO_EXT.has(path.extname(name).toLowerCase())) continue;
      if (db.modules.some((m) => ws.abs(m.file) === abs)) continue;
      try {
        const r = registerModule(ws, db, actor, brand, product, abs, { kind });
        results.push({ file: name, ...r });
      } catch (e: any) {
        results.push({ file: name, error: e.message });
      }
    }
  }
  return results;
}

export function setReview(db: DB, actor: Account, mod: Module, status: ReviewStatus, note?: string) {
  requireAdmin(actor, '모듈 심의 상태 변경');
  mod.review = status;
  mod.reviewNote = note;
  mod.reviewedBy = actor.id;
}

export function findModule(db: DB, viewer: Account, brand: Brand, product: Product, code: string): Module {
  const m = db.modules.find((x) => x.brandId === brand.id && x.productId === product.id && x.code === code.toUpperCase());
  if (!m || !canSee(viewer, m)) throw new Error(`${brand.code}/${product.code}에서 모듈 ${code}를 찾을 수 없어요.`);
  return m;
}

/** 이동. 다른 드라이브(윈도우 D: → C:, 외장 디스크 등)로는 이름 바꾸기가 안 되므로 복사 후 삭제 */
function moveFile(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch (e: any) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.rmSync(from);
  }
}

const uniq = (a: string[]) => [...new Set(a.map((s) => s.trim()).filter(Boolean))];
const stripEmpty = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
