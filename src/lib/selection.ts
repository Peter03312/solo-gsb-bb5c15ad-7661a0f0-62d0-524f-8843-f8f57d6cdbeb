import { useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * 正文渲染容器内 DOM Selection ↔ 原正文字符序列的换算。
 *
 * 渲染出的 DOM 是把节点正文按字符顺序线性排列的片段集合：普通文本段为
 * Text 节点，规范用语标记 / 批注标记为 <mark>，引用为 <button>（其内文本
 * 仍等于原文中的引用文字）。因此把容器内全部 Text 节点按文档序拼接后
 * 与 node.text 完全一致。
 *
 * 选区端点（Range 的 startContainer/endContainer）既可能落在 Text 节点
 * 内部，也可能落在 <mark>/<button> 等元素的边界上（offset 为子节点序）。
 * 下面按「边界点之前文本节点字符总量」的统一定义换算，嵌套元素边界与
 * 引用 chip 边界都能得到按原正文字符序列的准确偏移。
 */

/** 适配不同宿主（浏览器 DOM / 测试用简化树）的最小结构接口 */
export interface SeqNodeAdapter<TNode> {
  isText: (node: TNode) => boolean;
  isSame: (a: TNode, b: TNode) => boolean;
  contains: (container: TNode, node: TNode) => boolean;
  /** Text 节点的完整字符串 */
  textOf: (node: TNode) => string;
  textLength: (node: TNode) => number;
  parent: (node: TNode) => TNode | null;
  childCount: (node: TNode) => number;
  childAt: (node: TNode, index: number) => TNode;
}

/** 浏览器 DOM 适配 */
export const domSeqAdapter: SeqNodeAdapter<Node> = {
  isText: (node) => node.nodeType === Node.TEXT_NODE,
  isSame: (a, b) => a === b,
  contains: (container, node) => container.contains(node),
  textOf: (node) => (node.textContent ?? ''),
  textLength: (node) => node.textContent?.length ?? 0,
  parent: (node) => node.parentNode,
  childCount: (node) => node.childNodes.length,
  childAt: (node, index) => node.childNodes[index],
};

/** 节点内全部文本长度（按文档序拼接所有 Text 节点） */
function subtreeLength<TNode>(adapter: SeqNodeAdapter<TNode>, node: TNode): number {
  if (adapter.isText(node)) return adapter.textLength(node);
  let total = 0;
  const n = adapter.childCount(node);
  for (let i = 0; i < n; i++) total += subtreeLength(adapter, adapter.childAt(node, i));
  return total;
}

/**
 * 边界点（node + offset）之前、在 container 内的字符数。
 *
 * - Text 节点：前序兄弟子树字符 + 节点内 offset 个字符；
 * - 元素节点：前序兄弟子树字符 + offset 个前导子女子树字符（offset 为
 *   子节点序，落在 <mark>/<button> 等嵌套元素边界时同样成立）。
 *
 * offset 超出实际范围时按起止位置钳制；边界点不属于 container 返回 null。
 */
export function boundaryOffset<TNode>(
  adapter: SeqNodeAdapter<TNode>,
  container: TNode,
  node: TNode,
  offset: number,
): number | null {
  if (!adapter.contains(container, node)) return null;
  if (adapter.isSame(node, container)) {
    let total = 0;
    const n = Math.min(Math.max(0, offset), adapter.childCount(container));
    for (let i = 0; i < n; i++) total += subtreeLength(adapter, adapter.childAt(container, i));
    return total;
  }
  let total = 0;
  // 边界点在 Text 节点内部时计入节点内前导字符
  if (adapter.isText(node)) {
    total += Math.min(Math.max(0, offset), adapter.textLength(node));
  } else {
    const n = Math.min(Math.max(0, offset), adapter.childCount(node));
    for (let i = 0; i < n; i++) total += subtreeLength(adapter, adapter.childAt(node, i));
  }
  // 沿祖先链累加各层前序兄弟子树的字符
  let cur: TNode = node;
  for (;;) {
    const p = adapter.parent(cur);
    if (p === null || !adapter.contains(container, p)) break;
    if (adapter.isSame(p, container)) {
      // 父即容器：累加 cur 之前的兄弟
      const n = adapter.childCount(p);
      for (let i = 0; i < n; i++) {
        const ch = adapter.childAt(p, i);
        if (adapter.isSame(ch, cur)) return total;
        total += subtreeLength(adapter, ch);
      }
      return total;
    }
    const idx = (() => {
      const n = adapter.childCount(p);
      for (let i = 0; i < n; i++) {
        if (adapter.isSame(adapter.childAt(p, i), cur)) return i;
      }
      return -1;
    })();
    if (idx < 0) break;
    for (let i = 0; i < idx; i++) total += subtreeLength(adapter, adapter.childAt(p, i));
    cur = p;
  }
  return adapter.isSame(node, container) ? 0 : total;
}

/** 容器内 Text 节点按文档序拼接后的完整字符串（应等于节点正文） */
export function linearText<TNode>(adapter: SeqNodeAdapter<TNode>, container: TNode): string {
  if (adapter.isText(container)) return adapter.textOf(container);
  let out = '';
  const walk = (node: TNode): void => {
    if (adapter.isText(node)) {
      out += adapter.textOf(node);
      return;
    }
    const n = adapter.childCount(node);
    for (let i = 0; i < n; i++) walk(adapter.childAt(node, i));
  };
  walk(container);
  return out;
}

/** 拖动手势判定的位移阈值（px） */
const DRAG_THRESHOLD = 4;

/** 文档级最近一次选区变化时间（所有手势判定共用一个监听器） */
let lastSelectionChangeAt = 0;
let selectionListenerInstalled = false;
function ensureSelectionListener(): void {
  if (selectionListenerInstalled || typeof document === 'undefined') return;
  document.addEventListener('selectionchange', () => {
    lastSelectionChangeAt = Date.now();
  });
  selectionListenerInstalled = true;
}

/**
 * 识别一次鼠标手势（mousedown → click）是否产生了非折叠选区。
 *
 * - 按下到松开位移超过阈值 → 鼠标拖选；
 * - 未位移但按下之后选区发生变化（双击选词、三击选行、Shift+click 扩展
 *   选区等）→ 选区手势收尾。
 *
 * 选区在手势前后保持不变不算：先在别处选好文字、再单击引用 chip 仍按
 * 普通单击处理（跳转）。返回的 onMouseDown 直接挂到需要判定的元素上。
 */
export function useSelectionGesture(): {
  onMouseDown: (e: ReactMouseEvent) => void;
  /** click 事件处理开头调用：true 表示本次 click 是选区手势收尾 */
  isTailClick: (e: ReactMouseEvent) => boolean;
} {
  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  const downAtRef = useRef(0);

  useEffect(() => {
    ensureSelectionListener();
  }, []);

  return {
    onMouseDown: (e: ReactMouseEvent) => {
      downPosRef.current = { x: e.clientX, y: e.clientY };
      downAtRef.current = Date.now();
    },
    isTailClick: (e: ReactMouseEvent) => {
      const pos = downPosRef.current;
      const downAt = downAtRef.current;
      downPosRef.current = null;
      if (!pos) return false;
      if (Math.hypot(e.clientX - pos.x, e.clientY - pos.y) > DRAG_THRESHOLD) return true;
      // 按下之后发生过选区变化（双击 / 三击 / Shift+click 等无位移选法）
      return lastSelectionChangeAt > downAt;
    },
  };
}
