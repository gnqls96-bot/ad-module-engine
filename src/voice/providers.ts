import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TimedText, TtsOptions, TtsProvider, TtsResult } from './types.js';

/**
 * TTS 제공자 목록.
 *   무료        : melotts (내 컴퓨터에서 실행), macos-say (맥 내장), windows-tts (윈도우 내장)
 *   무료 한도   : google (월 무료 한도), azure (월 무료 한도)
 *   유료        : elevenlabs
 *   시험용      : mock (네트워크·모델 없이 흐름만 확인)
 *
 * 바꾸는 법: `ame voice set --brand <코드> --provider <id> [--voice <목소리>]`
 * API 키는 환경 변수로만 받는다 (예: ~/.zshrc 에 export GOOGLE_TTS_API_KEY=...).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const withExt = (f: string, ext: string) => (path.extname(f) ? f : `${f}.${ext}`);
const has = (bin: string) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;
/** 파이썬 실행 이름: 윈도우는 보통 python, 맥·리눅스는 python3 (AME_PYTHON으로 지정 가능) */
const python = () => process.env.AME_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} 응답 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// ── 무료: MeloTTS (내 컴퓨터에서 실행, MIT 라이선스) ──────────────
const melotts: TtsProvider = {
  id: 'melotts',
  label: 'MeloTTS (무료, 내 컴퓨터)',
  tier: 'free',
  defaultVoice: 'KR',
  env: [],
  note: '설치: pip install git+https://github.com/myshell-ai/MeloTTS.git && python -m unidic download. 첫 실행 때 모델을 내려받음',
  available() {
    const r = spawnSync(python(), ['-c', 'import melo'], { stdio: 'ignore' });
    return r.status === 0 ? { ok: true } : { ok: false, reason: 'MeloTTS가 설치되지 않음' };
  },
  async synthesize(text, opts) {
    const out = withExt(opts.outFile, 'wav');
    const py = python();
    const script = path.join(HERE, 'melotts_tts.py');
    execFileSync(py, [script, '--text', text, '--out', out, '--speaker', opts.voice ?? 'KR', '--speed', String(opts.speed ?? 1)], { stdio: 'pipe' });
    return { rawFile: out };
  },
};

// ── 무료: 맥 내장 목소리 (say) ───────────────────────────────────
const macosSay: TtsProvider = {
  id: 'macos-say',
  label: '맥 내장 음성 (무료)',
  tier: 'free',
  defaultVoice: 'Yuna',
  env: [],
  note: '설치 필요 없음. 시스템 설정 > 손쉬운 사용 > 읽기 및 말하기에서 한국어 음성(유나 등)을 추가하면 품질이 올라감',
  available() {
    return process.platform === 'darwin' && has('say') ? { ok: true } : { ok: false, reason: '맥에서만 사용 가능' };
  },
  async synthesize(text, opts) {
    const out = withExt(opts.outFile, 'aiff');
    const rate = Math.round(180 * (opts.speed ?? 1));
    const voice = opts.voice ?? 'Yuna';
    const installed = execFileSync('say', ['-v', '?'], { encoding: 'utf8' });
    if (!new RegExp(`^${voice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm').test(installed)) {
      const ko = installed.split('\n').filter((l) => /ko_KR/.test(l)).map((l) => l.split(/\s{2,}/)[0].trim());
      throw new Error(`맥에 "${voice}" 목소리가 없어요. ${ko.length ? `설치된 한국어 목소리: ${ko.join(', ')}` : '시스템 설정 > 손쉬운 사용 > 읽기 및 말하기 > 시스템 음성에서 한국어 음성(유나 등)을 추가하세요'}`);
    }
    execFileSync('say', ['-v', voice, '-r', String(rate), '-o', out, text]);
    return { rawFile: out };
  },
};

// ── 무료: 윈도우 내장 목소리 (System.Speech) ─────────────────────
/**
 * 윈도우에 기본으로 있는 음성 합성. 한국어 목소리(예: Microsoft Heami)는
 * 설정 > 시간 및 언어 > 언어 및 지역에서 한국어를 추가하고 "음성" 항목을 설치하면 생긴다.
 * 목소리를 지정하지 않으면 설치된 한국어 목소리를 자동으로 고른다.
 */
const windowsTts: TtsProvider = {
  id: 'windows-tts',
  label: '윈도우 내장 음성 (무료)',
  tier: 'free',
  defaultVoice: '',
  env: [],
  note: '설치 필요 없음. 설정 > 시간 및 언어 > 언어 및 지역 > 한국어 > 언어 옵션에서 "음성"을 설치하면 한국어 목소리(Heami 등)가 생김',
  available() {
    return process.platform === 'win32' ? { ok: true } : { ok: false, reason: '윈도우에서만 사용 가능' };
  },
  async synthesize(text, opts) {
    const out = withExt(opts.outFile, 'wav');
    // 대본·경로는 환경 변수로 넘겨 따옴표·특수문자 문제를 피한다
    const ps = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'if ($env:AME_TTS_VOICE) { $s.SelectVoice($env:AME_TTS_VOICE) }',
      'else {',
      '  $ko = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq "ko-KR" } | Select-Object -First 1',
      '  if ($ko) { $s.SelectVoice($ko.VoiceInfo.Name) } else { [Console]::Error.WriteLine("NO_KOREAN_VOICE") }',
      '}',
      '$s.Rate = [int]$env:AME_TTS_RATE',
      '$s.SetOutputToWaveFile($env:AME_TTS_OUT)',
      '$s.Speak($env:AME_TTS_TEXT)',
      '$s.Dispose()',
    ].join('\n');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: {
        ...process.env,
        AME_TTS_TEXT: text,
        AME_TTS_OUT: out,
        AME_TTS_VOICE: opts.voice ?? '',
        AME_TTS_RATE: String(Math.max(-10, Math.min(10, Math.round(((opts.speed ?? 1) - 1) * 10)))),
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`윈도우 음성 합성 실패: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    if (/NO_KOREAN_VOICE/.test(r.stderr ?? '')) throw new Error('윈도우에 한국어 목소리가 없어요. ' + this.note);
    return { rawFile: out };
  },
};

// ── 무료 한도: 구글 클라우드 TTS ─────────────────────────────────
const google: TtsProvider = {
  id: 'google',
  label: '구글 클라우드 TTS (월 무료 한도)',
  tier: 'free-quota',
  defaultVoice: 'ko-KR-Neural2-A',
  env: ['GOOGLE_TTS_API_KEY'],
  note: '구글 클라우드 콘솔에서 Text-to-Speech API 사용 설정 → API 키 발급. 한도 초과 시 자동 과금이므로 예산 알림 설정 권장',
  available() {
    return process.env.GOOGLE_TTS_API_KEY ? { ok: true } : { ok: false, reason: 'GOOGLE_TTS_API_KEY 환경 변수 없음' };
  },
  async synthesize(text, opts) {
    const voice = opts.voice ?? this.defaultVoice;
    const res = await postJson(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(process.env.GOOGLE_TTS_API_KEY!)}`,
      {
        input: { text },
        voice: { languageCode: voice.split('-').slice(0, 2).join('-'), name: voice },
        audioConfig: { audioEncoding: 'MP3', speakingRate: opts.speed ?? 1 },
      },
      {},
    );
    const j: any = await res.json();
    const out = withExt(opts.outFile, 'mp3');
    fs.writeFileSync(out, Buffer.from(j.audioContent, 'base64'));
    return { rawFile: out };
  },
};

// ── 무료 한도: MS 애저 음성 ──────────────────────────────────────
const azure: TtsProvider = {
  id: 'azure',
  label: 'MS 애저 음성 (월 무료 한도)',
  tier: 'free-quota',
  defaultVoice: 'ko-KR-SunHiNeural',
  env: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],
  note: '애저 포털에서 Speech 리소스를 무료(F0) 등급으로 만들고 키와 지역(예: koreacentral)을 설정',
  available() {
    return process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION ? { ok: true } : { ok: false, reason: 'AZURE_SPEECH_KEY / AZURE_SPEECH_REGION 환경 변수 없음' };
  },
  async synthesize(text, opts) {
    const voice = opts.voice ?? this.defaultVoice;
    const rate = `${Math.round(((opts.speed ?? 1) - 1) * 100)}%`;
    const ssml = `<speak version="1.0" xml:lang="ko-KR"><voice name="${voice}"><prosody rate="${rate}">${escXml(text)}</prosody></voice></speak>`;
    const res = await fetch(`https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY!,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
        'User-Agent': 'ad-module-engine',
      },
      body: ssml,
    });
    if (!res.ok) throw new Error(`애저 응답 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const out = withExt(opts.outFile, 'mp3');
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return { rawFile: out };
  },
};

// ── 유료: 일레븐랩스 (글자 단위 타이밍을 직접 줌) ─────────────────
const elevenlabs: TtsProvider = {
  id: 'elevenlabs',
  label: '일레븐랩스 (유료)',
  tier: 'paid',
  defaultVoice: '',
  env: ['ELEVENLABS_API_KEY'],
  note: '일레븐랩스 설정에서 API 키 발급. 목소리는 Voice ID로 지정 (--voice <ID>). 모델: AME_ELEVENLABS_MODEL (기본 eleven_multilingual_v2)',
  available() {
    return process.env.ELEVENLABS_API_KEY ? { ok: true } : { ok: false, reason: 'ELEVENLABS_API_KEY 환경 변수 없음' };
  },
  async synthesize(text, opts) {
    if (!opts.voice) throw new Error('일레븐랩스는 목소리 ID가 필요해요: ame voice set --brand <코드> --provider elevenlabs --voice <Voice ID>');
    const res = await postJson(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voice)}/with-timestamps`,
      {
        text,
        model_id: process.env.AME_ELEVENLABS_MODEL ?? 'eleven_multilingual_v2',
        voice_settings: opts.speed && opts.speed !== 1 ? { speed: opts.speed } : undefined,
      },
      { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
    );
    const j: any = await res.json();
    const out = withExt(opts.outFile, 'mp3');
    fs.writeFileSync(out, Buffer.from(j.audio_base64, 'base64'));
    const a = j.alignment;
    const charTimings: TimedText[] | undefined = a?.characters?.map((c: string, i: number) => ({
      text: c,
      start: a.character_start_times_seconds[i],
      end: a.character_end_times_seconds[i],
    }));
    return { rawFile: out, charTimings };
  },
};

// ── 시험용: 네트워크·모델 없이 흐름 확인 ─────────────────────────
/** 글자 수에 비례한 길이의 톤을 만들고, 가짜 글자 타이밍을 돌려준다 (음성 대신 "삐" 소리) */
const mock: TtsProvider = {
  id: 'mock',
  label: '시험용 (실제 음성 아님)',
  tier: 'test',
  defaultVoice: 'tone',
  env: [],
  note: '개발·데모용. 실제 집행 소재에는 쓰지 않음',
  available: () => ({ ok: true }),
  async synthesize(text, opts) {
    const perChar = 0.11 / (opts.speed ?? 1);
    const chars = [...text];
    const dur = Math.max(0.6, chars.filter((c) => c.trim()).length * perChar + 0.2);
    const out = withExt(opts.outFile, 'wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=520:d=${dur.toFixed(2)}`, '-af', 'volume=0.2', out]);
    let t = 0.1;
    const charTimings = chars.map((c) => {
      const d = c.trim() ? perChar : perChar * 0.4;
      const r = { text: c, start: t, end: t + d };
      t += d;
      return r;
    });
    return { rawFile: out, charTimings };
  },
};

export const PROVIDERS: TtsProvider[] = [melotts, macosSay, windowsTts, google, azure, elevenlabs, mock];

export function getProvider(id: string): TtsProvider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`모르는 음성 제공자: ${id}. 사용 가능: ${PROVIDERS.map((x) => x.id).join(', ')}`);
  return p;
}

/**
 * provider가 'auto'면 쓸 수 있는 무료 제공자를 품질 순으로 고른다:
 * 구글(무료 한도) → 애저(무료 한도) → MeloTTS → 맥 내장 / 윈도우 내장.
 * 유료(일레븐랩스)는 자동으로 고르지 않는다 (명시적으로 설정했을 때만 과금).
 */
export function resolveProvider(id: string | undefined): TtsProvider {
  if (id && id !== 'auto') {
    const p = getProvider(id);
    const a = p.available();
    if (!a.ok) throw new Error(`${p.label}를 쓸 수 없어요: ${a.reason}. 준비 방법: ${p.note}`);
    return p;
  }
  for (const pid of ['google', 'azure', 'melotts', 'macos-say', 'windows-tts']) {
    const p = getProvider(pid);
    if (p.available().ok) return p;
  }
  throw new Error('쓸 수 있는 무료 음성 제공자가 없어요. `ame voice providers`로 준비 방법을 확인하세요.');
}

/** 어떤 제공자 결과든 같은 형식으로: 48kHz 스테레오 AAC, 음량 표준화 (광고 플랫폼 권장 -16 LUFS 근처) */
export function normalizeAudio(src: string, dest: string) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '160k', dest]);
}

export function tmpBase(prefix: string) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ame-')), prefix);
}
