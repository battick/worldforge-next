import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';

export interface DirtyHandle { dirty(): boolean }
export function useDirtyGuard(ref: Ref<DirtyHandle> | undefined, dirty: () => boolean) {
  const current = useRef(dirty); current.current = dirty;
  useImperativeHandle(ref, () => ({ dirty: () => current.current() }), []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (current.current()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);
}
