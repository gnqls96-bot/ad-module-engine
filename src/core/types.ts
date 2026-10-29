/**
 * 핵심 데이터 타입.
 * 모든 레코드는 조직(workspace) 하나 안에 있고, 브랜드 → 제품 아래로 묶인다.
 * 레퍼런스·모듈·배치·렌더 작업은 소유자(ownerId)와 공개 범위(scope)를 가진다.
 */

export type Role = 'admin' | 'member';
export type Scope = 'common' | 'private';
export type ModuleKind = 'hook' | 'bridge' | 'story' | 'offer';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type BatchMode = 'hook-test' | 'offer-test' | 'story-test' | 'full';
export type BatchStatus = 'draft' | 'approved' | 'queued' | 'rendered';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type CheckStatus = 'pass' | 'warn' | 'fail';
export type Aspect = '916' | '45' | '11' | '169';

export const MODULE_KINDS: ModuleKind[] = ['hook', 'bridge', 'story', 'offer'];
export const KIND_PREFIX: Record<ModuleKind, string> = { hook: 'H', bridge: 'B', story: 'S', offer: 'O' };
export const KIND_LABEL: Record<ModuleKind, string> = { hook: '후킹', bridge: '브릿지', story: '스토리', offer: '오퍼' };
export const ASPECTS: Record<Aspect, { width: number; height: number; label: string }> = {
  '916': { width: 1080, height: 1920, label: '9:16' },
  '45': { width: 1080, height: 1350, label: '4:5' },
  '11': { width: 1080, height: 1080, label: '1:1' },
  '169': { width: 1920, height: 1080, label: '16:9' },
};

export interface Owned {
  ownerId: string;
  scope: Scope;
  /** 공통으로 올린 관리자 (원래 소유자는 ownerId에 그대로 남는다) */
  promotedBy?: string;
  promotedAt?: string;
}

export interface Account {
  id: string;
  name: string;
  email?: string;
  role: Role;
  status: 'active' | 'suspended';
  createdBy: string | null;
  createdAt: string;
}

export interface Org {
  id: string;
  name: string;
  createdAt: string;
}

export interface OfferData {
  price?: number;
  originalPrice?: number;
  discountRate?: number;
  deadline?: string;
  gift?: string;
  headline?: string;
  cta?: string;
}

export interface BrandKit {
  fontFamily: string;
  caption: {
    fontSize: number;
    fontWeight: number;
    color: string;
    strokeColor: string;
    strokeWidth: number;
    highlightColor: string;
    positionFromBottom: number;
    maxCharsPerLine: number;
  };
  offerCard: { background: string; textColor: string; accentColor: string; radius: number };
  transitionFrames: number;
  adNotice: string;
}

export interface Brand {
  id: string;
  code: string;
  name: string;
  industry: string;
  rulePackIds: string[];
  brandKit: Partial<BrandKit>;
  /** 브랜드별 분류 체계 추가·덮어쓰기 */
  taxonomyOverride?: Record<string, { label?: string; values?: Record<string, string> }>;
  /** true면 심의 통과 모듈만 조합에 쓴다 */
  requireReview: boolean;
  /** true면 팀원이 만든 배치는 관리자 승인 후 렌더링 */
  requireBatchApproval: boolean;
  /** 배치 안에서 같은 후킹 유형·화면 유형이 넘으면 안 되는 비율 (0~1) */
  diversityMaxShare: number;
  /** 음성 설정. 비우면 auto (쓸 수 있는 무료 제공자 자동 선택) */
  voice?: {
    provider: string;
    voice?: string;
    speed?: number;
    aligner?: 'auto' | 'whisper' | 'estimate';
    originalAudioVolume?: number;
  };
  createdBy: string;
  createdAt: string;
}

export interface Product {
  id: string;
  brandId: string;
  code: string;
  name: string;
  offer: OfferData;
  createdBy: string;
  createdAt: string;
}

export interface ModuleTags {
  hookType?: string;
  storyType?: string;
  offerType?: string;
  visualType?: string;
  target?: string;
}

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export interface SpecIssue {
  level: 'warn' | 'fail';
  message: string;
}

/** TTS로 만든 내레이션 (모듈 영상 위에 깔린다) */
export interface Voiceover {
  file: string; // 작업 공간 기준 상대 경로 (정규화된 .m4a)
  provider: string;
  voice: string;
  durationSec: number;
  /** 만들 때 쓴 대사. 대사가 바뀌면 다시 만들어야 하는지 판단하는 데 쓴다 */
  text: string;
  createdAt: string;
}

/** 자막 구간 (모듈 시작 기준 초) */
export interface ModuleCaptions {
  /** aligned: 받아쓰기로 맞춤 · provider: TTS가 준 타이밍 · estimated: 글자 수 비례 추정 */
  source: 'aligned' | 'provider' | 'estimated';
  /** 어떤 음성 기준인지: TTS 내레이션 / 모듈 영상 원래 소리 */
  audio: 'voiceover' | 'original';
  aligner?: string;
  text: string;
  cues: { text: string; start: number; end: number }[];
  createdAt: string;
}

export interface Module extends Owned {
  id: string;
  code: string;
  kind: ModuleKind;
  brandId: string;
  productId: string;
  /** 작업 공간 기준 상대 경로 */
  file: string;
  originalName: string;
  media: MediaInfo;
  specIssues: SpecIssue[];
  transcript: string;
  tags: ModuleTags;
  /** 이 모듈이 다룬 주제 등. 'topic:' 태그끼리는 조합 시 서로 맞아야 한다 */
  compatTags: string[];
  /** 이 태그를 가진 모듈과는 같이 쓰지 않는다 */
  excludeTags: string[];
  review: ReviewStatus;
  reviewNote?: string;
  reviewedBy?: string;
  /** 등록할 때 규칙 팩으로 자동 검사한 결과 */
  ruleFindings: RuleFinding[];
  voiceover?: Voiceover;
  captions?: ModuleCaptions;
  useCount: number;
  createdAt: string;
}

/** 조합 길이 계산용: 내레이션이 영상보다 길면 내레이션 길이(+여유)로 늘어난다 */
export function effectiveDuration(m: Pick<Module, 'media' | 'voiceover'>): number {
  const v = m.voiceover ? m.voiceover.durationSec + 0.25 : 0;
  return Math.round(Math.max(m.media.durationSec, v) * 1000) / 1000;
}

export interface RuleFinding {
  level: 'caution' | 'blocked';
  phrase: string;
  reason: string;
  rulePackId: string;
}

export interface Reference extends Owned {
  id: string;
  brandId?: string;
  title: string;
  source: string;
  url?: string;
  file?: string;
  /** 광고 게재 일수 등 효율 추정 지표 */
  runDays?: number;
  transcript?: string;
  tags: ModuleTags & { [k: string]: string | undefined };
  notes?: string;
  createdAt: string;
}

export interface CheckResult {
  name: 'compat' | 'review' | 'length' | 'diversity';
  status: CheckStatus;
  detail: string;
}

export interface Combination {
  id: string;
  batchId: string;
  hookId: string;
  bridgeId: string | null;
  storyId: string;
  offerId: string;
  /** 비율·길이를 뺀 조합 코드 (H014-B003-S007-O002) */
  comboCode: string;
  durationSec: number;
  checks: CheckResult[];
  valid: boolean;
}

export interface Batch extends Owned {
  id: string;
  name: string;
  brandId: string;
  productId: string;
  mode: BatchMode;
  targetLength: 15 | 30 | 60;
  aspects: Aspect[];
  status: BatchStatus;
  approvedBy?: string;
  /** 렌더링할 때 쓴 오퍼 데이터 (배치 생성 시점 제품 오퍼를 복사, 바꾸면 재렌더링) */
  offerOverride?: OfferData;
  version: number;
  createdAt: string;
}

export interface RenderJob extends Owned {
  id: string;
  batchId: string;
  combinationId: string;
  aspect: Aspect;
  /** 이 작업을 만들 때의 배치 버전 (오퍼를 바꾸면 배치 버전이 올라가 새 작업이 생긴다) */
  batchVersion: number;
  /** 전체 작업 공간에서 유일. 다른 배치에 같은 조합이 있으면 버전 숫자가 올라간다 */
  materialCode: string;
  status: JobStatus;
  output?: string;
  error?: string;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  workerId?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  action: string;
  target?: string;
  detail?: string;
}

export interface DB {
  schemaVersion: number;
  org: Org | null;
  accounts: Account[];
  brands: Brand[];
  products: Product[];
  modules: Module[];
  references: Reference[];
  batches: Batch[];
  combinations: Combination[];
  renderJobs: RenderJob[];
  audit: AuditEntry[];
}

export const EMPTY_DB = (): DB => ({
  schemaVersion: 1,
  org: null,
  accounts: [],
  brands: [],
  products: [],
  modules: [],
  references: [],
  batches: [],
  combinations: [],
  renderJobs: [],
  audit: [],
});
