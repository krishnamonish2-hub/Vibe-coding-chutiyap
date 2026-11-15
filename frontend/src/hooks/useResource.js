import { useCallback, useEffect, useRef, useState } from 'react';

// Loads data with `fetcher(signal)`, optionally polling. Returns { data, error, loading, reload }.
// `loading` is true only for the first load; later polls update data silently. Errors keep the last good data.
export function useResource(fetcher, deps = [], { pollMs = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async (signal) => {
    try {
      const data = await fetcherRef.current(signal);
      setState({ data, error: null, loading: false });
    } catch (err) {
      if (err.name === 'AbortError') return;
      setState((s) => ({ data: s.data, error: err, loading: false }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: s.data === null }));
    load(controller.signal);
    const timer = pollMs > 0 ? setInterval(() => load(controller.signal), pollMs) : null;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, pollMs, load]);

  const reload = useCallback(() => load(undefined), [load]);
  return { ...state, reload };
}
