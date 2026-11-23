import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../contracts/demo.ts';
import { api } from '../api.ts';

export function useDemoSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(-1);
  useEffect(() => {
    let disposed = false;
    const apply = (value: Snapshot) => {
      if (!disposed && value.eventId >= latest.current) { latest.current = value.eventId; setSnapshot(value); }
    };
    api.snapshot().then(apply).catch(e => { if (!disposed) setError((e as Error).message); });
    const unsubscribe = api.subscribe(value => { apply(value); setError(''); }, value => { if (!disposed) setConnected(value); });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  return { snapshot, connected, error };
}
