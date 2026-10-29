/** 터미널 표 출력 (한글 폭 2칸 계산) */
const width = (s: string) => [...s].reduce((w, ch) => w + (/[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 2 : 1), 0);
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)));

export function table(rows: Record<string, unknown>[], cols?: string[]) {
  if (!rows.length) return '(없음)';
  const keys = cols ?? Object.keys(rows[0]);
  const cells = rows.map((r) => keys.map((k) => fmt(r[k])));
  const w = keys.map((k, i) => Math.min(60, Math.max(width(k), ...cells.map((c) => width(c[i])))));
  const cut = (s: string, n: number) => {
    if (width(s) <= n) return s;
    let out = '';
    for (const ch of s) {
      if (width(out + ch) > n - 1) break;
      out += ch;
    }
    return out + '…';
  };
  const line = (vals: string[]) => vals.map((v, i) => pad(cut(v, w[i]), w[i])).join('  ');
  return [line(keys), line(w.map((n) => '─'.repeat(n))), ...cells.map(line)].join('\n');
}

const fmt = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

export const ok = (s: string) => console.log(`✔ ${s}`);
export const warn = (s: string) => console.log(`⚠ ${s}`);
export const info = (s: string) => console.log(s);
