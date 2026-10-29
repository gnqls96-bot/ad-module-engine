import React from 'react';
import { AbsoluteFill, interpolate, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { AdProps, Segment } from './props';
import { timeCaptions, toLines } from './captions';

/**
 * 광고 템플릿 1종.
 * - 모듈 영상을 순서대로 잇고, 경계마다 짧은 페이드
 * - 다른 비율로 바꿀 때: 흐린 배경 + 원본을 가운데 맞춤 (잘리는 부분 없음)
 * - 자막: 모듈 대사를 브랜드 키트 스타일로
 * - 오퍼 카드: 가격·할인율·마감일·사은품을 데이터로 그린다 (숫자를 바꾸면 다시 렌더링만 하면 됨)
 * - 광고 표기: 왼쪽 위 고정
 */
export const AdVideo: React.FC<AdProps> = (props) => {
  const { segments, brandKit } = props;
  let from = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000', fontFamily: `${brandKit.fontFamily}, sans-serif` }}>
      {segments.map((s, i) => {
        const start = from;
        from += s.durationInFrames;
        return (
          <Sequence key={i} from={start} durationInFrames={s.durationInFrames} name={`${s.kind} ${s.code}`}>
            <SegmentView seg={s} first={i === 0} props={props} />
          </Sequence>
        );
      })}
      {brandKit.adNotice ? <AdNotice text={brandKit.adNotice} scale={props.width / 1080} /> : null}
    </AbsoluteFill>
  );
};

const SegmentView: React.FC<{ seg: Segment; first: boolean; props: AdProps }> = ({ seg, first, props }) => {
  const frame = useCurrentFrame();
  const { brandKit } = props;
  const t = brandKit.transitionFrames;
  const fadeIn = first ? 1 : interpolate(frame, [0, t], [0, 1], { extrapolateRight: 'clamp' });
  const captions = timeCaptions(seg.transcript, seg.durationInFrames, brandKit.caption.maxCharsPerLine);
  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <FittedVideo src={seg.src} letterbox={seg.letterbox} />
      {captions.map((c, i) => (
        <Sequence key={i} from={c.from} durationInFrames={c.durationInFrames} layout="none">
          <Caption text={c.text} props={props} />
        </Sequence>
      ))}
      {seg.kind === 'offer' && props.showOfferCard ? <OfferCard props={props} /> : null}
    </AbsoluteFill>
  );
};

/** 원본 비율을 유지한 채 출력 비율에 맞춘다: 뒤는 흐린 확대본, 앞은 잘림 없는 원본 */
const FittedVideo: React.FC<{ src: string; letterbox: boolean }> = ({ src, letterbox }) =>
  letterbox ? (
    <AbsoluteFill>
      <AbsoluteFill style={{ filter: 'blur(28px) brightness(0.55)', transform: 'scale(1.15)' }}>
        <OffthreadVideo src={src} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </AbsoluteFill>
      <AbsoluteFill>
        <OffthreadVideo src={src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </AbsoluteFill>
    </AbsoluteFill>
  ) : (
    <AbsoluteFill>
      <OffthreadVideo src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </AbsoluteFill>
  );

const Caption: React.FC<{ text: string; props: AdProps }> = ({ text, props }) => {
  const { width, height, brandKit } = props;
  const c = brandKit.caption;
  const scale = width / 1080;
  const lines = toLines(text, c.maxCharsPerLine);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: height * c.positionFromBottom }}>
      <div style={{ textAlign: 'center', padding: `0 ${60 * scale}px` }}>
        {lines.map((l, i) => (
          <div
            key={i}
            style={{
              fontSize: c.fontSize * scale,
              fontWeight: c.fontWeight,
              color: c.color,
              lineHeight: 1.25,
              letterSpacing: '-0.02em',
              WebkitTextStroke: `${c.strokeWidth * scale}px ${c.strokeColor}`,
              paintOrder: 'stroke fill',
              wordBreak: 'keep-all',
            }}
          >
            {l}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const won = (n?: number) => (n === undefined ? '' : `${n.toLocaleString('ko-KR')}원`);

const OfferCard: React.FC<{ props: AdProps }> = ({ props }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, offer, brandKit } = props;
  const k = brandKit.offerCard;
  const s = width / 1080;
  const rise = interpolate(frame, [0, Math.round(fps * 0.4)], [60, 0], { extrapolateRight: 'clamp' });
  const op = interpolate(frame, [0, Math.round(fps * 0.3)], [0, 1], { extrapolateRight: 'clamp' });
  const portrait = height > width;
  return (
    <AbsoluteFill style={{ justifyContent: portrait ? 'flex-start' : 'center', alignItems: 'center', paddingTop: portrait ? height * 0.12 : 0 }}>
      <div
        style={{
          transform: `translateY(${rise * s}px)`,
          opacity: op,
          width: width * (portrait ? 0.82 : 0.5),
          background: k.background,
          color: k.textColor,
          borderRadius: k.radius * s,
          padding: `${44 * s}px ${48 * s}px`,
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          textAlign: 'center',
        }}
      >
        {offer.headline ? <div style={{ fontSize: 46 * s, fontWeight: 800, marginBottom: 16 * s, wordBreak: 'keep-all' }}>{offer.headline}</div> : null}
        {offer.originalPrice ? (
          <div style={{ fontSize: 38 * s, opacity: 0.5, textDecoration: 'line-through', fontWeight: 600 }}>{won(offer.originalPrice)}</div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: 20 * s }}>
          {offer.discountRate ? <span style={{ fontSize: 76 * s, fontWeight: 800, color: k.accentColor }}>{offer.discountRate}%</span> : null}
          {offer.price !== undefined ? <span style={{ fontSize: 76 * s, fontWeight: 800 }}>{won(offer.price)}</span> : null}
        </div>
        {offer.gift ? <div style={{ marginTop: 18 * s, fontSize: 36 * s, fontWeight: 700 }}>+ {offer.gift}</div> : null}
        {offer.deadline ? <div style={{ marginTop: 12 * s, fontSize: 32 * s, fontWeight: 600, color: k.accentColor }}>{offer.deadline}까지</div> : null}
        {offer.cta ? (
          <div style={{ marginTop: 28 * s, display: 'inline-block', background: k.accentColor, color: '#fff', borderRadius: 999, padding: `${16 * s}px ${44 * s}px`, fontSize: 36 * s, fontWeight: 800 }}>
            {offer.cta}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

const AdNotice: React.FC<{ text: string; scale: number }> = ({ text, scale }) => (
  <div
    style={{
      position: 'absolute',
      top: 48 * scale,
      left: 40 * scale,
      fontSize: 28 * scale,
      fontWeight: 700,
      color: '#fff',
      background: 'rgba(0,0,0,0.45)',
      borderRadius: 10 * scale,
      padding: `${6 * scale}px ${16 * scale}px`,
    }}
  >
    {text}
  </div>
);
