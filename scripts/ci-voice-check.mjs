#!/usr/bin/env node
/**
 * 음성 경로 점검 (자동 검사용, 맥·윈도우·리눅스 공통).
 *   1) 이 운영체제의 내장 음성으로 문장을 읽힌다 (맥: say, 윈도우: System.Speech, 리눅스: ffmpeg flite)
 *   2) 그 음성을 넣은 영상을 모듈로 등록하고
 *   3) Whisper로 자막 타이밍을 맞춘 뒤, 결과가 "aligned"이고 시간이 그럴듯한지 확인한다.
 * 자동 검사 서버에는 한국어 목소리가 없어서 영어 문장으로 확인한다 (AME_WHISPER_LANG=en).
 *
 *   node scripts/ci-voice-check.mjs <작업 공간>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = path.resolve(process.argv[2] ?? path.join(ROOT, 'demo-workspace'));
const TEXT = 'Apply the serum right after washing your face. Then gently press three drops into your skin.';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-ci-'));
const fail = (m) => {
  console.error(`✖ ${m}`);
  process.exit(1);
};

// 1) 내장 음성
const { getProvider, normalizeAudio } = await import('../src/voice/providers.ts');
let raw;
if (process.platform === 'darwin') {
  raw = (await getProvider('macos-say').synthesize(TEXT, { voice: 'Samantha', outFile: path.join(tmp, 'speech') })).rawFile;
} else if (process.platform === 'win32') {
  // 서버용 윈도우에는 영어 목소리만 있으므로 설치된 첫 목소리를 쓴다
  const first = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Select-Object -First 1 | ForEach-Object { $_.VoiceInfo.Name }'], { encoding: 'utf8' }).trim();
  console.log(`윈도우 목소리: ${first}`);
  raw = (await getProvider('windows-tts').synthesize(TEXT, { voice: first, outFile: path.join(tmp, 'speech') })).rawFile;
} else {
  raw = path.join(tmp, 'speech.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `flite=text='${TEXT.replace(/'/g, '')}':voice=slt`, raw]);
}
const audio = path.join(tmp, 'speech.m4a');
normalizeAudio(raw, audio);
console.log(`✔ 내장 음성 생성 (${process.platform})`);

// 2) 음성을 넣은 영상 → 모듈 등록
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio], { encoding: 'utf8' }).trim());
const video = path.join(tmp, 'story_speech.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x2E86AB:s=1080x1920:r=30:d=${(dur + 0.5).toFixed(2)}`, '-i', audio,
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
const ame = (...a) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ame.mjs'), '-w', WS, ...a], { encoding: 'utf8', env: { ...process.env, AME_WHISPER_LANG: 'en' } });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  if (r.status !== 0) fail(`ame ${a.join(' ')}`);
  return r.stdout;
};
const added = ame('module', 'add', video, '--brand', 'DEMO', '--product', 'SERUM', '--kind', 'story', '--transcript', TEXT, '--story-type', 'demo');
const code = /(S\d{3}) 등록/.exec(added)?.[1] ?? fail('모듈 코드를 못 읽음');

// 3) Whisper 자막 맞춤
ame('module', 'align', code, '--brand', 'DEMO', '--product', 'SERUM');
const db = JSON.parse(fs.readFileSync(path.join(WS, '.ame', 'db.json'), 'utf8'));
const m = db.modules.find((x) => x.code === code);
const cues = m?.captions?.cues ?? [];
console.log(JSON.stringify(m?.captions, null, 2));
if (m?.captions?.source !== 'aligned') fail(`자막 출처가 aligned가 아님: ${m?.captions?.source}`);
if (cues.length < 2) fail('자막 구간이 2개 미만');
if (!(cues[0].start < 1.5)) fail(`첫 자막 시작이 너무 늦음: ${cues[0].start}`);
if (!(cues.at(-1).end <= dur + 0.6)) fail(`마지막 자막이 음성보다 김: ${cues.at(-1).end} > ${dur}`);
for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].start) fail('자막 순서가 뒤바뀜');
console.log(`✔ Whisper 자막 타이밍 확인 (${cues.length}개 구간, 음성 ${dur.toFixed(1)}초)`);
fs.rmSync(tmp, { recursive: true, force: true });
