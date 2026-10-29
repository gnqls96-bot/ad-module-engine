import fs from 'node:fs';
import path from 'node:path';
import { Account, Brand, DB, Module, ModuleCaptions, Voiceover } from '../core/types.js';
import { Workspace } from '../core/workspace.js';
import { loadBrandKit } from '../core/config.js';
import { execFileSync } from 'node:child_process';
import { now } from '../core/store.js';
import { requireCanEdit } from '../core/access.js';
import { normalizeAudio, resolveProvider, tmpBase } from './providers.js';
import { whisper } from './whisper.js';
import { cuesFromTimings, estimateCues, wordsToChars } from './align.js';
import { Aligner, VoiceSettings } from './types.js';

/**
 * 모듈 단위 음성 작업.
 *   generateVoiceover: 모듈 대사 → TTS 내레이션 + 음성에 맞춘 자막
 *   alignOriginal    : 촬영본처럼 영상에 이미 말소리가 있으면, 그 소리에 자막을 맞춤
 * 모두 "읽기 → 비동기 작업 → 결과만 저장" 순서라, 작업 중 다른 명령이 데이터를 써도 충돌하지 않는다.
 */

export function voiceSettings(brand: Brand): Required<Pick<VoiceSettings, 'provider' | 'aligner' | 'originalAudioVolume'>> & VoiceSettings {
  return { provider: 'auto', aligner: 'auto', originalAudioVolume: 0.15, ...(brand.voice ?? {}) };
}

export function resolveAligner(choice: VoiceSettings['aligner']): Aligner | null {
  if (choice === 'estimate') return null;
  const a = whisper.available();
  if (choice === 'whisper' && !a.ok) throw new Error(`Whisper를 쓸 수 없어요: ${a.reason}`);
  return a.ok ? whisper : null;
}

export interface VoiceJobResult {
  code: string;
  voiceover?: Voiceover;
  captions: ModuleCaptions;
  warnings: string[];
}

export async function generateVoiceover(
  ws: Workspace,
  db: DB,
  actor: Account,
  brand: Brand,
  mod: Module,
  override: { provider?: string; voice?: string; speed?: number; aligner?: VoiceSettings['aligner'] } = {},
): Promise<VoiceJobResult> {
  requireCanEdit(actor, mod, '모듈');
  const text = mod.transcript.trim();
  if (!text) throw new Error(`${mod.code}: 대사(transcript)가 없어 음성을 만들 수 없어요.`);
  const vs = voiceSettings(brand);
  const provider = resolveProvider(override.provider ?? vs.provider);
  const voice = override.voice ?? vs.voice ?? provider.defaultVoice;
  const speed = override.speed ?? vs.speed ?? 1;

  const raw = await provider.synthesize(text, { voice, speed, outFile: tmpBase(mod.code) });
  const product = db.products.find((p) => p.id === mod.productId)!;
  const dir = path.join(ws.moduleDir(brand, product, mod.kind), 'voice');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${mod.code}_${provider.id}.m4a`);
  normalizeAudio(raw.rawFile, dest);
  fs.rmSync(path.dirname(raw.rawFile), { recursive: true, force: true });
  const durationSec = probeAudio(dest);

  const voiceover: Voiceover = { file: ws.rel(dest), provider: provider.id, voice, durationSec, text, createdAt: now() };
  const warnings: string[] = [];
  const extend = durationSec + 0.25 - mod.media.durationSec;
  if (extend > 0.05)
    warnings.push(`음성 ${durationSec.toFixed(1)}초 + 끝 여유 0.25초가 영상(${mod.media.durationSec}초)보다 길어서, 마지막 장면을 ${extend.toFixed(1)}초 멈춰 채웁니다`);

  const kit = loadBrandKit(brand);
  const total = Math.max(mod.media.durationSec, durationSec + 0.25);
  let captions: ModuleCaptions;
  if (raw.charTimings?.length) {
    // 일레븐랩스·시험용: TTS가 준 글자 타이밍을 바로 사용
    captions = { source: 'provider', audio: 'voiceover', text, cues: cuesFromTimings(text, raw.charTimings, total, kit.caption.maxCharsPerLine), createdAt: now() };
  } else {
    captions = await captionsFromAudio(ws.abs(voiceover.file), text, total, kit.caption.maxCharsPerLine, override.aligner ?? vs.aligner, 'voiceover', warnings);
  }
  return { code: mod.code, voiceover, captions, warnings };
}

export async function alignOriginal(ws: Workspace, actor: Account, brand: Brand, mod: Module, aligner?: VoiceSettings['aligner']): Promise<VoiceJobResult> {
  requireCanEdit(actor, mod, '모듈');
  const text = mod.transcript.trim();
  if (!text) throw new Error(`${mod.code}: 대사(transcript)가 없어요.`);
  if (!mod.media.hasAudio) throw new Error(`${mod.code}: 영상에 소리가 없어요. 내레이션은 \`ame module voice\`로 만드세요.`);
  const warnings: string[] = [];
  const kit = loadBrandKit(brand);
  const captions = await captionsFromAudio(ws.abs(mod.file), text, mod.media.durationSec, kit.caption.maxCharsPerLine, aligner ?? voiceSettings(brand).aligner, 'original', warnings);
  return { code: mod.code, captions, warnings };
}

async function captionsFromAudio(
  audioFile: string,
  text: string,
  total: number,
  maxChars: number,
  choice: VoiceSettings['aligner'],
  audio: ModuleCaptions['audio'],
  warnings: string[],
): Promise<ModuleCaptions> {
  const al = resolveAligner(choice);
  if (!al) {
    if (choice !== 'estimate') warnings.push('Whisper가 설치되지 않아 자막 타이밍을 글자 수로 추정했어요 (`ame voice setup-whisper` 후 다시 실행하면 정확해짐)');
    return { source: 'estimated', audio, text, cues: estimateCues(text, total, maxChars), createdAt: now() };
  }
  const words = await al.transcribeTimed(audioFile);
  if (!words.length) {
    warnings.push('받아쓰기 결과가 비어 있어 글자 수로 추정했어요');
    return { source: 'estimated', audio, text, cues: estimateCues(text, total, maxChars), createdAt: now() };
  }
  return { source: 'aligned', audio, aligner: al.id, text, cues: cuesFromTimings(text, wordsToChars(words), total, maxChars), createdAt: now() };
}

/** 오디오 전용 파일 길이 (probe()는 영상 스트림을 요구하므로 ffprobe로 직접 읽는다) */
function probeAudio(file: string) {
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
  return Math.round(d * 1000) / 1000;
}

/** 결과 저장 (transact 안에서) */
export function applyVoiceResult(db: DB, moduleId: string, r: VoiceJobResult) {
  const m = db.modules.find((x) => x.id === moduleId)!;
  if (r.voiceover) m.voiceover = r.voiceover;
  m.captions = r.captions;
}

/** 대사가 바뀌어 내레이션·자막을 다시 만들어야 하는 모듈 */
export function staleVoice(m: Module) {
  return (m.voiceover && m.voiceover.text !== m.transcript.trim()) || (m.captions && m.captions.text !== m.transcript.trim());
}
