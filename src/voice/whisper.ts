import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { downloadWhisperModel, installWhisperCpp, transcribe } from '@remotion/install-whisper-cpp';
import type { WhisperModel } from '@remotion/install-whisper-cpp';
import { Aligner, TimedText } from './types.js';

/**
 * 무료 받아쓰기: whisper.cpp (OpenAI Whisper 모델을 내 컴퓨터에서 실행).
 * 처음 한 번 `ame voice setup-whisper`로 설치·모델 다운로드 (맥 M1 Pro에서 수 분).
 *   설치 위치: AME_WHISPER_DIR (기본 ~/.ame/whisper)
 *   모델: AME_WHISPER_MODEL (기본 large-v3-turbo: 한국어 정확도와 속도의 균형)
 */

export const WHISPER_VERSION = '1.7.6';
export const whisperDir = () => process.env.AME_WHISPER_DIR ?? path.join(os.homedir(), '.ame', 'whisper');
export const whisperModel = () => (process.env.AME_WHISPER_MODEL ?? 'large-v3-turbo') as WhisperModel;
const cppDir = () => path.join(whisperDir(), 'whisper.cpp');
const modelDir = () => path.join(whisperDir(), 'models');
const getModelPath = (folder: string, model: string) => path.join(folder, `ggml-${model}.bin`);

export async function setupWhisper(log: (s: string) => void = console.log) {
  fs.mkdirSync(modelDir(), { recursive: true });
  log(`whisper.cpp ${WHISPER_VERSION} 설치 중 → ${cppDir()}`);
  await installWhisperCpp({ version: WHISPER_VERSION, to: cppDir(), printOutput: false });
  log(`모델 ${whisperModel()} 다운로드 중 → ${modelDir()}`);
  await downloadWhisperModel({ model: whisperModel(), folder: modelDir(), printOutput: false });
  log('완료');
}

export const whisper: Aligner = {
  id: 'whisper',
  label: 'Whisper (무료, 내 컴퓨터)',
  available() {
    const exe = path.join(cppDir(), 'build', 'bin', 'whisper-cli');
    if (!fs.existsSync(exe)) return { ok: false, reason: 'whisper.cpp 미설치 (`ame voice setup-whisper`)' };
    if (!fs.existsSync(getModelPath(modelDir(), whisperModel()))) return { ok: false, reason: `모델 ${whisperModel()} 없음 (\`ame voice setup-whisper\`)` };
    return { ok: true };
  },
  async transcribeTimed(audioFile) {
    // whisper.cpp 입력 형식: 16kHz 모노 WAV
    const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ame-wh-')), 'in.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', audioFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const out = await transcribe({
      inputPath: wav,
      whisperPath: cppDir(),
      whisperCppVersion: WHISPER_VERSION,
      model: whisperModel(),
      modelFolder: modelDir(),
      tokenLevelTimestamps: true,
      language: 'ko',
      printOutput: false,
    });
    const words: TimedText[] = [];
    for (const item of out.transcription)
      for (const t of item.tokens) {
        const text = t.text.replace(/\[_[A-Z]+_?\d*\]/g, '').trim();
        if (!text) continue;
        // t_dtw(10ms 단위)가 있으면 더 정확한 시점으로 쓴다
        const start = t.offsets.from / 1000;
        const end = t.offsets.to / 1000;
        words.push({ text, start, end: Math.max(start, end) });
      }
    fs.rmSync(path.dirname(wav), { recursive: true, force: true });
    return words;
  },
};
