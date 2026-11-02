import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { downloadWhisperModel, installWhisperCpp, transcribe } from '@remotion/install-whisper-cpp';
import type { WhisperModel } from '@remotion/install-whisper-cpp';
import { Aligner, TimedText } from './types.js';
import { requireTool } from '../core/tools.js';

/**
 * 무료 받아쓰기: whisper.cpp (OpenAI Whisper 모델을 내 컴퓨터에서 실행). 맥·윈도우·리눅스 공통.
 *
 * 처음 한 번 `ame voice setup-whisper [--model ...]`로 설치한다.
 *   맥·리눅스: 소스를 받아 빌드 (Xcode 명령줄 도구 / make 필요)
 *   윈도우   : 공식 배포 실행 파일(zip)을 받아 풀기 (빌드 도구 필요 없음)
 * 설치 위치: AME_WHISPER_DIR (기본 ~/.ame/whisper). 고른 모델은 그 폴더의 config.json에 기억된다.
 *
 * 모델 선택 (한국어 기준):
 *   large-v3-turbo (기본, 약 1.6GB) 정확도·속도 균형. 맥 M 시리즈, 최근 윈도우 PC 권장
 *   small          (약 470MB)       사양이 낮은 PC용. 정확도는 조금 떨어짐
 *   medium         (약 1.5GB)       turbo보다 느림
 */

export const WHISPER_VERSION = '1.7.6';
const DEFAULT_MODEL: WhisperModel = 'large-v3-turbo';
export const RECOMMENDED_MODELS: WhisperModel[] = ['large-v3-turbo', 'medium', 'small', 'base', 'tiny'];

export const whisperDir = () => process.env.AME_WHISPER_DIR ?? path.join(os.homedir(), '.ame', 'whisper');
const cppDir = () => path.join(whisperDir(), 'whisper.cpp');
const modelDir = () => path.join(whisperDir(), 'models');
const configFile = () => path.join(whisperDir(), 'config.json');
const modelPath = (model: string) => path.join(modelDir(), `ggml-${model}.bin`);

/**
 * 음성 구간 감지(VAD) 모델 (Silero, 약 0.9MB). 사람 목소리가 있는 구간만 Whisper에 넘긴다.
 * 음악만 있는 구간에서 Whisper가 "감사합니다", "다음 영상에서 만나요" 같은 말을 지어내는 것을 막는다.
 */
const VAD_MODEL = 'silero-v5.1.2';
const VAD_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-${VAD_MODEL}.bin`;
export const vadModelPath = () => path.join(modelDir(), `ggml-${VAD_MODEL}.bin`);
const vadOk = () => {
  try {
    return fs.statSync(vadModelPath()).size > 100 * 1024 && ['lmgg', 'ggml'].includes(fs.readFileSync(vadModelPath()).subarray(0, 4).toString('latin1'));
  } catch {
    return false;
  }
};

/** 우선순위: AME_WHISPER_MODEL > setup 때 고른 모델 > 기본 */
export function whisperModel(): WhisperModel {
  if (process.env.AME_WHISPER_MODEL) return process.env.AME_WHISPER_MODEL as WhisperModel;
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8')).model as WhisperModel;
  } catch {
    return DEFAULT_MODEL;
  }
}

/** 모델 파일이 제대로 있는지: 크기(가장 작은 tiny도 수십 MB)와 ggml 파일 머리글로 확인 */
function modelOk(model: string) {
  const f = modelPath(model);
  try {
    if (fs.statSync(f).size < 10 * 1024 * 1024) return false;
    const fd = fs.openSync(f, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    // ggml 형식 표식 0x67676d6c ("ggml", 리틀 엔디언으로 저장되면 "lmgg")
    return head.toString('latin1') === 'lmgg' || head.toString('latin1') === 'ggml';
  } catch {
    return false;
  }
}

/**
 * 맥·리눅스는 소스를 빌드하므로 git, make, cmake, C++ 컴파일러가 필요하다.
 * (whisper.cpp 1.7부터 make가 내부에서 cmake를 부른다 — 맥에 cmake가 없으면 "make 실패"로만 보여서 원인을 알기 어렵다)
 */
function checkBuildTools() {
  const has = (bin: string, arg = '--version') => {
    const r = spawnSync(bin, [arg], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  };
  const missing: string[] = [];
  if (!has('git')) missing.push('git');
  if (!has('make')) missing.push('make');
  if (!has('c++')) missing.push('C++ 컴파일러');
  if (!has('cmake')) missing.push('cmake');
  if (!missing.length) return;
  const hint =
    process.platform === 'darwin'
      ? [
          missing.some((m) => m !== 'cmake') ? '1) `xcode-select --install` (개발 도구, 창이 뜨면 "설치")' : '',
          missing.includes('cmake') ? `${missing.some((m) => m !== 'cmake') ? '2' : '1'}) \`brew install cmake\`` : '',
        ]
          .filter(Boolean)
          .join('\n  ')
      : '`sudo apt-get install -y build-essential cmake git` 등으로 설치';
  throw new Error(`Whisper를 빌드하려면 ${missing.join(', ')}이(가) 필요해요. 설치 후 다시 실행하세요:\n  ${hint}`);
}

/** whisper-cli 실행 파일 위치 (1.7.4 이상은 build/bin 아래, 윈도우는 .exe) */
export const whisperExe = () => path.join(cppDir(), 'build', 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');

export async function setupWhisper(opts: { model?: string; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const model = (opts.model ?? whisperModel()) as WhisperModel;
  if (!RECOMMENDED_MODELS.includes(model) && !/^(tiny|base|small|medium|large)/.test(model)) throw new Error(`모르는 모델: ${model}`);
  fs.mkdirSync(modelDir(), { recursive: true });

  if (fs.existsSync(whisperExe())) log(`whisper.cpp 이미 설치됨 → ${cppDir()}`);
  else {
    if (process.platform !== 'win32') checkBuildTools();
    // 이전에 실패해 반쯤 남은 폴더는 지우고 다시 설치
    if (fs.existsSync(cppDir())) fs.rmSync(cppDir(), { recursive: true, force: true });
    log(`whisper.cpp ${WHISPER_VERSION} 설치 중 → ${cppDir()}${process.platform === 'win32' ? ' (실행 파일 다운로드)' : ' (소스 빌드, 몇 분 걸림)'}`);
    const cwd = process.cwd();
    // 윈도우 설치는 현재 폴더에 zip을 받으므로, 설치 폴더에서 실행해 작업 공간을 어지르지 않게 한다
    process.chdir(whisperDir());
    try {
      // 빌드 과정을 화면에 보여줘야 실패했을 때 원인을 알 수 있다
      await installWhisperCpp({ version: WHISPER_VERSION, to: cppDir(), printOutput: true });
    } catch (e) {
      throw new Error(`whisper.cpp 설치 실패: ${(e as Error).message}\n  위에 나온 빌드 메시지 중 "error"가 있는 줄을 확인하세요. 다시 시도하면 반쯤 남은 폴더는 자동으로 지우고 새로 설치합니다.`);
    } finally {
      process.chdir(cwd);
    }
    if (process.platform === 'win32') normalizeWindowsLayout();
    if (!fs.existsSync(whisperExe())) throw new Error(`설치는 끝났지만 실행 파일을 찾지 못했어요: ${whisperExe()}`);
  }

  if (modelOk(model)) log(`모델 ${model} 이미 있음`);
  else {
    log(`모델 ${model} 다운로드 중 → ${modelDir()}`);
    fs.rmSync(modelPath(model), { force: true });
    try {
      await downloadWhisperModel({ model, folder: modelDir(), printOutput: false });
    } catch (e) {
      // 받다가 끊기면 빈 파일·반쪽 파일이 남아 다음에 "있음"으로 착각하므로 지운다
      fs.rmSync(modelPath(model), { force: true });
      throw new Error(`모델 다운로드 실패 (인터넷 연결 확인 후 다시 실행): ${(e as Error).message}`);
    }
    if (!modelOk(model)) {
      fs.rmSync(modelPath(model), { force: true });
      throw new Error('모델 파일이 올바르지 않아요. 다시 실행해 주세요.');
    }
  }
  if (vadOk()) log(`음성 구간 감지 모델 ${VAD_MODEL} 이미 있음`);
  else {
    log(`음성 구간 감지 모델 ${VAD_MODEL} 다운로드 중`);
    try {
      const res = await fetch(VAD_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(vadModelPath(), Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      fs.rmSync(vadModelPath(), { force: true });
      throw new Error(`음성 구간 감지 모델 다운로드 실패 (인터넷 연결 확인 후 다시 실행): ${(e as Error).message}`);
    }
    if (!vadOk()) {
      fs.rmSync(vadModelPath(), { force: true });
      throw new Error('음성 구간 감지 모델 파일이 올바르지 않아요. 다시 실행해 주세요.');
    }
  }
  fs.writeFileSync(configFile(), JSON.stringify({ model, version: WHISPER_VERSION, installedAt: new Date().toISOString() }, null, 2));
  log(`완료 (모델: ${model})`);
}

/**
 * 윈도우 배포 zip은 버전에 따라 실행 파일이 Release/ 등 다른 폴더에 풀린다.
 * Remotion 도구가 기대하는 build/bin/ 으로 실행 파일과 DLL을 모은다.
 */
function normalizeWindowsLayout() {
  if (fs.existsSync(whisperExe())) return;
  const found = findFile(cppDir(), 'whisper-cli.exe') ?? findFile(cppDir(), 'main.exe');
  if (!found) return;
  const src = path.dirname(found);
  const dest = path.dirname(whisperExe());
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const from = path.join(src, f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dest, f));
  }
  if (!fs.existsSync(whisperExe()) && fs.existsSync(path.join(dest, 'main.exe'))) fs.copyFileSync(path.join(dest, 'main.exe'), whisperExe());
}

function findFile(dir: string, name: string): string | undefined {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    }
  }
  return undefined;
}

/** whisper.cpp 실행 (16kHz 모노 WAV로 바꿔서). 토큰 단위 시간이 들어 있다 */
async function runWhisper(audioFile: string) {
  requireTool('ffmpeg');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-wh-'));
  const wav = path.join(tmp, 'in.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', audioFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  try {
    return await transcribe({
      inputPath: wav,
      whisperPath: cppDir(),
      whisperCppVersion: WHISPER_VERSION,
      model: whisperModel(),
      modelFolder: modelDir(),
      tokenLevelTimestamps: true,
      language: (process.env.AME_WHISPER_LANG ?? 'ko') as any,
      printOutput: false,
      splitOnWord: true,
      // 사람 목소리 구간만 받아쓰기. 시간은 원래 영상 기준으로 돌려준다.
      // 기준값 0.35: 기본 0.5는 배경음악 위 빠른 말을 한 문장 통째로 놓쳤다 (레퍼런스 36개로 비교, DEVLOG 2026-11-02)
      additionalArgs: ['--vad', '--vad-model', vadModelPath(), '--vad-threshold', '0.35'],
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const cleanToken = (t: string) => t.replace(/\[_[A-Z]+_?\d*\]/g, '');

export interface TimedWord extends TimedText {
  /** Whisper 확신도 (0~1, 단어 안 토큰 평균) */
  p: number;
}

/**
 * 영상 받아쓰기: 단어(띄어쓰기 단위)마다 시작·끝 시간과 확신도.
 * 단어 단위로 끊어 받는다(splitOnWord). 토큰 단위로 받으면 한글 한 글자가 토큰 두 개로 쪼개져
 * 글자가 깨진다("커��") — 단어 묶음의 글자는 온전하다.
 */
export async function transcribeWords(audioFile: string): Promise<{ model: string; language: string; text: string; words: TimedWord[] }> {
  const out = await runWhisper(audioFile);
  const words: TimedWord[] = [];
  for (const item of out.transcription) {
    const text = cleanToken(item.text).trim();
    const toks = item.tokens.filter((t) => cleanToken(t.text).trim());
    if (!text || !toks.length) continue;
    const start = item.offsets.from / 1000;
    const p = toks.reduce((sum, t) => sum + t.p, 0) / toks.length;
    words.push({ text, start, end: Math.max(start, item.offsets.to / 1000), p: Math.round(p * 1000) / 1000 });
  }
  return { model: whisperModel(), language: process.env.AME_WHISPER_LANG ?? 'ko', text: words.map((w) => w.text).join(' '), words };
}

export const whisper: Aligner = {
  id: 'whisper',
  label: 'Whisper (무료, 내 컴퓨터)',
  available() {
    if (!fs.existsSync(whisperExe())) return { ok: false, reason: 'whisper.cpp 미설치 (`ame voice setup-whisper`)' };
    if (!modelOk(whisperModel())) return { ok: false, reason: `모델 ${whisperModel()} 없음 또는 손상 (\`ame voice setup-whisper\`)` };
    if (!vadOk()) return { ok: false, reason: '음성 구간 감지 모델 없음 (`ame voice setup-whisper` 다시 실행)' };
    return { ok: true };
  },
  async transcribeTimed(audioFile) {
    // 단어 단위로 받는다 (토큰 단위는 한글이 깨짐). align.ts가 단어 시간을 글자로 펼친다
    return (await transcribeWords(audioFile)).words.map(({ text, start, end }) => ({ text, start, end }));
  },
};
