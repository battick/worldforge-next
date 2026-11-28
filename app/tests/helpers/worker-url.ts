import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** A failed startup owns its child until it is stopped; callers never lose the handle. */
export function workerUrl(child: ChildProcessByStdio<null, Readable, Readable>, timeout = 15_000) {
  return new Promise<string>((resolve, reject) => {
    let output = '', settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', fail);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; cleanup();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.once('close', () => reject(error)); child.kill('SIGKILL');
      } else reject(error);
    };
    const onExit = (code: number | null) => fail(new Error(`子进程退出 ${code}`));
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match && !settled) { settled = true; cleanup(); resolve(match[0]); }
    };
    const timer = setTimeout(() => fail(new Error('子进程未启动')), timeout);
    child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', fail);
  });
}
