import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OcrLine, OcrProvider } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ocrDir = () => process.env.AME_OCR_DIR ?? path.join(os.homedir(), '.ame', 'ocr');

/**
 * 맥 내장 글자 인식 (Vision 프레임워크).
 * Swift 소스(mac_vision.swift)를 처음 한 번 컴파일해 ~/.ame/ocr 에 둔다 (소스가 바뀌면 다시 컴파일).
 * 필요: Xcode 명령줄 도구 (`xcode-select --install`, Whisper 설치 때 이미 깔림)
 */
const macVision: OcrProvider = {
  id: 'mac-vision',
  label: '맥 내장 글자 인식 (무료)',
  available() {
    if (process.platform !== 'darwin') return { ok: false, reason: '맥에서만 쓸 수 있어요' };
    const r = spawnSync('swiftc', ['--version'], { stdio: 'ignore' });
    if (r.error || r.status !== 0) return { ok: false, reason: 'Swift 컴파일러 없음 (`xcode-select --install`)' };
    return { ok: true };
  },
  async readImages(files) {
    const exe = buildMacVision();
    const out: OcrLine[][] = [];
    // 명령 줄 길이 제한을 넘지 않게 나눠서 실행
    for (let i = 0; i < files.length; i += 100) {
      const chunk = files.slice(i, i + 100);
      const json = execFileSync(exe, chunk, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const res = JSON.parse(json) as { file: string; lines: OcrLine[]; error?: string }[];
      for (const r of res) {
        if (r.error) throw new Error(`글자 인식 실패 (${path.basename(r.file)}): ${r.error}`);
        out.push(r.lines);
      }
    }
    return out;
  },
};

function buildMacVision(): string {
  const src = path.join(HERE, 'mac_vision.swift');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
  const exe = path.join(ocrDir(), `ame-ocr-${hash}`);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(ocrDir(), { recursive: true });
  try {
    execFileSync('swiftc', ['-O', '-o', exe, src], { stdio: 'pipe' });
  } catch (e: any) {
    fs.rmSync(exe, { force: true });
    throw new Error(`맥 글자 인식 도구 컴파일 실패: ${e.stderr?.toString() || e.message}`);
  }
  return exe;
}

/** 윈도우용. shortcut: 아직 연결 안 함, 윈도우 PC에서 쓸 때 PaddleOCR 파이썬 스크립트로 구현 */
const paddle: OcrProvider = {
  id: 'paddleocr',
  label: 'PaddleOCR (무료, 윈도우용)',
  available: () => ({ ok: false, reason: '아직 준비 중 (윈도우 지원 때 추가)' }),
  async readImages() {
    throw new Error('PaddleOCR는 아직 준비 중이에요.');
  },
};

export const OCR_PROVIDERS: OcrProvider[] = [macVision, paddle];

/** auto: 쓸 수 있는 제공자 중 첫 번째. AME_OCR 환경 변수로 지정 가능 */
export function resolveOcr(id = process.env.AME_OCR ?? 'auto'): OcrProvider {
  if (id !== 'auto') {
    const p = OCR_PROVIDERS.find((x) => x.id === id);
    if (!p) throw new Error(`모르는 글자 인식 제공자: ${id} (가능: ${OCR_PROVIDERS.map((x) => x.id).join(', ')})`);
    const a = p.available();
    if (!a.ok) throw new Error(`${p.label}를 쓸 수 없어요: ${a.reason}`);
    return p;
  }
  const p = OCR_PROVIDERS.find((x) => x.available().ok);
  if (!p) throw new Error(`쓸 수 있는 글자 인식 제공자가 없어요: ${OCR_PROVIDERS.map((x) => `${x.id}: ${x.available().reason}`).join(' / ')}`);
  return p;
}
