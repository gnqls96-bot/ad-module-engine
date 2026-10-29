import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Workspace, audit, findBrand, findProduct } from '../core/workspace.js';
import { Account, Aspect, BatchMode, DB, effectiveDuration, KIND_LABEL, ModuleKind } from '../core/types.js';
import { AccessError, bootstrapAdmin, canSee, createAccount, findAccount, promoteToCommon, requireAdmin, setAccountStatus, visible } from '../core/access.js';
import { createBrand, createProduct, mergeOffer, parseOffer } from '../core/catalog.js';
import { findModule, registerModule, scanProductFolders, setReview } from '../core/modules.js';
import { addReference, contextToMarkdown, generationContext, listReferences } from '../core/references.js';
import { approveBatch, createBatch, findBatch, updateBatchOffer } from '../core/combinator.js';
import { enqueueBatch, jobsVisible } from '../core/queue.js';
import { batchCsv, memberSummary } from '../core/report.js';
import { listRulePacks, loadTaxonomy } from '../core/config.js';
import { newId, now } from '../core/store.js';
import { info, ok, table, warn } from './format.js';

const program = new Command();
program
  .name('ame')
  .description('광고 모듈 조합 엔진 — 후킹·브릿지·스토리·오퍼 모듈을 조합해 소재를 대량 렌더링')
  .option('-w, --workspace <dir>', '작업 공간 폴더 (기본: 현재 폴더 또는 AME_WORKSPACE)')
  .option('--as <account>', '이 명령만 다른 계정으로 실행')
  .option('--json', '결과를 JSON으로 출력');

const ws = () => Workspace.resolve(program.opts().workspace);
const asJson = () => Boolean(program.opts().json);

function needWs(): Workspace {
  const w = ws();
  if (!w.initialized) throw new Error(`작업 공간이 아니에요: ${w.root}\n  \`ame init\`으로 먼저 만들거나 -w 로 폴더를 지정하세요.`);
  return w;
}

/** 읽기 + 쓰기 한 번에 (계정 확인 포함) */
function act<T>(fn: (ctx: { w: Workspace; db: DB; me: Account }) => T): T {
  const w = needWs();
  return w.store.transact((db) => fn({ w, db, me: w.currentAccount(db, program.opts().as) }));
}
function read<T>(fn: (ctx: { w: Workspace; db: DB; me: Account }) => T): T {
  const w = needWs();
  const db = w.store.read();
  return fn({ w, db, me: w.currentAccount(db, program.opts().as) });
}

const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const nameOf = (db: DB, id?: string) => db.accounts.find((a) => a.id === id)?.name ?? '';
const scopeLabel = (s: string) => (s === 'common' ? '공통' : '개인');

// ── 조직·계정 ────────────────────────────────────────────────────
program
  .command('init')
  .description('새 작업 공간(조직)과 첫 관리자 계정 만들기')
  .requiredOption('--org <name>', '조직 이름 (예: 마케팅본부)')
  .requiredOption('--admin <name>', '첫 관리자 이름')
  .option('--email <email>')
  .action((o) => {
    const w = ws();
    if (w.initialized) throw new Error(`이미 작업 공간이에요: ${w.root}`);
    w.store.init();
    const acc = w.store.transact((db) => {
      db.org = { id: newId('org'), name: o.org, createdAt: now() };
      const a = bootstrapAdmin(db, o.admin, o.email);
      audit(db, a, 'org.init', db.org.id, o.org);
      return a;
    });
    fs.mkdirSync(path.join(w.root, 'config', 'rulepacks'), { recursive: true });
    w.setSession(acc.id);
    ok(`작업 공간 생성: ${w.root}`);
    ok(`관리자 계정 "${acc.name}"으로 로그인됨`);
  });

program
  .command('login <account>')
  .description('이 컴퓨터에서 쓸 계정 선택 (이름·이메일·ID)')
  .action((key) => {
    const w = needWs();
    const db = w.store.read();
    const a = findAccount(db, key);
    if (!a) throw new Error(`"${key}" 계정을 찾을 수 없어요.`);
    if (a.status !== 'active') throw new AccessError('정지된 계정이에요.');
    w.setSession(a.id);
    ok(`${a.name} (${a.role === 'admin' ? '관리자' : '팀원'})로 로그인`);
  });

program
  .command('whoami')
  .description('지금 로그인한 계정')
  .action(() => read(({ me }) => info(`${me.name} · ${me.role === 'admin' ? '관리자 (공통 + 모든 팀원 데이터)' : '팀원 (공통 + 본인 데이터)'}`)));

const account = program.command('account').description('계정 관리 (관리자)');
account
  .command('create')
  .description('계정 발급. 관리자는 관리자 계정도 언제든 추가로 발급할 수 있음')
  .requiredOption('--name <name>')
  .option('--role <role>', 'admin | member', 'member')
  .option('--email <email>')
  .action((o) =>
    act(({ db, me }) => {
      if (!['admin', 'member'].includes(o.role)) throw new Error('--role 은 admin 또는 member');
      const a = createAccount(db, me, o.name, o.role, o.email);
      audit(db, me, 'account.create', a.id, `${a.name}/${a.role}`);
      ok(`${a.role === 'admin' ? '관리자' : '팀원'} 계정 "${a.name}" 발급 (ID ${a.id})`);
    }),
  );
account
  .command('list')
  .action(() =>
    read(({ db, me }) => {
      requireAdmin(me, '계정 목록 보기');
      info(table(db.accounts.map((a) => ({ 이름: a.name, 역할: a.role === 'admin' ? '관리자' : '팀원', 상태: a.status === 'active' ? '사용' : '정지', 발급자: nameOf(db, a.createdBy ?? undefined), ID: a.id }))));
    }),
  );
for (const [cmd, status, label] of [['suspend', 'suspended', '정지'], ['activate', 'active', '복구']] as const)
  account
    .command(`${cmd} <account>`)
    .description(`계정 ${label}`)
    .action((key) =>
      act(({ db, me }) => {
        const t = findAccount(db, key);
        if (!t) throw new Error(`"${key}" 계정이 없어요.`);
        setAccountStatus(db, me, t, status);
        audit(db, me, `account.${cmd}`, t.id);
        ok(`${t.name} 계정 ${label}`);
      }),
    );

program
  .command('team')
  .description('팀원별 제작 현황 (관리자)')
  .action(() =>
    read(({ db, me }) => {
      requireAdmin(me, '팀원별 현황 보기');
      const rows = memberSummary(db);
      if (asJson()) return info(JSON.stringify(rows, null, 2));
      info(table(rows.map((r) => ({ 이름: r.name, 역할: r.role === 'admin' ? '관리자' : '팀원', 레퍼런스: r.references, 모듈: r.modules, 배치: r.batches, 승인배치: r.approvedBatches, 렌더완료: r.rendered, 렌더실패: r.failed }))));
    }),
  );

// ── 브랜드·제품 ──────────────────────────────────────────────────
const brand = program.command('brand').description('브랜드 (생성·설정은 관리자)');
brand
  .command('create')
  .requiredOption('--code <code>', '영문 약칭 2~6자 (소재 코드에 들어감)')
  .requiredOption('--name <name>')
  .option('--industry <industry>', '업종 (자유 입력)')
  .option('--rulepack <ids>', '규칙 팩 (쉼표 구분). 목록: ame rulepack list')
  .action((o) =>
    act(({ db, me, w }) => {
      const packs = list(o.rulepack);
      const known = listRulePacks(w);
      for (const p of packs ?? []) if (!known.includes(p)) throw new Error(`규칙 팩 "${p}"가 없어요. 있는 팩: ${known.join(', ')}`);
      const b = createBrand(db, me, { code: o.code, name: o.name, industry: o.industry, rulePackIds: packs });
      audit(db, me, 'brand.create', b.id, b.code);
      ok(`브랜드 ${b.code} (${b.name}) 생성 · 규칙 팩: ${b.rulePackIds.join(', ')}`);
    }),
  );
brand.command('list').action(() =>
  read(({ db }) =>
    info(table(db.brands.map((b) => ({ 코드: b.code, 이름: b.name, 업종: b.industry, 규칙팩: b.rulePackIds, 심의필수: b.requireReview, 배치승인필수: b.requireBatchApproval, 다양성상한: b.diversityMaxShare })))),
  ),
);
brand
  .command('set <code>')
  .description('브랜드 설정 변경')
  .option('--require-review <bool>', '심의 통과 모듈만 조합에 사용')
  .option('--require-approval <bool>', '팀원 배치는 관리자 승인 후 렌더링')
  .option('--diversity <share>', '같은 유형이 배치에서 넘으면 안 되는 비율 (0~1)')
  .option('--rulepack <ids>')
  .option('--kit <file>', '브랜드 키트 JSON 파일 (폰트·자막·오퍼 카드 스타일)')
  .action((code, o) =>
    act(({ db, me }) => {
      requireAdmin(me, '브랜드 설정 변경');
      const b = findBrand(db, code);
      const bool = (v: string) => ['true', '1', 'yes', 'y'].includes(String(v).toLowerCase());
      if (o.requireReview !== undefined) b.requireReview = bool(o.requireReview);
      if (o.requireApproval !== undefined) b.requireBatchApproval = bool(o.requireApproval);
      if (o.diversity !== undefined) b.diversityMaxShare = Number(o.diversity);
      if (o.rulepack) b.rulePackIds = list(o.rulepack)!;
      if (o.kit) b.brandKit = JSON.parse(fs.readFileSync(o.kit, 'utf8'));
      audit(db, me, 'brand.set', b.id);
      ok(`${b.code} 설정 저장`);
    }),
  );

const product = program.command('product').description('제품');
product
  .command('create')
  .requiredOption('--brand <code>')
  .requiredOption('--code <code>')
  .requiredOption('--name <name>')
  .option('--offer <pairs...>', '오퍼 데이터: price=39000 originalPrice=59000 deadline=11월 30일 gift=미니어처 headline="첫 구매 특가" cta="지금 구매"')
  .action((o) =>
    act(({ db, me, w }) => {
      const b = findBrand(db, o.brand);
      const p = createProduct(db, me, b, { code: o.code, name: o.name, offer: o.offer ? mergeOffer({}, parseOffer(o.offer)) : {} });
      w.ensureProductFolders(b, p);
      audit(db, me, 'product.create', p.id, `${b.code}/${p.code}`);
      ok(`제품 ${b.code}/${p.code} (${p.name}) 생성`);
      info(`  모듈 폴더: ${w.rel(w.moduleDir(b, p, '{hook,bridge,story,offer}'))}`);
    }),
  );
product
  .command('list')
  .option('--brand <code>')
  .action((o) =>
    read(({ db }) => {
      const b = o.brand ? findBrand(db, o.brand) : undefined;
      info(table(db.products.filter((p) => !b || p.brandId === b.id).map((p) => ({ 브랜드: db.brands.find((x) => x.id === p.brandId)?.code, 코드: p.code, 이름: p.name, 오퍼: p.offer }))));
    }),
  );
product
  .command('offer')
  .description('제품 기본 오퍼 데이터 변경 (이후 만드는 배치에 적용)')
  .requiredOption('--brand <code>')
  .requiredOption('--product <code>')
  .argument('<pairs...>')
  .action((pairs, o) =>
    act(({ db, me }) => {
      requireAdmin(me, '제품 오퍼 변경');
      const b = findBrand(db, o.brand);
      const p = findProduct(db, b, o.product);
      p.offer = mergeOffer(p.offer, parseOffer(pairs));
      audit(db, me, 'product.offer', p.id);
      ok(`오퍼 저장: ${JSON.stringify(p.offer)}`);
    }),
  );

// ── 모듈 ─────────────────────────────────────────────────────────
const tagOpts = (c: Command) =>
  c
    .option('--hook-type <v>')
    .option('--story-type <v>')
    .option('--offer-type <v>')
    .option('--visual <v>', '화면 유형')
    .option('--target <v>');
const tagsFrom = (o: any) => ({ hookType: o.hookType, storyType: o.storyType, offerType: o.offerType, visualType: o.visual, target: o.target });

const mod = program.command('module').description('모듈 (후킹·브릿지·스토리·오퍼 영상 조각)');
tagOpts(
  mod
    .command('add <file>')
    .description('영상 파일을 모듈로 등록 (규격 검사 → 모듈 코드 부여 → 규칙 팩 검사)')
    .requiredOption('--brand <code>')
    .requiredOption('--product <code>')
    .requiredOption('--kind <kind>', 'hook | bridge | story | offer')
    .option('--transcript <text>', '대사·자막 원문')
    .option('--compat <tags>', '호환 태그, 쉼표 구분 (예: topic:dryness)')
    .option('--exclude <tags>', '함께 쓰면 안 되는 태그'),
).action((file, o) =>
  act(({ w, db, me }) => {
    const b = findBrand(db, o.brand);
    const p = findProduct(db, b, o.product);
    const { module: m, warnings } = registerModule(w, db, me, b, p, file, {
      kind: o.kind as ModuleKind,
      transcript: o.transcript,
      tags: tagsFrom(o),
      compatTags: list(o.compat),
      excludeTags: list(o.exclude),
    });
    audit(db, me, 'module.add', m.id, m.code);
    ok(`${KIND_LABEL[m.kind]} ${m.code} 등록 (${m.media.durationSec}초, ${scopeLabel(m.scope)}, 심의 ${m.review})`);
    warnings.forEach(warn);
  }),
);
mod
  .command('scan')
  .description('모듈 폴더에 넣어둔 새 파일을 한 번에 등록 (.meta.json 이 있으면 대사·태그도 읽음)')
  .requiredOption('--brand <code>')
  .requiredOption('--product <code>')
  .action((o) =>
    act(({ w, db, me }) => {
      const b = findBrand(db, o.brand);
      const p = findProduct(db, b, o.product);
      const rs = scanProductFolders(w, db, me, b, p);
      if (!rs.length) return info('새로 등록할 파일이 없어요.');
      for (const r of rs) {
        if (r.error) warn(`${r.file}: ${r.error}`);
        else {
          ok(`${r.file} → ${r.module!.code} (${r.module!.media.durationSec}초, 심의 ${r.module!.review})`);
          r.warnings!.forEach((x) => info(`    ⚠ ${x}`));
          audit(db, me, 'module.add', r.module!.id, r.module!.code);
        }
      }
    }),
  );
mod
  .command('list')
  .option('--brand <code>')
  .option('--product <code>')
  .option('--kind <kind>')
  .action((o) =>
    read(({ db, me }) => {
      const b = o.brand ? findBrand(db, o.brand) : undefined;
      const p = b && o.product ? findProduct(db, b, o.product) : undefined;
      const rows = visible(me, db.modules).filter((m) => (!b || m.brandId === b.id) && (!p || m.productId === p.id) && (!o.kind || m.kind === o.kind));
      if (asJson()) return info(JSON.stringify(rows, null, 2));
      info(
        table(
          rows.map((m) => ({
            코드: m.code,
            종류: KIND_LABEL[m.kind],
            제품: `${db.brands.find((x) => x.id === m.brandId)?.code}/${db.products.find((x) => x.id === m.productId)?.code}`,
            길이: effectiveDuration(m),
            음성: m.voiceover ? m.voiceover.provider : '',
            자막: m.captions ? m.captions.source : '',
            태그: Object.values(m.tags).filter(Boolean),
            호환: m.compatTags,
            심의: m.review,
            범위: scopeLabel(m.scope),
            소유자: nameOf(db, m.ownerId),
            대사: m.transcript,
          })),
        ),
      );
    }),
  );
mod
  .command('review <code> <decision>')
  .description('심의 상태 변경 (관리자): approve | reject | pending')
  .requiredOption('--brand <code>')
  .requiredOption('--product <code>')
  .option('--note <text>')
  .action((code, decision, o) =>
    act(({ db, me }) => {
      const map: Record<string, any> = { approve: 'approved', reject: 'rejected', pending: 'pending' };
      if (!map[decision]) throw new Error('approve | reject | pending 중 하나');
      const b = findBrand(db, o.brand);
      const p = findProduct(db, b, o.product);
      const codes = code === 'all' ? db.modules.filter((m) => m.brandId === b.id && m.productId === p.id && m.review === 'pending').map((m) => m.code) : list(code)!;
      for (const c of codes) {
        const m = findModule(db, me, b, p, c);
        setReview(db, me, m, map[decision], o.note);
        audit(db, me, 'module.review', m.id, `${m.code}=${map[decision]}`);
        ok(`${m.code} 심의 → ${map[decision]}`);
      }
    }),
  );
mod
  .command('promote <code>')
  .description('팀원 개인 모듈을 공통으로 올리기 (관리자)')
  .requiredOption('--brand <code>')
  .requiredOption('--product <code>')
  .action((code, o) =>
    act(({ db, me }) => {
      const b = findBrand(db, o.brand);
      const m = findModule(db, me, b, findProduct(db, b, o.product), code);
      promoteToCommon(me, m);
      audit(db, me, 'module.promote', m.id, m.code);
      ok(`${m.code} 공통으로 전환 (원래 소유자: ${nameOf(db, m.ownerId)})`);
    }),
  );

// ── 레퍼런스 ─────────────────────────────────────────────────────
const ref = program.command('reference').alias('ref').description('레퍼런스 (관리자 등록 = 공통, 팀원 등록 = 개인)');
tagOpts(
  ref
    .command('add')
    .requiredOption('--title <title>')
    .option('--url <url>')
    .option('--file <file>', '레퍼런스 영상 파일')
    .option('--source <source>', '출처 (스니핏, 메타 광고 라이브러리 등)')
    .option('--run-days <n>', '광고 게재 일수 (효율 추정 지표)')
    .option('--transcript <text>')
    .option('--notes <text>')
    .option('--brand <code>', '특정 브랜드 전용으로 묶기'),
).action((o) =>
  act(({ w, db, me }) => {
    const r = addReference(w, db, me, {
      title: o.title,
      url: o.url,
      file: o.file,
      source: o.source,
      runDays: o.runDays ? Number(o.runDays) : undefined,
      transcript: o.transcript,
      notes: o.notes,
      tags: tagsFrom(o),
      brandId: o.brand ? findBrand(db, o.brand).id : undefined,
    });
    audit(db, me, 'reference.add', r.id, r.title);
    ok(`레퍼런스 "${r.title}" 등록 (${r.scope === 'common' ? '공통: 모든 팀원에게 적용' : '개인: 본인만 보고 본인 생성에만 적용'}) · ID ${r.id}`);
  }),
);
ref
  .command('list')
  .option('--brand <code>')
  .action((o) =>
    read(({ db, me }) => {
      const rows = listReferences(db, me, o.brand ? findBrand(db, o.brand) : undefined);
      if (asJson()) return info(JSON.stringify(rows, null, 2));
      info(table(rows.map((r) => ({ 제목: r.title, 범위: scopeLabel(r.scope), 소유자: nameOf(db, r.ownerId), 게재일수: r.runDays, 태그: Object.values(r.tags).filter(Boolean), 출처: r.source, ID: r.id }))));
    }),
  );
ref
  .command('promote <id>')
  .description('팀원 개인 레퍼런스를 공통으로 올리기 (관리자)')
  .action((id) =>
    act(({ db, me }) => {
      const r = db.references.find((x) => x.id === id);
      if (!r || !canSee(me, r)) throw new Error(`레퍼런스 ${id}를 찾을 수 없어요.`);
      promoteToCommon(me, r);
      audit(db, me, 'reference.promote', r.id);
      ok(`"${r.title}" 공통으로 전환 (원래 소유자: ${nameOf(db, r.ownerId)})`);
    }),
  );
ref
  .command('context')
  .description('대본·후킹 생성에 적용되는 레퍼런스 묶음 (Claude 스킬이 읽는 형식)')
  .option('--brand <code>')
  .action((o) =>
    read(({ w, db, me }) => {
      const ctx = generationContext(w, db, me, o.brand ? findBrand(db, o.brand) : undefined);
      info(asJson() ? JSON.stringify({ ...ctx, taxonomy: undefined }, null, 2) : contextToMarkdown(ctx, db));
    }),
  );

// ── 배치 ─────────────────────────────────────────────────────────
const batch = program.command('batch').description('배치 = 목적을 정해 만든 조합 묶음');
batch
  .command('create')
  .requiredOption('--brand <code>')
  .requiredOption('--product <code>')
  .option('--mode <mode>', 'hook-test | offer-test | story-test | full', 'hook-test')
  .option('--length <sec>', '목표 길이 15 | 30 | 60', '30')
  .option('--aspects <list>', '비율 916,45,11,169', '916')
  .option('--hooks <codes>', '쓸 후킹 (비우면 볼 수 있는 후킹 전부)')
  .option('--bridge <codes>', '브릿지 (비우면 브릿지 없음)')
  .option('--stories <codes>')
  .option('--offers <codes>')
  .option('--max <n>', '조합 상한', '200')
  .option('--name <name>')
  .action((o) =>
    act(({ w, db, me }) => {
      const b = findBrand(db, o.brand);
      const p = findProduct(db, b, o.product);
      const { batch: bt, combos } = createBatch(w, db, me, b, p, {
        mode: o.mode as BatchMode,
        name: o.name,
        targetLength: Number(o.length) as 15 | 30 | 60,
        aspects: list(o.aspects) as Aspect[],
        hooks: list(o.hooks),
        bridges: list(o.bridge),
        stories: list(o.stories),
        offers: list(o.offers),
        maxCombos: Number(o.max),
      });
      audit(db, me, 'batch.create', bt.id, bt.name);
      const valid = combos.filter((c) => c.valid).length;
      ok(`배치 ${bt.name} 생성 · 조합 ${combos.length}개 중 ${valid}개 통과 · 상태 ${bt.status}${bt.status === 'draft' ? ' (관리자 승인 필요)' : ''}`);
      printCombos(db, bt.id);
    }),
  );
batch.command('list').action(() =>
  read(({ db, me }) =>
    info(
      table(
        visible(me, db.batches).map((b) => {
          const cs = db.combinations.filter((c) => c.batchId === b.id);
          return { 배치: b.name, 모드: b.mode, 길이: b.targetLength, 비율: b.aspects, 조합: `${cs.filter((c) => c.valid).length}/${cs.length}`, 상태: b.status, 버전: b.version, 범위: scopeLabel(b.scope), 만든사람: nameOf(db, b.ownerId) };
        }),
      ),
    ),
  ),
);
batch
  .command('show <batch>')
  .description('조합별 검사 결과')
  .action((key) =>
    read(({ db, me }) => {
      const b = findBatch(db, me, key);
      info(`${b.name} · ${b.mode} · ${b.targetLength}초 · 비율 ${b.aspects.join(',')} · 상태 ${b.status} · v${b.version}`);
      info(`오퍼: ${JSON.stringify(b.offerOverride)}`);
      printCombos(db, b.id);
    }),
  );
batch
  .command('approve <batch>')
  .description('팀원 배치 승인 (관리자)')
  .action((key) =>
    act(({ db, me }) => {
      const b = findBatch(db, me, key);
      approveBatch(db, me, b);
      audit(db, me, 'batch.approve', b.id);
      ok(`${b.name} 승인`);
    }),
  );
batch
  .command('offer <batch>')
  .description('배치 오퍼 데이터 변경 → 버전 +1 (다시 렌더링하면 새 버전 소재)')
  .argument('<pairs...>')
  .action((key, pairs) =>
    act(({ db, me }) => {
      const b = findBatch(db, me, key);
      updateBatchOffer(db, me, b, parseOffer(pairs));
      audit(db, me, 'batch.offer', b.id, JSON.stringify(b.offerOverride));
      ok(`${b.name} 오퍼 변경 → v${b.version} · ${JSON.stringify(b.offerOverride)} · 상태 ${b.status}`);
    }),
  );
batch
  .command('export <batch>')
  .description('조합 목록 CSV (엑셀·구글 시트용)')
  .option('--out <file>')
  .action((key, o) =>
    read(({ w, db, me }) => {
      const b = findBatch(db, me, key);
      const brandRec = db.brands.find((x) => x.id === b.brandId)!;
      const prod = db.products.find((x) => x.id === b.productId)!;
      const out = o.out ?? path.join(w.renderDir(brandRec, prod, b.name), `${b.name}_조합목록.csv`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, batchCsv(db, b));
      ok(`CSV 저장: ${w.rel(path.resolve(out))}`);
    }),
  );

function printCombos(db: DB, batchId: string) {
  const code = (id: string | null) => (id ? db.modules.find((m) => m.id === id)?.code : 'B000');
  const mark = (s?: string) => (s === 'pass' ? 'O' : s === 'warn' ? '△' : s === 'fail' ? 'X' : '');
  const rows = db.combinations
    .filter((c) => c.batchId === batchId)
    .map((c) => {
      const ck = (n: string) => c.checks.find((x) => x.name === n);
      const why = c.checks.filter((x) => x.status !== 'pass').map((x) => x.detail).join(' / ');
      return { 조합: c.comboCode, 길이: c.durationSec, 호환: mark(ck('compat')?.status), 심의: mark(ck('review')?.status), 길이검사: mark(ck('length')?.status), 다양성: mark(ck('diversity')?.status), 결과: c.valid ? '통과' : '제외', 이유: why };
    });
  info(table(rows));
}

// ── 렌더링 ───────────────────────────────────────────────────────
program
  .command('render <batch>')
  .description('배치를 렌더 대기열에 넣기 (실제 렌더링은 `ame worker`)')
  .option('--limit <n>', '앞에서부터 N개 조합만 (시험용)')
  .option('--now', '대기열에 넣고 바로 이 컴퓨터에서 렌더링')
  .action(async (key, o) => {
    const res = act(({ db, me }) => {
      const b = findBatch(db, me, key);
      if (o.limit) {
        // 앞쪽 N개만 남기고 나머지 통과 조합은 이번 렌더에서 건너뛴다
        const keep = new Set(db.combinations.filter((c) => c.batchId === b.id && c.valid).slice(0, Number(o.limit)).map((c) => c.id));
        const saved = db.combinations.filter((c) => c.batchId === b.id && c.valid && !keep.has(c.id));
        saved.forEach((c) => (c.valid = false));
        try {
          return { b, ...enqueueBatch(db, me, b) };
        } finally {
          saved.forEach((c) => (c.valid = true));
        }
      }
      const r = enqueueBatch(db, me, b);
      audit(db, me, 'render.enqueue', b.id, `${r.created.length}건`);
      return { b, ...r };
    });
    ok(`${res.b.name}: 렌더 작업 ${res.created.length}건 대기열 등록${res.skipped ? ` (이미 있는 ${res.skipped}건 제외)` : ''}`);
    if (o.now) {
      const { runWorker } = await import('../render/worker.js');
      const r = await runWorker(needWs(), { batchId: res.b.id });
      ok(`렌더링 끝: 완료 ${r.done} · 실패 ${r.failed}`);
    } else info('  렌더링 시작: ame worker');
  });

program
  .command('worker')
  .description('렌더 작업자 실행 (대기열이 빌 때까지 처리)')
  .option('--once', '작업 하나만 처리')
  .option('--batch <batch>', '이 배치 작업만')
  .action(async (o) => {
    const w = needWs();
    const batchId = o.batch ? findBatch(w.store.read(), w.currentAccount(w.store.read(), program.opts().as), o.batch).id : undefined;
    const { runWorker } = await import('../render/worker.js');
    const r = await runWorker(w, { once: o.once, batchId });
    ok(`작업자 종료: 완료 ${r.done} · 실패 ${r.failed}`);
  });

program
  .command('jobs')
  .description('렌더 작업 상태')
  .option('--batch <batch>')
  .action((o) =>
    read(({ db, me }) => {
      const b = o.batch ? findBatch(db, me, o.batch) : undefined;
      const rows = jobsVisible(db, me).filter((j) => !b || j.batchId === b.id);
      info(table(rows.map((j) => ({ 소재코드: j.materialCode, 상태: j.status, 파일: j.output ?? '', 오류: j.error ?? '', 소유자: nameOf(db, j.ownerId) }))));
    }),
  );

// ── 음성 (TTS · 음성 맞춤 자막) ──────────────────────────────────
const voice = program.command('voice').description('음성: TTS 제공자 설정·비교, Whisper 설치');
const tierLabel: Record<string, string> = { free: '무료', 'free-quota': '무료 한도', paid: '유료', test: '시험용' };

voice
  .command('providers')
  .description('TTS 제공자 목록과 준비 상태 (무료 → 유료 전환은 voice set)')
  .action(async () => {
    const { PROVIDERS } = await import('../voice/providers.js');
    const { whisper } = await import('../voice/whisper.js');
    info(
      table(
        PROVIDERS.map((p) => {
          const a = p.available();
          return { 제공자: p.id, 이름: p.label, 종류: tierLabel[p.tier], 상태: a.ok ? '사용 가능' : `준비 필요: ${a.reason}`, 기본목소리: p.defaultVoice || '(지정 필요)', 필요한설정: p.env.join(', ') };
        }),
      ),
    );
    const { whisperModel } = await import('../voice/whisper.js');
    const w = whisper.available();
    info(`\n자막 타이밍 (Whisper, 무료, 모델 ${whisperModel()}): ${w.ok ? '사용 가능' : `준비 필요: ${w.reason}`}`);
    info('\n준비 방법');
    for (const p of PROVIDERS) if (p.tier !== 'test') info(`  ${p.id}: ${p.note}`);
  });

voice
  .command('set')
  .description('브랜드 음성 설정 (관리자). 예: 무료로 쓰다가 --provider elevenlabs 로 바꾸기')
  .requiredOption('--brand <code>')
  .option('--provider <id>', 'auto | melotts | macos-say | google | azure | elevenlabs')
  .option('--voice <name>', '목소리 (제공자마다 다름: google ko-KR-Neural2-A, azure ko-KR-SunHiNeural, elevenlabs Voice ID)')
  .option('--speed <n>', '말 빠르기 (1.0 = 보통)')
  .option('--aligner <a>', '자막 타이밍: auto | whisper | estimate')
  .option('--original-volume <n>', '내레이션을 넣을 때 원래 영상 소리 크기 0~1 (기본 0.15)')
  .action(async (o) => {
    const { getProvider } = await import('../voice/providers.js');
    if (o.provider && o.provider !== 'auto') getProvider(o.provider);
    act(({ db, me }) => {
      requireAdmin(me, '음성 설정 변경');
      const b = findBrand(db, o.brand);
      const prev = b.voice ?? { provider: 'auto' };
      const providerChanged = o.provider && o.provider !== prev.provider;
      b.voice = {
        ...prev,
        ...(o.provider ? { provider: o.provider } : {}),
        // 제공자를 바꾸면 이전 제공자의 목소리 이름은 맞지 않으므로 지운다
        ...(providerChanged && !o.voice ? { voice: undefined } : {}),
        ...(o.voice ? { voice: o.voice } : {}),
        ...(o.speed ? { speed: Number(o.speed) } : {}),
        ...(o.aligner ? { aligner: o.aligner } : {}),
        ...(o.originalVolume !== undefined ? { originalAudioVolume: Number(o.originalVolume) } : {}),
      };
      audit(db, me, 'brand.voice', b.id, JSON.stringify(b.voice));
      ok(`${b.code} 음성 설정: ${JSON.stringify(b.voice)}`);
      if (providerChanged) info('  이미 만든 내레이션은 그대로예요. 새 제공자로 다시 만들려면: ame module voice all --brand ... --product ... --force');
    });
  });

voice
  .command('sample <text>')
  .description('같은 문장을 여러 제공자로 만들어 품질 비교 (작업 공간 voice-samples/)')
  .option('--providers <ids>', '비교할 제공자 (기본: 지금 쓸 수 있는 것 전부)')
  .option('--voice <name>')
  .action(async (text, o) => {
    const w = needWs();
    const { PROVIDERS, getProvider, normalizeAudio, tmpBase } = await import('../voice/providers.js');
    const ids = list(o.providers) ?? PROVIDERS.filter((p) => p.tier !== 'test' && p.available().ok).map((p) => p.id);
    if (!ids.length) throw new Error('쓸 수 있는 제공자가 없어요. `ame voice providers`로 준비 방법을 확인하세요.');
    const dir = path.join(w.root, 'voice-samples');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    for (const id of ids) {
      const p = getProvider(id);
      try {
        const r = await p.synthesize(text, { voice: o.voice ?? p.defaultVoice, outFile: tmpBase('sample') });
        const out = path.join(dir, `${stamp}_${id}.m4a`);
        normalizeAudio(r.rawFile, out);
        ok(`${p.label}: ${w.rel(out)}`);
      } catch (e: any) {
        warn(`${p.label}: ${e.message}`);
      }
    }
  });

voice
  .command('setup-whisper')
  .description('무료 자막 타이밍(Whisper) 설치: whisper.cpp + 모델 다운로드 (이 컴퓨터에서 한 번, 맥·윈도우 공통)')
  .option('--model <name>', 'large-v3-turbo(기본, 약 1.6GB) | medium | small(약 470MB, 저사양 PC) | base | tiny')
  .action(async (o) => {
    const { setupWhisper } = await import('../voice/whisper.js');
    await setupWhisper({ model: o.model, log: (s) => info(s) });
  });

const voiceTargets = (db: DB, me: Account, o: any, codes: string) => {
  const b = findBrand(db, o.brand);
  const p = findProduct(db, b, o.product);
  const mods = codes === 'all'
    ? db.modules.filter((m) => m.brandId === b.id && m.productId === p.id && canSee(me, m) && m.transcript.trim())
    : list(codes)!.map((c) => findModule(db, me, b, p, c));
  return { b, p, mods };
};

mod
  .command('voice <codes>')
  .description('모듈 대사로 TTS 내레이션 만들기 + 음성에 맞춘 자막 (codes: H001,H002 또는 all)')
  .requiredOption('--brand <code>')
  .requiredOption('--product <code>')
  .option('--provider <id>', '이번만 다른 제공자로')
  .option('--voice <name>')
  .option('--speed <n>')
  .option('--force', '이미 있어도 다시 만들기')
  .action(async (codes, o) => {
    const w = needWs();
    const db = w.store.read();
    const me = w.currentAccount(db, program.opts().as);
    const { generateVoiceover, applyVoiceResult } = await import('../voice/service.js');
    const { b, mods } = voiceTargets(db, me, o, codes);
    let n = 0;
    let failed = 0;
    for (const m of mods) {
      if (!o.force && m.voiceover && m.voiceover.text === m.transcript.trim()) {
        info(`· ${m.code} 이미 있음 (${m.voiceover.provider}) — 다시 만들려면 --force`);
        continue;
      }
      try {
        const r = await generateVoiceover(w, db, me, b, m, { provider: o.provider, voice: o.voice, speed: o.speed ? Number(o.speed) : undefined });
        w.store.transact((d) => {
          applyVoiceResult(d, m.id, r);
          audit(d, me, 'module.voice', m.id, `${r.voiceover!.provider}/${r.captions.source}`);
        });
        n++;
        ok(`${m.code} 내레이션 ${r.voiceover!.durationSec.toFixed(1)}초 (${r.voiceover!.provider}, 목소리 ${r.voiceover!.voice || '기본'}) · 자막 ${r.captions.cues.length}개 (${r.captions.source})`);
        r.warnings.forEach((x) => info(`    ⚠ ${x}`));
      } catch (e: any) {
        failed++;
        warn(`${m.code}: ${e.message}`);
      }
    }
    info(`완료 ${n}/${mods.length}`);
    if (failed) process.exitCode = 1;
  });

mod
  .command('align <codes>')
  .description('영상에 이미 있는 말소리(촬영본)에 자막 타이밍 맞추기 (Whisper)')
  .requiredOption('--brand <code>')
  .requiredOption('--product <code>')
  .action(async (codes, o) => {
    const w = needWs();
    const db = w.store.read();
    const me = w.currentAccount(db, program.opts().as);
    const { alignOriginal, applyVoiceResult } = await import('../voice/service.js');
    const { b, mods } = voiceTargets(db, me, o, codes);
    for (const m of mods) {
      try {
        const r = await alignOriginal(w, me, b, m);
        w.store.transact((d) => applyVoiceResult(d, m.id, r));
        ok(`${m.code} 자막 ${r.captions.cues.length}개 (${r.captions.source})`);
        r.warnings.forEach((x) => info(`    ⚠ ${x}`));
      } catch (e: any) {
        process.exitCode = 1;
        warn(`${m.code}: ${e.message}`);
      }
    }
  });

// ── 설정 보기·도구 ───────────────────────────────────────────────
program
  .command('taxonomy')
  .description('분류 체계 보기 (기본 + 조직 + 브랜드 덮어쓰기)')
  .option('--brand <code>')
  .action((o) => {
    const w = needWs();
    const db = w.store.read();
    const t = loadTaxonomy(w, o.brand ? findBrand(db, o.brand) : undefined);
    if (asJson()) return info(JSON.stringify(t, null, 2));
    for (const [axis, def] of Object.entries(t)) info(`${def.label} (${axis}): ${Object.entries(def.values).map(([k, v]) => `${v}=${k}`).join(', ') || '(브랜드에서 정의)'}`);
  });

program
  .command('rulepack')
  .description('규칙 팩 목록')
  .action(() => info(listRulePacks(ws()).join('\n')));

program
  .command('dummy <outDir>')
  .description('시험용 더미 클립 세트 생성 (가상 브랜드 DEMO/글로우 세럼, 15초용)')
  .action(async (outDir) => {
    const { makeDemoSet } = await import('../tools/dummy.js');
    const files = makeDemoSet(path.resolve(outDir));
    ok(`더미 클립 ${files.length}개 생성: ${outDir}`);
  });

program.parseAsync().catch((e: any) => {
  console.error(`✖ ${e?.message ?? e}`);
  process.exit(1);
});
