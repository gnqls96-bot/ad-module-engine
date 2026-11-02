import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapAdmin, createAccount } from '../src/core/access';
import { addReference, findBySha } from '../src/core/references';
import { scanReferenceFolder, transcriptIssues } from '../src/core/ingest';
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
});
