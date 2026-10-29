import { execFileSync } from 'node:child_process';
import { MediaInfo, SpecIssue } from './types.js';

/** ffprobe로 영상 정보 읽기 */
export function probe(file: string): MediaInfo {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  if (!v) throw new Error(`영상 스트림이 없는 파일이에요: ${file}`);
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  // 세로 영상이 회전 메타데이터로 저장된 경우(휴대폰 촬영본) 가로·세로를 바꾼다
  const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((x: any) => x.rotation !== undefined)?.rotation ?? 0));
  const swap = rot === 90 || rot === 270;
  return {
    durationSec: Math.round(Number(j.format.duration) * 1000) / 1000,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    fps: d ? Math.round((n / d) * 100) / 100 : n,
    hasAudio: j.streams.some((s: any) => s.codec_type === 'audio'),
  };
}

/** 설계서 "모듈 규격" 검사. fail은 등록을 막고, warn은 기록만 한다 */
export function checkSpec(m: MediaInfo): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const short = Math.min(m.width, m.height);
  if (m.durationSec < 0.5) issues.push({ level: 'fail', message: `길이가 너무 짧아요 (${m.durationSec}초)` });
  if (short < 720) issues.push({ level: 'fail', message: `해상도가 너무 낮아요 (${m.width}×${m.height}, 짧은 변 720 미만)` });
  else if (short < 1080) issues.push({ level: 'warn', message: `권장 해상도보다 낮아요 (${m.width}×${m.height}, 권장 1080×1920)` });
  if (m.height <= m.width) issues.push({ level: 'warn', message: '9:16 세로 원본이 아니에요. 다른 비율로 변환할 때 여백이 생길 수 있어요' });
  if (Math.abs(m.fps - 30) > 0.5) issues.push({ level: 'warn', message: `프레임이 ${m.fps}fps예요. 렌더링 때 30fps로 맞춥니다` });
  if (!m.hasAudio) issues.push({ level: 'warn', message: '음성 트랙이 없어요' });
  return issues;
}
