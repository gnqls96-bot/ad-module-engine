import { Account, Batch, DB } from './types.js';
import { materialCode } from './naming.js';

/** 배치 조합 목록 CSV (엑셀·구글 시트에서 바로 열 수 있게 BOM 포함) */
export function batchCsv(db: DB, batch: Batch): string {
  const brand = db.brands.find((b) => b.id === batch.brandId)!;
  const product = db.products.find((p) => p.id === batch.productId)!;
  const mod = (id: string | null) => (id ? db.modules.find((m) => m.id === id) : undefined);
  const owner = db.accounts.find((a) => a.id === batch.ownerId)?.name ?? '';
  const header = ['소재코드', '비율', '조합코드', '후킹', '후킹유형', '브릿지', '스토리', '오퍼', '길이(초)', '통과', '호환', '심의', '길이검사', '다양성', '렌더상태', '파일', '만든사람', '배치'];
  const rows: string[][] = [];
  for (const c of db.combinations.filter((x) => x.batchId === batch.id)) {
    const h = mod(c.hookId)!;
    const chk = (n: string) => {
      const x = c.checks.find((k) => k.name === n);
      return x ? `${x.status}: ${x.detail}` : '';
    };
    const aspects = c.valid ? batch.aspects : [batch.aspects[0]];
    for (const aspect of aspects) {
      const code = c.valid ? materialCode(brand, product, c, aspect, batch.targetLength, batch.version) : '';
      const job = code ? db.renderJobs.find((j) => j.materialCode === code) : undefined;
      rows.push([
        code,
        c.valid ? aspect : '',
        c.comboCode,
        h.code,
        h.tags.hookType ?? '',
        mod(c.bridgeId)?.code ?? 'B000',
        mod(c.storyId)!.code,
        mod(c.offerId)!.code,
        String(c.durationSec),
        c.valid ? 'O' : 'X',
        chk('compat'),
        chk('review'),
        chk('length'),
        chk('diversity'),
        job?.status ?? (c.valid ? '대기열 전' : '제외'),
        job?.output ?? '',
        owner,
        batch.name,
      ]);
    }
  }
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

/** 관리자용: 팀원별 제작 현황 (팀 KPI의 원천 데이터) */
export function memberSummary(db: DB) {
  return db.accounts.map((a: Account) => {
    const batches = db.batches.filter((b) => b.ownerId === a.id);
    const jobs = db.renderJobs.filter((j) => j.ownerId === a.id);
    return {
      name: a.name,
      role: a.role,
      status: a.status,
      references: db.references.filter((r) => r.ownerId === a.id).length,
      modules: db.modules.filter((m) => m.ownerId === a.id).length,
      batches: batches.length,
      approvedBatches: batches.filter((b) => b.status !== 'draft').length,
      rendered: jobs.filter((j) => j.status === 'done').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
    };
  });
}
