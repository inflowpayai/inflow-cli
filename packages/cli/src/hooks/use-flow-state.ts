import { useEffect, useRef, useState } from 'react';

export type FlowStatus = 'loading' | 'success' | 'error';

interface FlowState<T> {
  status: FlowStatus;
  data: T | null;
  error: string;
}

export function useFlowState<T>(action: () => Promise<T>, onComplete: (result: T | null) => void): FlowState<T> {
  const [status, setStatus] = useState<FlowStatus>('loading');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string>('');

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const completedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const result = await action();
        if (cancelled) return;
        setData(result);
        setStatus('success');
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus('error');
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [action]);

  useEffect(() => {
    if (status === 'loading' || completedRef.current) return;
    completedRef.current = true;
    const result = status === 'success' ? data : null;
    const handle = setTimeout(() => {
      onCompleteRef.current(result);
    }, 50);
    return () => clearTimeout(handle);
  }, [status, data]);

  return { status, data, error };
}
