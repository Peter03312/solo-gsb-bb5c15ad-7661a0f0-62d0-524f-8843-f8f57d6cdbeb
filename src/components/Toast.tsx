import { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/context';

interface ToastData {
  id: number;
  text: string;
  kind: 'info' | 'warn';
}

let seq = 0;

/** 监听结构操作后的原子改写结果，弹出提示（文本编辑不提示） */
export function ToastHost() {
  const { store } = useApp();
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const lastInfo = useRef<{ rewritten: number; skipped: number; review: number; doc: unknown } | null>(null);

  useEffect(() => {
    return store.subscribe(() => {
      const snap = store.getSnapshot();
      const info = store.lastRewriteInfo;
      if (!info) return;
      const review = store.lastAnnotationReviewCount;
      const prev = lastInfo.current;
      // 仅在结构操作真正产生改写信息且文档引用身份变化时提示，避免文本编辑刷屏
      const isNewStructuralOp =
        !prev ||
        prev.rewritten !== info.rewritten ||
        prev.skipped !== info.skipped ||
        prev.review !== review;
      if (
        !isNewStructuralOp ||
        (info.rewritten === 0 && info.skipped === 0 && review === 0)
      ) {
        lastInfo.current = { ...info, review, doc: snap.doc };
        return;
      }
      lastInfo.current = { ...info, review, doc: snap.doc };
      const parts: string[] = [];
      if (info.rewritten > 0) {
        parts.push(`已原子更新 ${info.rewritten} 处可唯一定位的引用`);
      }
      if (info.skipped) {
        parts.push(`${info.skipped} 处歧义/断链未自动改写`);
      }
      if (review > 0) {
        parts.push(`${review} 条批注待复核（见右侧审阅批注）`);
      }
      const text =
        parts.length > 0
          ? parts.join('；')
          : `${info.skipped} 处引用无法唯一定位，未自动改写（见右侧问题列表）`;
      const id = ++seq;
      setToasts((t) => [...t.slice(-2), { id, text, kind: info.skipped || review ? 'warn' : 'info' }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
    });
  }, [store]);

  return (
    <>
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'warn' ? 'toast-warn' : ''}`}>
          {t.text}
        </div>
      ))}
    </>
  );
}
