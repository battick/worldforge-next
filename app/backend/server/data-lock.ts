import Database from 'better-sqlite3';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** SQLite owns the OS lock until close or process death; never unlink this database. */
export function acquireDataLock(dataDir: string) {
  const mutex = new Database(path.join(dataDir, 'app-lock.sqlite'), { timeout: 0 });
  const marker = path.join(dataDir, 'app.lock');
  let owned = false;
  try {
    mutex.exec('BEGIN EXCLUSIVE');
    let previous: string | undefined;
    try { previous = readFileSync(marker, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (previous !== undefined) {
      const pid = Number(previous);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('数据锁文件无效，请确认没有服务使用此目录后移除 app.lock。');
      try { process.kill(pid, 0); throw new Error('此数据目录已被另一个 WorldForge 服务使用。请先关闭该服务。'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      unlinkSync(marker);
    }
    const fd = openSync(marker, 'wx');
    owned = true;
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
  } catch (e) {
    try { if (owned) unlinkSync(marker); } finally { mutex.close(); }
    if ((e as { code?: string }).code === 'SQLITE_BUSY') throw new Error('此数据目录已被另一个 WorldForge 服务使用。请先关闭该服务。');
    throw e;
  }
  return () => { try { unlinkSync(marker); } finally { mutex.close(); } };
}
