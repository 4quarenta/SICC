import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const isTemporaryFileLock = error => ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);

export async function retryFileOperation(operation, { maxAttempts = 12, wait = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!isTemporaryFileLock(error) || attempt + 1 >= maxAttempts) throw error;
      await wait(Math.min(1000, 40 * 2 ** attempt));
    }
  }
}

export async function atomicWrite(path, data) {
  const temp = `${path}.part-${process.pid}-${randomUUID()}`;
  try {
    const file = await retryFileOperation(() => open(temp, 'wx'));
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    // Never unlink the destination to work around a lock: the prior complete
    // JSON/image must remain available until its replacement can be committed.
    await retryFileOperation(() => rename(temp, path));
  } finally {
    await unlink(temp).catch(() => {});
  }
}
