import { spawnSync } from 'node:child_process';

/**
 * 외부 프로그램(ffmpeg, ffprobe)이 설치돼 있는지 확인하고,
 * 없으면 운영체제에 맞는 설치 방법을 알려준다.
 */
const checked = new Map<string, boolean>();

export function hasTool(bin: string): boolean {
  if (!checked.has(bin)) {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    checked.set(bin, !r.error && r.status === 0);
  }
  return checked.get(bin)!;
}

export function installHint(bin: 'ffmpeg' | 'ffprobe'): string {
  if (process.platform === 'darwin') return '터미널에서 `brew install ffmpeg` 실행 후 다시 시도하세요 (brew가 없으면 https://brew.sh 첫 줄 명령으로 먼저 설치).';
  if (process.platform === 'win32') return 'PowerShell에서 `winget install Gyan.FFmpeg` 실행 후 PowerShell을 새로 열고 다시 시도하세요.';
  return '`sudo apt-get install -y ffmpeg` 등으로 설치 후 다시 시도하세요.';
}

export function requireTool(bin: 'ffmpeg' | 'ffprobe') {
  if (!hasTool(bin)) throw new Error(`${bin}이(가) 설치되어 있지 않아요. ${installHint(bin)}`);
}
