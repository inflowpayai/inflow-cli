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

  useEffect(() => {
    let cancelled = false;

    const finish = (result: T | null) => {
      setTimeout(() => {
        if (!cancelled) onCompleteRef.current(result);
      }, 0);
    };

    const run = async () => {
      try {
        const result = await action();
        if (cancelled) return;
        setData(result);
        setStatus('success');
        finish(result);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus('error');
        finish(null);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [action]);

  return { status, data, error };
}
