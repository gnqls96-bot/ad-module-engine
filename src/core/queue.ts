import { Account, Batch, DB, RenderJob } from './types.js';
import { newId, now } from './store.js';
import { canSee, requireCanEdit } from './access.js';
import { materialCode } from './naming.js';

/**
 * 렌더 대기열 (설계서 "작업 대기열").
 * 렌더링 요청은 바로 실행하지 않고 작업으로 쌓는다. 작업자(worker)가 하나씩 가져가 처리한다.
 * 작업자를 여러 대 띄우면 처리량이 늘어난다 (claimNext가 한 작업을 한 작업자에게만 준다).
 */

export function enqueueBatch(db: DB, actor: Account, batch: Batch): { created: RenderJob[]; skipped: number } {
  requireCanEdit(actor, batch, '배치');
  if (batch.status === 'draft') throw new Error('관리자 승인 전인 배치예요. 관리자 계정으로 `ame batch approve`를 먼저 해주세요.');
  const brand = db.brands.find((b) => b.id === batch.brandId)!;
  const product = db.products.find((p) => p.id === batch.productId)!;
  const combos = db.combinations.filter((c) => c.batchId === batch.id && c.valid);
  if (!combos.length) throw new Error('검사를 통과한 조합이 없어요. `ame batch show`로 제외 이유를 확인하세요.');

  const created: RenderJob[] = [];
  let skipped = 0;
  for (const c of combos)
    for (const aspect of batch.aspects) {
      const code = materialCode(brand, product, c, aspect, batch.targetLength, batch.version);
      const existing = db.renderJobs.find((j) => j.materialCode === code && j.status !== 'failed');
      if (existing) {
        skipped++;
        continue;
      }
      const job: RenderJob = {
        id: newId('job'),
        batchId: batch.id,
        combinationId: c.id,
        aspect,
        materialCode: code,
        status: 'pending',
        attempts: 0,
        createdAt: now(),
        ownerId: batch.ownerId,
        scope: batch.scope,
      };
      db.renderJobs.push(job);
      created.push(job);
    }
  batch.status = 'queued';
  return { created, skipped };
}

export function claimNext(db: DB, workerId: string, batchId?: string): RenderJob | undefined {
  const job = db.renderJobs.find((j) => j.status === 'pending' && (!batchId || j.batchId === batchId));
  if (!job) return undefined;
  job.status = 'running';
  job.startedAt = now();
  job.workerId = workerId;
  job.attempts++;
  return job;
}

export function finishJob(db: DB, jobId: string, result: { output?: string; error?: string }) {
  const job = db.renderJobs.find((j) => j.id === jobId)!;
  job.finishedAt = now();
  if (result.error) {
    job.status = 'failed';
    job.error = result.error;
  } else {
    job.status = 'done';
    job.output = result.output;
  }
  const batch = db.batches.find((b) => b.id === job.batchId)!;
  const jobs = db.renderJobs.filter((j) => j.batchId === batch.id);
  if (jobs.every((j) => j.status === 'done' || j.status === 'failed')) batch.status = 'rendered';
}

/**
 * 작업자가 중간에 죽어 running으로 남은 작업을 다시 대기로 돌린다.
 * - 같은 컴퓨터의 작업자였고 그 프로세스가 이미 없으면 바로
 * - 다른 컴퓨터의 작업자면 olderThanMin분이 지난 뒤
 */
export function requeueStale(db: DB, host: string, olderThanMin = 30) {
  const limit = Date.now() - olderThanMin * 60_000;
  let n = 0;
  for (const j of db.renderJobs) {
    if (j.status !== 'running') continue;
    const [wHost, wPid] = splitWorker(j.workerId);
    const deadHere = wHost === host && wPid > 0 && !alive(wPid);
    const tooOld = j.startedAt !== undefined && Date.parse(j.startedAt) < limit;
    if (deadHere || tooOld) {
      j.status = 'pending';
      n++;
    }
  }
  return n;
}

const splitWorker = (id?: string): [string, number] => {
  const i = id?.lastIndexOf('-') ?? -1;
  return i < 0 ? ['', 0] : [id!.slice(0, i), Number(id!.slice(i + 1))];
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function jobsVisible(db: DB, viewer: Account) {
  return db.renderJobs.filter((j) => canSee(viewer, j));
}
