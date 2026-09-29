import { useEffect, useState } from 'react';
import { useApp } from './context';

/** store 快照变化时强制重渲染的便捷 hook */
export function useStoreVersion(): number {
  const { store } = useApp();
  const [v, setV] = useState(0);
  useEffect(() => {
    return store.subscribe(() => setV((n) => n + 1));
  }, [store]);
  return v;
}
