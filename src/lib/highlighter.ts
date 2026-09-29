import { useSyncExternalStore } from 'react';

export interface HighlightState {
  /** 悬停中的引用 key（正文 <-> 关系图联动） */
  hoverRefKey: string | null;
  /** 悬停引用对应的目标节点集合（组合引用可同时多个，目标卡片发光） */
  hoverTargetNodeIds: string[];
  /** 当前聚焦节点（问题跳转 / 点击引用目标） */
  activeNodeId: string | null;
  /** 点击边或问题时锁定的来源引用 key */
  activeRefKey: string | null;
  /** 问题跳转时高亮的源句区间 */
  focusSentence: { nodeId: string; start: number; end: number } | null;
  /** 批注跳转时高亮的片段区间（按批注在正文中的当前定位） */
  focusAnnotation: { annotationId: string; nodeId: string; start: number; end: number } | null;
  /** 规范用语命中跳转时高亮的区间 */
  focusTerm: { termKey: string; nodeId: string; start: number; end: number } | null;
  /** 用于触发滚动的自增序号 */
  focusNonce: number;
}

const initial: HighlightState = {
  hoverRefKey: null,
  hoverTargetNodeIds: [],
  activeNodeId: null,
  activeRefKey: null,
  focusSentence: null,
  focusAnnotation: null,
  focusTerm: null,
  focusNonce: 0,
};

/** 引用高亮 / 跳转的跨组件联动状态 */
export class Highlighter {
  private state: HighlightState = initial;
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): HighlightState => this.state;

  private set(patch: Partial<HighlightState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  hover(refKey: string | null): void {
    this.set({ hoverRefKey: refKey });
  }

  /** 悬停引用时：标记引用本身 + 全部目标节点发光（不影响跳转用的 activeNodeId） */
  hoverRef(refKey: string | null, targetNodeIds: string[] | null): void {
    this.set({ hoverRefKey: refKey, hoverTargetNodeIds: refKey ? (targetNodeIds ?? []) : [] });
  }

  activateNode(nodeId: string): void {
    this.set({ hoverTargetNodeIds: nodeId ? [nodeId] : [] });
  }

  /** 问题跳转：聚焦源句；附带引用时同时锁定引用 */
  jumpTo(
    nodeId: string,
    sentence?: { start: number; end: number },
    refKey?: string,
  ): void {
    this.set({
      activeNodeId: nodeId,
      focusSentence: sentence ? { nodeId, ...sentence } : null,
      focusAnnotation: null,
      focusTerm: null,
      activeRefKey: refKey ?? null,
      focusNonce: this.state.focusNonce + 1,
    });
  }

  /** 批注跳转：聚焦批注所在节点并高亮其引用片段 */
  jumpToAnnotation(
    annotationId: string,
    nodeId: string,
    range: { start: number; end: number },
  ): void {
    this.set({
      activeNodeId: nodeId,
      focusSentence: null,
      focusAnnotation: { annotationId, nodeId, ...range },
      focusTerm: null,
      activeRefKey: null,
      focusNonce: this.state.focusNonce + 1,
    });
  }

  /** 规范用语命中跳转：聚焦命中所在节点并高亮该变体片段 */
  jumpToTerm(
    termKey: string,
    nodeId: string,
    range: { start: number; end: number },
  ): void {
    this.set({
      activeNodeId: nodeId,
      focusSentence: null,
      focusAnnotation: null,
      focusTerm: { termKey, nodeId, ...range },
      activeRefKey: null,
      focusNonce: this.state.focusNonce + 1,
    });
  }

  clear(): void {
    this.state = { ...initial };
    this.listeners.forEach((l) => l());
  }
}

export function useHighlighter(h: Highlighter): HighlightState {
  return useSyncExternalStore(h.subscribe, h.getSnapshot);
}
