import { AnalysisProvider } from './types.js';

export const ANALYSIS_PROVIDERS: AnalysisProvider[] = [
  { id: 'claude-code', label: 'Claude Code가 직접 분석 (export-analysis → tag)' },
  {
    id: 'claude-api',
    label: 'Claude API (준비 중)',
    // shortcut: API 분석은 아직 없음, API 비용을 쓰기로 하면 export 파일 내용을 프롬프트로 보내 AnalysisResult를 받도록 구현
    async analyze() {
      throw new Error('Claude API 분석은 아직 준비 중이에요. 지금은 Claude Code가 export-analysis 파일을 읽고 reference tag로 넣어요.');
    },
  },
];

export function getAnalysisProvider(id: string): AnalysisProvider {
  const p = ANALYSIS_PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`분석 제공자 "${id}"가 없어요. 가능: ${ANALYSIS_PROVIDERS.map((x) => x.id).join(', ')}`);
  return p;
}
