import { Store } from '../../backend/server/store.ts';

let store: Store | undefined;
process.on('message', message => {
  if (message === 'open') {
    try { store = new Store(process.argv[2]!); process.send!({ type: 'opened' }); }
    catch { process.send!({ type: 'rejected' }); process.disconnect(); }
  }
  if (message === 'close') { store?.close(); process.disconnect(); }
});
process.send!({ type: 'ready' });
