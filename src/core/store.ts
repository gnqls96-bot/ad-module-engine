import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DB, EMPTY_DB } from './types.js';

/**
 * 저장소 인터페이스.
 * 뼈대는 JSON 파일(JsonStore)로 동작하고, 다음 단계에서 같은 인터페이스로 Supabase 구현을 붙인다.
 * 모든 쓰기는 transact() 안에서 일어나 한 번에 저장된다.
 */
export interface Store {
  read(): DB;
  transact<T>(fn: (db: DB) => T): T;
}

export class JsonStore implements Store {
  private file: string;
  private lockFile: string;

  constructor(private dir: string) {
    this.file = path.join(dir, 'db.json');
    this.lockFile = path.join(dir, 'db.lock');
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!this.exists()) this.writeRaw(EMPTY_DB());
  }

  read(): DB {
    if (!this.exists()) return EMPTY_DB();
    return JSON.parse(fs.readFileSync(this.file, 'utf8')) as DB;
  }

  transact<T>(fn: (db: DB) => T): T {
    this.lock();
    try {
      const db = this.read();
      const result = fn(db);
      this.writeRaw(db);
      return result;
    } finally {
      this.unlock();
    }
  }

  private writeRaw(db: DB) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** CLI와 렌더 작업자가 동시에 쓰지 않도록 하는 단순 파일 잠금 */
  private lock() {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        // 잠금을 잡은 프로세스가 죽었으면 잠금을 푼다
        try {
          const pid = Number(fs.readFileSync(this.lockFile, 'utf8'));
          if (pid && !isAlive(pid)) fs.rmSync(this.lockFile, { force: true });
        } catch {}
        if (Date.now() > deadline) throw new Error('데이터 파일 잠금을 얻지 못했습니다 (다른 작업이 진행 중일 수 있어요).');
        sleep(50);
      }
    }
  }

  private unlock() {
    fs.rmSync(this.lockFile, { force: true });
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
export const now = () => new Date().toISOString();
