/**
 * 레퍼런스 분석(구간 나누기 + 분류 태그) 공통 타입.
 * 음성·글자 인식처럼 분석 제공자를 갈아끼울 수 있게 한다:
 *   claude-code : Claude Code가 `reference export-analysis` 파일을 읽고 결과를 `reference tag`로 넣는다 (API 비용 없음)
 *   claude-api  : 엔진이 직접 Claude API를 부른다 (준비 중)
 */
import { ModuleKind } from '../core/types.js';
import { Taxonomy } from '../core/config.js';

/** 분석용 타임라인 한 줄 */
export interface TimelineItem {
  start: number;
  end: number;
  /** speech: 말 · screen: 화면 문구 · headline: 오래 떠 있는 고정 문구 */
  type: 'speech' | 'screen' | 'headline';
  text: string;
  /** 화면 문구만: 위치(위에서부터 0~1)·글자 크기 */
  y?: number;
  size?: number;
}

/** 분석에서 뺀 화면 글자와 이유 */
export interface FilteredText {
  text: string;
  start: number;
  end: number;
  reason: 'caption' | 'notice' | 'packaging';
}

export interface AnalysisInput {
  referenceId: string;
  title: string;
  category?: string;
  kind: 'video' | 'image';
  durationSec?: number;
  aspect?: string;
  transcriptIssues: string[];
  timeline: TimelineItem[];
  filtered: FilteredText[];
  /** 이미지: 한 장 전체 글자 */
  imageText?: string;
}

export interface AnalysisSegment {
  kind: ModuleKind;
  start: number;
  end: number;
}

export interface RiskPhrase {
  phrase: string;
  reason: string;
  /** 나온 시점 (초). 이미지는 비움 */
  at?: number;
}

/** 분류 체계에 없는 유형 */
export interface NewTypeCandidate {
  axis: string;
  value: string;
  label: string;
  reason: string;
}

export interface AnalysisResult {
  referenceId: string;
  segments: AnalysisSegment[];
  hookText: string;
  tags: { hookType?: string; storyType?: string; offerType?: string; [axis: string]: string | undefined };
  risks: RiskPhrase[];
  newTypes: NewTypeCandidate[];
  notes?: string;
}

export interface AnalysisProvider {
  id: string;
  label: string;
  /** 없으면 외부(Claude Code)가 분석 파일을 읽고 `reference tag`로 결과를 넣는 방식 */
  analyze?(input: AnalysisInput, taxonomy: Taxonomy): Promise<AnalysisResult>;
}
