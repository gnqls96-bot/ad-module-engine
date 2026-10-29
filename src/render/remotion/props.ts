import type { BrandKit, ModuleKind, OfferData } from '../../core/types';

/** 렌더러가 템플릿에 넘기는 값. 템플릿은 이 값만 보고 영상을 그린다 */
export interface Segment {
  kind: ModuleKind;
  code: string;
  src: string;
  durationInFrames: number;
  transcript: string;
  /** 원본과 출력 비율이 다르면 true (흐린 배경 + 가운데 맞춤). 같으면 영상 한 겹만 그려 렌더링이 빨라진다 */
  letterbox: boolean;
}

export interface AdProps {
  segments: Segment[];
  width: number;
  height: number;
  fps: number;
  brandKit: BrandKit;
  offer: OfferData;
  materialCode: string;
  /** 오퍼 카드를 띄울 구간 (기본: offer 모듈 전체) */
  showOfferCard: boolean;
}

export const FPS = 30;
