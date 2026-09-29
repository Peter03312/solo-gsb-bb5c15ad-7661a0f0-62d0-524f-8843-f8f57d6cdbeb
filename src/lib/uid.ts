let counter = 0;

/** 生成本地唯一 id，前缀区分节点类型便于调试 */
export function uid(prefix = 'n'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
