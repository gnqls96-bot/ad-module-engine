import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { ASPECTS, DB, effectiveDuration, RenderJob } from '../core/types.js';
import { loadBrandKit } from '../core/config.js';
import { Workspace } from '../core/workspace.js';
import { AdProps, FPS, Segment } from './remotion/props.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 렌더 작업 1건 = 조합 1개 × 비율 1개 → MP4 1개.
 * 모듈 영상은 작업 공간을 가리키는 로컬 파일 서버로 템플릿에 전달한다
 * (나중에 클라우드 렌더링으로 옮기면 이 주소만 저장소 URL로 바뀐다).
 */

let serveUrlCache: Promise<string> | null = null;
export function getServeUrl() {
  serveUrlCache ??= bundle({
    entryPoint: path.join(HERE, 'remotion', 'index.tsx'),
    publicDir: path.join(HERE, 'public'),
  });
  return serveUrlCache;
}

/** 이 컴퓨터에 설치된 Chrome 렌더러 경로 (지정하지 않으면 Remotion이 자동으로 내려받는다) */
export function browserExecutable(): string | undefined {
  if (process.env.AME_BROWSER) return process.env.AME_BROWSER;
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (d.startsWith('chromium_headless_shell') && fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aiff': 'audio/aiff',
};

export class MediaServer {
  private server?: http.Server;
  port = 0;
  constructor(private root: string) {}

  async start() {
    this.server = http.createServer((req, res) => {
      try {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
        const file = path.resolve(this.root, rel);
        if (!file.startsWith(path.resolve(this.root) + path.sep) || !fs.existsSync(file)) {
          res.writeHead(404).end();
          return;
        }
        const size = fs.statSync(file).size;
        const range = req.headers.range;
        const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
        if (range) {
          const [s, e] = range.replace('bytes=', '').split('-');
          const start = Number(s);
          const end = e ? Number(e) : size - 1;
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
          fs.createReadStream(file, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { ...headers, 'Content-Length': size });
          fs.createReadStream(file).pipe(res);
        }
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server!.address() as any).port;
    return this;
  }

  url(rel: string) {
    return `http://127.0.0.1:${this.port}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  }

  stop() {
    this.server?.close();
  }
}

export function buildProps(db: DB, job: RenderJob, media: MediaServer): { props: AdProps; outputAbs: (ws: Workspace) => string } {
  const combo = db.combinations.find((c) => c.id === job.combinationId)!;
  const batch = db.batches.find((b) => b.id === job.batchId)!;
  const brand = db.brands.find((b) => b.id === batch.brandId)!;
  const product = db.products.find((p) => p.id === batch.productId)!;
  const ids = [combo.hookId, combo.bridgeId, combo.storyId, combo.offerId].filter(Boolean) as string[];
  const size = ASPECTS[job.aspect];
  const origVol = brand.voice?.originalAudioVolume ?? 0.15;
  const segments: Segment[] = ids.map((id) => {
    const m = db.modules.find((x) => x.id === id)!;
    // 대사가 바뀌었는데 자막을 다시 맞추지 않았으면 옛 자막 대신 추정 자막을 쓴다
    const caps = m.captions && m.captions.text === m.transcript.trim() ? m.captions : undefined;
    const voice = m.voiceover && m.voiceover.text === m.transcript.trim() ? m.voiceover : undefined;
    const total = effectiveDuration({ media: m.media, voiceover: voice });
    const f = (s: number) => Math.round(s * FPS);
    return {
      kind: m.kind,
      code: m.code,
      src: media.url(m.file),
      durationInFrames: Math.max(1, f(total)),
      videoFrames: Math.max(1, f(m.media.durationSec)),
      transcript: m.transcript,
      letterbox: Math.abs(m.media.width / m.media.height - size.width / size.height) > 0.01,
      voiceSrc: voice ? media.url(voice.file) : undefined,
      originalVolume: origVol,
      cues: caps?.cues.map((c) => ({ text: c.text, from: f(c.start), durationInFrames: Math.max(1, f(c.end) - f(c.start)) })),
    };
  });
  const props: AdProps = {
    segments,
    width: size.width,
    height: size.height,
    fps: FPS,
    brandKit: loadBrandKit(brand),
    offer: batch.offerOverride ?? product.offer,
    materialCode: job.materialCode,
    showOfferCard: true,
  };
  return { props, outputAbs: (ws) => path.join(ws.renderDir(brand, product, batch.name), `${job.materialCode}.mp4`) };
}

export async function renderJob(ws: Workspace, db: DB, job: RenderJob, media: MediaServer, onProgress?: (p: number) => void) {
  const serveUrl = await getServeUrl();
  const { props, outputAbs } = buildProps(db, job, media);
  const out = outputAbs(ws);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const inputProps = props as unknown as Record<string, unknown>;
  const exe = browserExecutable();
  const composition = await selectComposition({ serveUrl, id: 'AdVideo', inputProps, browserExecutable: exe ?? null });
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: out,
    inputProps,
    browserExecutable: exe ?? null,
    concurrency: Number(process.env.AME_CONCURRENCY ?? Math.max(1, Math.min(4, os.cpus().length))),
    onProgress: ({ progress }) => onProgress?.(progress),
    logLevel: 'error',
  });
  return ws.rel(out);
}
