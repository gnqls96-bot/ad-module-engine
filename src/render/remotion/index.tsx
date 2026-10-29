import React from 'react';
import { Composition, registerRoot, staticFile } from 'remotion';
import { loadFont } from '@remotion/fonts';
import { AdVideo } from './AdVideo';
import { AdProps, FPS } from './props';

// 한글 웹폰트 (Pretendard, OFL). 브랜드 키트에서 다른 폰트를 쓰려면 public/fonts에 넣고 여기서 불러온다
for (const [file, weight] of [
  ['Pretendard-Regular.woff2', '400'],
  ['Pretendard-Bold.woff2', '700'],
  ['Pretendard-ExtraBold.woff2', '800'],
] as const) {
  loadFont({ family: 'Pretendard', url: staticFile(`fonts/${file}`), weight });
}

const defaults: AdProps = {
  segments: [],
  width: 1080,
  height: 1920,
  fps: FPS,
  brandKit: {
    fontFamily: 'Pretendard',
    caption: { fontSize: 58, fontWeight: 800, color: '#fff', strokeColor: '#000', strokeWidth: 8, highlightColor: '#FFE14D', positionFromBottom: 0.24, maxCharsPerLine: 16 },
    offerCard: { background: '#fff', textColor: '#111', accentColor: '#E8322F', radius: 36 },
    transitionFrames: 6,
    adNotice: '광고',
  },
  offer: {},
  materialCode: 'PREVIEW',
  showOfferCard: true,
};

const Root: React.FC = () => (
  <Composition
    id="AdVideo"
    component={AdVideo as unknown as React.FC<Record<string, unknown>>}
    defaultProps={defaults as unknown as Record<string, unknown>}
    fps={FPS}
    width={1080}
    height={1920}
    durationInFrames={30}
    calculateMetadata={({ props }) => {
      const p = props as unknown as AdProps;
      const total = p.segments.reduce((t, s) => t + s.durationInFrames, 0);
      return { durationInFrames: Math.max(1, total), width: p.width, height: p.height, fps: p.fps };
    }}
  />
);

registerRoot(Root);
