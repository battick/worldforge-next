import { useEffect, useState } from 'react';

/** Check the frontend's own static build stamp, independently of the data API. */
export function useWebUpdate() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (document.hidden || checking || controller.signal.aborted) return;
      checking = true;
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}web-version.json`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) return;
        const version: unknown = await response.json();
        if (version && typeof version === 'object' && 'buildId' in version && typeof version.buildId === 'string' && version.buildId.length > 0 && version.buildId !== import.meta.env.WORLDFORGE_WEB_BUILD_ID && !controller.signal.aborted) setAvailable(true);
      } catch { /* An unavailable update check must not block editing. */ }
      finally { checking = false; }
    };
    const foreground = () => { void check(); };
    foreground();
    const timer = window.setInterval(foreground, 30_000);
    window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground); };
  }, []);
  return available;
}
