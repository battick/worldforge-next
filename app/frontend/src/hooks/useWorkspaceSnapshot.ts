import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceState } from '../../../contracts/workspace.ts';
import { api, WORKSPACE_CHANGED } from '../api.ts';

/** Refresh names and protection choices without remounting any editing form. */
export function useWorkspaceSnapshot() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(), [error, setError] = useState('');
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const { state } = await api.workspace();
      if (mounted.current) { setWorkspace(current => !current || state.revision >= current.revision ? state : current); setError(''); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const update = () => { void refresh(); }, visible = () => { if (document.visibilityState === 'visible') update(); };
    window.addEventListener(WORKSPACE_CHANGED, update); window.addEventListener('focus', update); document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; window.removeEventListener(WORKSPACE_CHANGED, update); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  return { workspace, error, refresh };
}
