import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapAdmin, createAccount } from '../src/core/access';
import { addReference, findBySha } from '../src/core/references';
import { scanReferenceFolder, transcriptIssues } from '../src/core/ingest';
import { mergeFrames, similarity } from '../src/ocr/service';
import { Workspace } from '../src/core/workspace';
import { EMPTY_DB } from '../src/core/types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ame-ref-'));

describe('레퍼런스 일괄 등록', () => {
  it('하위 폴더 = 카테고리, 영상·이미지만, 숨김 파일 제외', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '뷰티'));
    fs.writeFileSync(path.join(root, '뷰티', 'a.mp4'), 'v');
    fs.writeFileSync(path.join(root, '뷰티', 'b.webp'), 'i');
    fs.writeFileSync(path.join(root, '뷰티', '.DS_Store'), 'x');
    fs.writeFileSync(path.join(root, '뷰티', 'memo.txt'), 'x');
    fs.writeFileSync(path.join(root, '뷰티', '.c.mp4.icloud'), 'x');
    const found = scanReferenceFolder(root);
    expect(found.map((f) => [path.basename(f.file), f.category, f.kind, f.cloudOnly])).toEqual([
      ['c.mp4', '뷰티', 'video', true],
      ['a.mp4', '뷰티', 'video', false],
      ['b.webp', '뷰티', 'image', false],
    ]);
  });

  it('원본 이름 그대로 복사하고, 이름이 달라도 내용이 같으면 중복', () => {
    const src = tmp();
    const ws = new Workspace(tmp());
    const db = EMPTY_DB();
    const admin = bootstrapAdmin(db, '후빈');
    const member = createAccount(db, admin, '팀원A', 'member');
    fs.writeFileSync(path.join(src, '원본 이름 (1).mp4'), 'same');
    fs.writeFileSync(path.join(src, '다른 이름.mp4'), 'same');
    const r = addReference(ws, db, admin, { title: 't', file: path.join(src, '원본 이름 (1).mp4'), transcriptData: { words: [] } });
    expect(path.basename(r.file!)).toBe('원본 이름 (1).mp4');
    expect(fs.existsSync(path.join(src, '원본 이름 (1).mp4'))).toBe(true);
    expect(fs.existsSync(ws.abs(r.transcriptFile!))).toBe(true);
    expect(r.scope).toBe('common');
    expect(() => addReference(ws, db, admin, { title: 't2', file: path.join(src, '다른 이름.mp4') })).toThrow(/이미 등록/);
    expect(findBySha(db, member, r.sha256!)?.id).toBe(r.id);
  });

  it('받아쓰기 이상 감지', () => {
    const media = { durationSec: 30, hasAudio: true };
    const speech = Array.from({ length: 60 }, (_, i) => ({ text: `단어${i}번째`, start: i * 0.5, end: i * 0.5 + 0.4, p: 0.9 }));
    expect(transcriptIssues(speech, media)).toEqual([]);
    expect(transcriptIssues([], media)[0]).toMatch(/말소리 없음/);
    expect(transcriptIssues([{ text: '음악', start: 1, end: 2, p: 0.3 }], media).join()).toMatch(/말이 거의 없음.*확신도 낮음/s);
    const loop = Array.from({ length: 8 }, (_, i) => ({ text: '감사합니다', start: i * 3, end: i * 3 + 1, p: 0.8 }));
    expect(transcriptIssues(loop, media).join()).toMatch(/같은 말 반복/);
    expect(transcriptIssues([{ text: '다음', start: 1, end: 1.5, p: 0.6 }, { text: '영상에서', start: 1.5, end: 2, p: 0.6 }, { text: '만나요!', start: 2, end: 2.5, p: 0.6 }], media).join()).toMatch(/지어내는 문구/);
    expect(transcriptIssues(speech, { durationSec: 3, hasAudio: true }).join()).toMatch(/너무 짧음/);
  });

  it('화면 글자: 같은 문구가 이어지면 한 구간, 한 프레임 흔들림은 무시', () => {
    const L = (text: string, y = 0.1, h = 0.05) => ({ text, conf: 0.9, x: 0.1, y, w: 0.5, h });
    const frames = [
      [L('이거 모르면 손해'), L('자막 하나', 0.8, 0.02)],
      [L('이거 모르면 손해!'), L('자막 하나', 0.8, 0.02)],
      [L('이거 모르면 존해'), L('자막 둘', 0.8, 0.02)],
      [L('이거 모르면 손해')],
      [L('x')],
      [],
      [],
      [L('이거 모르면 손해')],
    ];
    const segs = mergeFrames(frames, 0.5, 4);
    // 한 프레임에만 보인 '자막 둘'과 마지막 '이거 모르면 손해'는 잡음으로 버림
    expect(segs.map((s) => [s.text, s.start, s.end])).toEqual([
      ['이거 모르면 손해', 0, 2],
      ['자막 하나', 0, 1],
    ]);
    expect(segs[0].size).toBe(0.05);
    expect(similarity('이거모르면손해', '이거모르면존해')).toBeGreaterThan(0.8);
    expect(similarity('자막하나', '자막둘')).toBeLessThan(0.8);
  });
});

describe('레퍼런스 구간·분류 분석', async () => {
  const { classifyScreenText, speechPhrases, validateResult } = await import('../src/analysis/service');
  const { loadTaxonomy } = await import('../src/core/config');
  const words = [
    { text: '오늘', start: 0, end: 0.4 },
    { text: '소개할', start: 0.4, end: 0.9 },
    { text: '제품', start: 0.9, end: 1.3 },
    { text: '가격은', start: 3, end: 3.5 },
  ];
  const seg = (text: string, start: number, end: number, y: number, size: number) => ({ text, start, end, y, size });

  it('말은 쉬는 곳에서 끊는다', () => {
    expect(speechPhrases(words).map((p) => p.text)).toEqual(['오늘 소개할 제품', '가격은']);
  });

  it('화면 글자: 말 자막·주의 문구·포장 글자를 거르고 헤드라인은 남긴다', () => {
    const crowd = Array.from({ length: 8 }, (_, i) => seg(`성분표 줄 ${i}번`, 5, 6, 0.3 + i * 0.02, 0.03));
    const { kept, filtered } = classifyScreenText(
      [
        seg('오늘 소개할 제품', 0, 1.5, 0.7, 0.05),
        seg('개인차가 있을 수 있습니다', 0, 2, 0.95, 0.012),
        seg('개인차가 있을 수', 2.5, 6, 0.95, 0.012),
        seg('개인차가 있을 수 있습니다', 6.5, 10, 0.95, 0.012),
        seg('지금만 50% 할인', 0, 10, 0.15, 0.06),
        seg('딱 하루', 7, 8, 0.5, 0.05),
        ...crowd,
      ],
      words,
      10,
    );
    const reason = (t: string) => filtered.find((f) => f.text === t)?.reason;
    expect(reason('오늘 소개할 제품')).toBe('caption');
    expect(reason('개인차가 있을 수')).toBe('notice');
    expect(reason('성분표 줄 0번')).toBe('packaging');
    expect(kept.map((k) => [k.text, k.type])).toEqual([
      ['지금만 50% 할인', 'headline'],
      ['딱 하루', 'screen'],
    ]);
  });

  it('결과 검사: 분류 체계에 없는 값은 새 유형 후보로 적어야 통과', () => {
    const tax = loadTaxonomy(Workspace.resolve(tmp()));
    const r: any = { kind: 'video', media: { durationSec: 20 } };
    const base = { referenceId: 'x', hookText: 'h', risks: [], segments: [{ kind: 'hook', start: 0, end: 3 }] } as any;
    expect(validateResult({ ...base, tags: { hookType: 'pain' }, newTypes: [] }, r, tax)).toEqual([]);
    expect(validateResult({ ...base, tags: { hookType: 'brand-new' }, newTypes: [] }, r, tax)[0]).toMatch(/newTypes/);
    expect(validateResult({ ...base, tags: { hookType: 'brand-new' }, newTypes: [{ axis: 'hookType', value: 'brand-new', label: '새것', reason: '-' }] }, r, tax)).toEqual([]);
    expect(validateResult({ ...base, segments: [{ kind: 'offer', start: 0, end: 30 }], tags: {}, newTypes: [] }, r, tax).length).toBe(2);
  });
});
