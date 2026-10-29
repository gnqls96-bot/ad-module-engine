import { describe, expect, it } from 'vitest';
import { cuesFromTimings, estimateCues, timeScriptChars, wordsToChars } from '../src/voice/align';
import { effectiveDuration } from '../src/core/types';
import { PROVIDERS, resolveProvider } from '../src/voice/providers';

const script = '세안 후 바로 세럼을 바르면 수분이 날아가요. 토너로 결을 정돈하고 세 방울만 눌러 바르세요.';

// Whisper가 띄어쓰기를 다르게 하고, "세 방울"을 "3방울"로, "정돈"을 "정돌"로 잘못 들은 상황
const whisperWords = [
  { text: '세안후', start: 0.2, end: 0.7 },
  { text: '바로', start: 0.7, end: 1.0 },
  { text: '세럼을', start: 1.0, end: 1.5 },
  { text: '바르면', start: 1.5, end: 1.9 },
  { text: '수분이', start: 1.9, end: 2.4 },
  { text: '날아가요.', start: 2.4, end: 3.0 },
  { text: '토너로', start: 3.5, end: 4.0 },
  { text: '결을', start: 4.0, end: 4.3 },
  { text: '정돌하고', start: 4.3, end: 4.9 },
  { text: '3방울만', start: 4.9, end: 5.5 },
  { text: '눌러', start: 5.5, end: 5.9 },
  { text: '바르세요.', start: 5.9, end: 6.6 },
];

describe('대본 ↔ 음성 타이밍 맞추기', () => {
  it('단어 시간을 글자 단위로 펼친다 (문장부호 제외)', () => {
    const c = wordsToChars([{ text: '바로.', start: 1, end: 2 }]);
    expect(c.map((x) => x.text)).toEqual(['바', '로']);
    expect(c[1].start).toBeCloseTo(1.5);
  });

  it('받아쓰기가 대본과 조금 달라도 대본 글자마다 시간이 매겨진다', () => {
    const times = timeScriptChars(script, wordsToChars(whisperWords), 7);
    const kept = times.filter((t) => t !== null) as number[];
    expect(kept.length).toBe([...script].filter((c) => /[\p{L}\p{N}]/u.test(c)).length);
    for (let i = 1; i < kept.length; i++) expect(kept[i]).toBeGreaterThanOrEqual(kept[i - 1] - 1e-9);
  });

  it('자막은 대본 원문 글자 그대로, 시간은 실제 말한 시점', () => {
    const cues = cuesFromTimings(script, wordsToChars(whisperWords), 7, 16);
    expect(cues.map((c) => c.text).join(' ')).toContain('세 방울만'); // 오인식(3방울)이 자막에 안 들어감
    expect(cues[0].start).toBeCloseTo(0.2, 1); // 첫 말 시작에 맞춤
    const second = cues.find((c) => c.text.startsWith('토너로'))!;
    expect(second.start).toBeGreaterThan(3.3); // 문장 사이 쉼(3.0~3.5초) 뒤에 시작
    expect(second.start).toBeLessThan(3.7);
    for (const c of cues) expect(c.end).toBeLessThanOrEqual(7);
  });

  it('타이밍 정보가 없으면 글자 수로 추정하고, 합이 전체 길이와 같다', () => {
    const cues = estimateCues(script, 6, 16);
    expect(cues.at(-1)!.end).toBeCloseTo(6, 2);
  });
});

describe('음성 길이와 조합 길이', () => {
  const media = { durationSec: 3, width: 1080, height: 1920, fps: 30, hasAudio: true };
  it('내레이션이 영상보다 길면 내레이션 길이로 늘어난다', () => {
    expect(effectiveDuration({ media })).toBe(3);
    expect(effectiveDuration({ media, voiceover: { durationSec: 4, file: '', provider: '', voice: '', text: '', createdAt: '' } })).toBe(4.25);
  });
});

describe('제공자', () => {
  it('무료·무료 한도·유료가 모두 있고, 유료는 자동 선택 대상이 아니다', () => {
    const tiers = new Set(PROVIDERS.map((p) => p.tier));
    expect(tiers.has('free') && tiers.has('free-quota') && tiers.has('paid')).toBe(true);
    const save = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'x';
    try {
      const p = (() => {
        try {
          return resolveProvider('auto');
        } catch {
          return null;
        }
      })();
      expect(p?.id).not.toBe('elevenlabs');
    } finally {
      if (save === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = save;
    }
  });
  it('키 없이 유료 제공자를 지정하면 준비 방법을 알려준다', () => {
    const save = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    expect(() => resolveProvider('elevenlabs')).toThrow(/ELEVENLABS_API_KEY/);
    if (save !== undefined) process.env.ELEVENLABS_API_KEY = save;
  });
});
