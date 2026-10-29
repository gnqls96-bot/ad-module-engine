import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ModuleKind, ModuleTags } from '../core/types.js';

/**
 * 더미 클립 생성기.
 * 실제 촬영본 없이 엔진 전체를 시험하기 위한 가짜 모듈 영상을 만든다 (회사 자산을 쓰지 않기 위해).
 * 영상에는 종류·번호만 크게 찍고, 대사·태그는 .meta.json으로 함께 만든다. 자막은 렌더링 때 템플릿이 입힌다.
 */

interface DummySpec {
  kind: ModuleKind;
  name: string;
  seconds: number;
  color: string;
  label: string;
  transcript: string;
  tags: ModuleTags;
  compatTags: string[];
  excludeTags?: string[];
}

const COLORS: Record<ModuleKind, string[]> = {
  hook: ['0xE4572E', '0xF29E4C', '0xC44569', '0xF15BB5', '0x9B5DE5', '0xD7263D'],
  bridge: ['0x5C677D'],
  story: ['0x2E86AB', '0x00A6A6'],
  offer: ['0x2A9D8F', '0x3A5A40'],
};

/** 가상 브랜드 "DEMO / 글로우 세럼"용 기본 세트: 15초 목표 (후킹 2.5 + 브릿지 1.5 + 스토리 7.5 + 오퍼 3.5) */
export const DEMO_SET: DummySpec[] = [
  { kind: 'hook', name: 'paradox', seconds: 2.5, color: COLORS.hook[0], label: 'HOOK  paradox', transcript: '바를수록 더 건조해지는 이유, 알고 계셨나요?', tags: { hookType: 'paradox', visualType: 'selfcam' }, compatTags: ['topic:dryness'] },
  { kind: 'hook', name: 'mythbust', seconds: 2.5, color: COLORS.hook[1], label: 'HOOK  myth-bust', transcript: '세럼은 많이 바를수록 좋다? 완전히 반대예요.', tags: { hookType: 'myth-bust', visualType: 'interview' }, compatTags: ['topic:dryness'] },
  { kind: 'hook', name: 'secret', seconds: 2.5, color: COLORS.hook[2], label: 'HOOK  secret', transcript: '피부 관리실에서만 알려주는 보습 순서가 있어요.', tags: { hookType: 'secret', visualType: 'product-closeup' }, compatTags: ['topic:dryness'] },
  { kind: 'hook', name: 'question', seconds: 2.5, color: COLORS.hook[3], label: 'HOOK  question', transcript: '아침마다 화장이 들뜨는 분 계세요?', tags: { hookType: 'question', visualType: 'selfcam' }, compatTags: ['topic:dryness'] },
  { kind: 'hook', name: 'acne-pain', seconds: 2.5, color: COLORS.hook[4], label: 'HOOK  pain (acne)', transcript: '트러블 때문에 마스크를 못 벗는 분들 주목하세요.', tags: { hookType: 'pain', visualType: 'selfcam' }, compatTags: ['topic:acne'] },
  { kind: 'hook', name: 'blocked-claim', seconds: 2.5, color: COLORS.hook[5], label: 'HOOK  result-first', transcript: '3일 만에 건조함이 완치됐어요.', tags: { hookType: 'result-first', visualType: 'selfcam' }, compatTags: ['topic:dryness'] },
  { kind: 'bridge', name: 'tried-it', seconds: 1.5, color: COLORS.bridge[0], label: 'BRIDGE', transcript: '그래서 제가 직접 써봤어요.', tags: { visualType: 'motion-graphic' }, compatTags: [] },
  { kind: 'story', name: 'problem-first', seconds: 7.5, color: COLORS.story[0], label: 'STORY  problem-first', transcript: '세안 후 바로 세럼을 바르면 수분이 날아가요. 토너로 결을 정돈하고 세 방울만 눌러 바르세요. 다음 날 아침 화장이 달라져요.', tags: { storyType: 'problem-first', visualType: 'selfcam' }, compatTags: ['topic:dryness'] },
  { kind: 'story', name: 'testimonial', seconds: 7.5, color: COLORS.story[1], label: 'STORY  testimonial', transcript: '겨울만 되면 각질이 일어나서 고민이었어요. 이 세럼으로 바꾸고 2주째, 오후에도 당기지 않아요.', tags: { storyType: 'testimonial', visualType: 'interview' }, compatTags: ['topic:dryness'] },
  { kind: 'offer', name: 'discount', seconds: 3.5, color: COLORS.offer[0], label: 'OFFER  discount', transcript: '지금 첫 구매 할인 중이에요.', tags: { offerType: 'discount', visualType: 'product-closeup' }, compatTags: [] },
  { kind: 'offer', name: 'gift', seconds: 3.5, color: COLORS.offer[1], label: 'OFFER  gift', transcript: '이번 주까지 미니어처를 같이 드려요.', tags: { offerType: 'gift', visualType: 'product-closeup' }, compatTags: [] },
];

function findFont(): string | undefined {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    'C:/Windows/Fonts/arialbd.ttf',
  ];
  return candidates.find((f) => fs.existsSync(f));
}

export function makeDummyClip(out: string, spec: Pick<DummySpec, 'seconds' | 'color' | 'label'>, index: number, size = { w: 1080, h: 1920 }) {
  const font = findFont();
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const draw = font
    ? [
        `drawtext=fontfile='${esc(font)}':text='${esc(spec.label)}':fontsize=84:fontcolor=white:x=(w-tw)/2:y=h*0.36`,
        `drawtext=fontfile='${esc(font)}':text='%{eif\\:t\\:d\\:1}s':fontsize=56:fontcolor=white@0.8:x=(w-tw)/2:y=h*0.36+120`,
      ].join(',')
    : 'null';
  // 움직임이 보이도록 가로 띠가 흘러가게 한다
  const vf = `drawbox=x=0:y='mod(t*400\\,h)':w=iw:h=40:color=white@0.25:t=fill,${draw}`;
  execFileSync(
    'ffmpeg',
    [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${spec.color}:s=${size.w}x${size.h}:r=30:d=${spec.seconds}`,
      '-f', 'lavfi', '-i', `sine=f=${220 + index * 40}:d=${spec.seconds}`,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', out,
    ],
    { stdio: 'pipe' },
  );
}

/** outDir/{hook,bridge,story,offer}/ 에 더미 클립과 .meta.json 생성 */
export function makeDemoSet(outDir: string, set: DummySpec[] = DEMO_SET) {
  const files: string[] = [];
  set.forEach((spec, i) => {
    const dir = path.join(outDir, spec.kind);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${spec.kind}_${spec.name}.mp4`);
    makeDummyClip(file, spec, i);
    fs.writeFileSync(
      file.replace(/\.mp4$/, '.meta.json'),
      JSON.stringify({ kind: spec.kind, transcript: spec.transcript, tags: spec.tags, compatTags: spec.compatTags, excludeTags: spec.excludeTags ?? [] }, null, 2),
    );
    files.push(file);
  });
  return files;
}
