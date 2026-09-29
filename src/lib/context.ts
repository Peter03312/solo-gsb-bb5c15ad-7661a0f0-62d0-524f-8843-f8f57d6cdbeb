import { createContext, useContext } from 'react';
import type { AppStore } from './store';
import type { Highlighter } from './highlighter';

/** 正文批注标记点击 -> 侧栏批注面板聚焦的自定义事件名 */
export const ANN_FOCUS_EVENT = 'clause:annotation-focus';

/** 正文规范命中标记点击 -> 侧栏规范用语面板聚焦（并滚动到命中行）的事件名 */
export const TERM_FOCUS_EVENT = 'clause:term-focus';

/** 正文条卡片「审签」按钮 -> 侧栏条款审签面板聚焦该条的事件名 */
export const SIGNOFF_FOCUS_EVENT = 'clause:signoff-focus';

export const StoreContext = createContext<{ store: AppStore; highlighter: Highlighter } | null>(
  null,
);

export function useApp(): { store: AppStore; highlighter: Highlighter } {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('StoreContext 未初始化');
  return ctx;
}
