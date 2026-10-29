#!/usr/bin/env node
/**
 * 데모: 더미 클립으로 엔진 전체를 처음부터 끝까지 돌린다. 맥·윈도우·리눅스 공통.
 *
 *   npm run demo                          렌더링 포함 (2개 조합 × 2비율 + 가격 변경 + 내레이션 버전)
 *   npm run demo -- --quick               렌더링 최소 (9:16 1편 + 내레이션 버전 1편)
 *   npm run demo -- --no-render           렌더링 없이 흐름만
 *   npm run demo -- --voice auto          실제 무료 TTS로 내레이션 (맥 내장 / 윈도우 내장 / MeloTTS / 키가 있으면 구글·애저)
 *   npm run demo -- --workspace <폴더>     작업 공간 위치 (기본 ./demo-workspace)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const WS = path.resolve(opt('--workspace', process.env.DEMO_WS ?? path.join(ROOT, 'demo-workspace')));
const RENDER = !flag('--no-render') && process.env.RENDER_LIMIT !== '0';
const QUICK = flag('--quick');
const VOICE = opt('--voice', process.env.VOICE_PROVIDER ?? 'mock');

function ame(...a) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ame.mjs'), '-w', WS, ...a], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✖ 실패: ame ${a.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}
const step = (s) => console.log(`\n━━ ${s}`);

fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

step('1. 조직과 계정');
ame('init', '--org', '데모 마케팅본부', '--admin', '후빈');
ame('account', 'create', '--name', '팀원A', '--role', 'member');
ame('account', 'create', '--name', '팀원B', '--role', 'member');
ame('account', 'create', '--name', '팀장님', '--role', 'admin');

step('2. 브랜드·제품 (가상 브랜드)');
ame('brand', 'create', '--code', 'DEMO', '--name', '데모 코스메틱', '--industry', '화장품(예시)', '--rulepack', 'example');
ame('product', 'create', '--brand', 'DEMO', '--code', 'SERUM', '--name', '글로우 세럼',
  '--offer', 'price=39000', 'originalPrice=59000', 'headline=첫 구매 특가', 'deadline=11월30일', 'gift=미니어처', 'cta=지금 구매하기');

step('3. 더미 클립 → 모듈 폴더에 넣고 한 번에 등록');
const incoming = path.join(WS, '_incoming');
ame('dummy', incoming);
for (const k of ['hook', 'bridge', 'story', 'offer']) {
  const dest = path.join(WS, 'brands', 'DEMO', 'SERUM', 'modules', k);
  for (const f of fs.readdirSync(path.join(incoming, k))) fs.copyFileSync(path.join(incoming, k, f), path.join(dest, f));
}
ame('module', 'scan', '--brand', 'DEMO', '--product', 'SERUM');
ame('module', 'review', 'all', 'approve', '--brand', 'DEMO', '--product', 'SERUM');
ame('module', 'list', '--brand', 'DEMO', '--product', 'SERUM');

step('4. 레퍼런스: 관리자 = 공통, 팀원 = 개인');
ame('reference', 'add', '--title', '건조함 역설 후킹 (경쟁사)', '--source', '스니핏', '--run-days', '45', '--hook-type', 'paradox', '--story-type', 'problem-first', '--offer-type', 'discount');
ame('--as', '팀원A', 'reference', 'add', '--title', '팀원A가 찾은 질문형 후킹', '--source', '메타 광고 라이브러리', '--run-days', '30', '--hook-type', 'question');
console.log('· 팀원B가 보는 레퍼런스 (팀원A 것은 안 보여야 함)');
ame('--as', '팀원B', 'reference', 'list');
console.log('· 관리자가 보는 레퍼런스 (전부)');
ame('reference', 'list');

step('5. 배치: 후킹 테스트 (스토리·오퍼 고정, 후킹 전부)');
ame('batch', 'create', '--brand', 'DEMO', '--product', 'SERUM', '--mode', 'hook-test', '--length', '15',
  '--aspects', QUICK ? '916' : '916,45', '--bridge', 'B001', '--stories', 'S001', '--offers', 'O001', '--name', 'demo_hooktest');

step('6. 팀원 배치 = 승인 대기 → 관리자 승인');
ame('--as', '팀원A', 'batch', 'create', '--brand', 'DEMO', '--product', 'SERUM', '--mode', 'full', '--length', '15', '--aspects', '916',
  '--hooks', 'H003,H004,H005,H006', '--stories', 'S001,S002', '--offers', 'O001,O002', '--name', 'a_full');
ame('--as', '팀원B', 'batch', 'list');
ame('batch', 'approve', 'a_full');

if (RENDER) {
  step(`7. 렌더링 (${QUICK ? '1개 조합 × 9:16' : '앞 2개 조합 × 2비율'})`);
  ame('render', 'demo_hooktest', '--limit', QUICK ? '1' : '2', '--now');
  if (!QUICK) {
    step('8. 가격 변경 → v2 재렌더링');
    ame('batch', 'offer', 'demo_hooktest', 'price=29000', 'headline=오늘만 특가');
    ame('render', 'demo_hooktest', '--limit', '1', '--now');
  }
  ame('jobs', '--batch', 'demo_hooktest');
}

step(`9. 음성: 내레이션 + 음성에 맞춘 자막 (제공자: ${VOICE})`);
ame('voice', 'providers');
ame('voice', 'set', '--brand', 'DEMO', '--provider', VOICE);
ame('module', 'voice', 'H003,B001,S001,O001', '--brand', 'DEMO', '--product', 'SERUM');
ame('batch', 'create', '--brand', 'DEMO', '--product', 'SERUM', '--mode', 'hook-test', '--hooks', 'H003', '--bridge', 'B001',
  '--stories', 'S001', '--offers', 'O001', '--length', '15', '--aspects', '916', '--name', 'demo_voice');
if (RENDER) ame('render', 'demo_voice', '--now');

ame('batch', 'export', 'demo_hooktest');
ame('team');
console.log(`\n━━ 완료: ${WS}`);
