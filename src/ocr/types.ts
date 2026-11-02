/**
 * 화면 글자 읽기(OCR) 공통 타입.
 * 음성 제공자(TtsProvider)처럼 제공자를 갈아끼울 수 있게 한다:
 *   mac-vision : 맥 내장 글자 인식 (무료, 한국어)
 *   paddleocr  : 윈도우용 (준비 중)
 */

export interface OcrLine {
  text: string;
  /** 0~1 */
  conf: number;
  /** 화면 비율 좌표 (0~1), y는 위에서부터 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrProvider {
  id: string;
  label: string;
  available(): { ok: boolean; reason?: string };
  /** 이미지 여러 장을 한 번에 읽는다 (영상 프레임 수십~수백 장). 입력 순서대로 결과 */
  readImages(files: string[]): Promise<OcrLine[][]>;
}

/** 영상에서 "몇 초~몇 초에 이 문구" */
export interface ScreenTextSegment {
  text: string;
  start: number;
  end: number;
  /** 화면 위치 (위에서부터 0~1). 위쪽 헤드라인 / 아래쪽 자막 구분용 */
  y: number;
  /** 글자 높이 (화면 높이 대비). 클수록 눈에 띄는 문구 */
  size: number;
}
