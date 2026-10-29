import os from 'node:os';
import { Workspace } from '../core/workspace.js';
import { claimNext, finishJob, requeueStale } from '../core/queue.js';
import { MediaServer, renderJob } from './renderer.js';

/**
 * 렌더 작업자. 대기열에서 작업을 하나씩 꺼내 렌더링한다.
 * 같은 작업 공간을 바라보는 작업자를 여러 개 띄우면 나눠서 처리한다.
 */
export async function runWorker(ws: Workspace, opts: { once?: boolean; batchId?: string; log?: (s: string) => void } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const workerId = `${os.hostname()}-${process.pid}`;
  const revived = ws.store.transact((db) => requeueStale(db, os.hostname()));
  if (revived) log(`↺ 중단됐던 작업 ${revived}건을 다시 대기열로`);
  const media = await new MediaServer(ws.root).start();
  let done = 0, failed = 0;
  try {
    for (;;) {
      const job = ws.store.transact((db) => claimNext(db, workerId, opts.batchId));
      if (!job) break;
      const db = ws.store.read();
      const t0 = Date.now();
      log(`▶ 렌더링 ${job.materialCode}`);
      try {
        let last = 0;
        const output = await renderJob(ws, db, job, media, (p) => {
          const pct = Math.floor(p * 100);
          if (pct >= last + 25) {
            last = pct;
            log(`   ${pct}%`);
          }
        });
        ws.store.transact((d) => finishJob(d, job.id, { output }));
        done++;
        log(`✔ 완료 ${output} (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
      } catch (e: any) {
        ws.store.transact((d) => finishJob(d, job.id, { error: String(e?.message ?? e) }));
        failed++;
        log(`✖ 실패 ${job.materialCode}: ${e?.message ?? e}`);
      }
      if (opts.once) break;
    }
  } finally {
    media.stop();
  }
  return { done, failed };
}
