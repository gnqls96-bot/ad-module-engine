#!/usr/bin/env node
/**
 * 자동 점검용 실행기: 명령을 실행해 출력은 그대로 보여주고,
 * 실패하면 마지막 60줄을 GitHub 오류 표시(annotation)로 남긴다.
 * (실행 기록 전체를 못 열어도 오류 원인을 바로 볼 수 있게)
 *
 *   node scripts/ci-run.mjs "<제목>" <명령> [인수...]
 */
import { spawn } from 'node:child_process';

const [title, cmd, ...args] = process.argv.slice(2);
const lines = [];
const child = spawn(cmd, args, { shell: process.platform === 'win32', env: process.env });
const take = (buf, out) => {
  out.write(buf);
  for (const l of buf.toString('utf8').split(/\r?\n/)) if (l.trim()) lines.push(l);
  if (lines.length > 400) lines.splice(0, lines.length - 400);
};
child.stdout.on('data', (b) => take(b, process.stdout));
child.stderr.on('data', (b) => take(b, process.stderr));
child.on('close', (code) => {
  if (code !== 0) {
    const tail = lines
      .filter((l) => !/Memory reported|Detected differing memory|docker run|Using the lower amount/.test(l))
      .slice(-60)
      .join('\n');
    const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
    console.log(`::error title=${esc(`${title} (${process.platform})`)}::${esc(tail || `종료 코드 ${code}`)}`);
  }
  process.exit(code ?? 1);
});
