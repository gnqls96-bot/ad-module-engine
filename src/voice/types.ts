/**
 * 음성 계층의 공통 타입.
 *
 * - TtsProvider: 대본 → 음성 파일. 무료/무료 한도/유료 제공자를 같은 모양으로 만들어 갈아끼울 수 있게 한다.
 * - Aligner: 음성 파일 + 대본 → 몇 초에 무슨 말을 했는지. 자막 타이밍의 원천.
 *
 * 원칙: 어떤 TTS를 쓰든 "음성 → 타이밍 추출" 방식이 같아서, TTS를 바꿔도 자막 쪽은 손대지 않는다.
 * (일레븐랩스처럼 TTS가 타이밍을 직접 주면 그걸 바로 쓴다)
 */

export type VoiceTier = 'free' | 'free-quota' | 'paid' | 'test';

export interface TimedText {
  text: string;
  start: number; // 초
  end: number;
}

export interface TtsOptions {
  voice?: string;
  speed?: number; // 1.0 = 보통
  outFile: string; // 확장자 없이 넘기면 제공자가 붙인다
}

export interface TtsResult {
  /** 제공자가 만든 원본 파일 */
  rawFile: string;
  /** 제공자가 글자 단위 타이밍을 직접 준 경우 (입력 대본 기준) */
  charTimings?: TimedText[];
}

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface TtsProvider {
  id: string;
  label: string;
  tier: VoiceTier;
  /** 기본 목소리 (한국어) */
  defaultVoice: string;
  /** 필요한 환경 변수 (API 키 등). 키는 절대 데이터 파일이나 저장소에 넣지 않는다 */
  env: string[];
  note: string;
  available(): Availability;
  synthesize(text: string, opts: TtsOptions): Promise<TtsResult>;
}

export interface Aligner {
  id: string;
  label: string;
  available(): Availability;
  /** 음성 파일의 단어(또는 토큰)별 시간 */
  transcribeTimed(audioFile: string): Promise<TimedText[]>;
}

export interface CaptionCue {
  text: string;
  start: number;
  end: number;
}

/** 브랜드별 음성 설정 (brand.voice). 비우면 auto: 쓸 수 있는 무료 제공자를 자동 선택 */
export interface VoiceSettings {
  provider: string; // 'auto' | 제공자 id
  voice?: string;
  speed?: number;
  aligner?: 'auto' | 'whisper' | 'estimate';
  /** TTS를 넣을 때 원래 영상 소리를 얼마나 남길지 (0 = 끔, 기본 0.15) */
  originalAudioVolume?: number;
}
