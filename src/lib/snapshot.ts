import type { Annotation, ClauseDocument, DocSnapshot, TermRule } from '../../shared/model';
import { renumberAll } from './tree';
import { sanitizeAnnotations } from './annotations';
import { sanitizeTermRules } from './terminology';
import { uid } from './uid';

/** 深拷贝可序列化内容（快照与正文完全脱离引用关系） */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 以当前文档创建只读命名快照 */
export function createSnapshot(
  doc: ClauseDocument,
  confirmed: Record<string, string>,
  name: string,
  annotations: Annotation[] = [],
  termRules: TermRule[] = [],
  now = Date.now(),
): DocSnapshot {
  const snapshot: DocSnapshot = {
    id: uid('snp'),
    name,
    createdAt: now,
    doc: deepClone(doc),
    confirmed: deepClone(confirmed),
    annotations: deepClone(annotations),
    termRules: deepClone(termRules),
  };
  // 快照只读：冻结后任何误写都会立即暴露（开发期），且不影响正文
  return freezeSnapshot(snapshot);
}

export function freezeSnapshot(snapshot: DocSnapshot): DocSnapshot {
  if (typeof Object.freeze !== 'function') return snapshot;
  const walk = (nodes: readonly unknown[]) => {
    for (const n of nodes) {
      if (n && typeof n === 'object') Object.freeze(n);
      const children = (n as { children?: unknown[] })?.children;
      if (Array.isArray(children)) walk(children);
    }
  };
  Object.freeze(snapshot);
  Object.freeze(snapshot.confirmed);
  Object.freeze(snapshot.doc);
  walk(snapshot.doc.root);
  if (Array.isArray(snapshot.annotations)) {
    Object.freeze(snapshot.annotations);
    snapshot.annotations.forEach((an) => {
      Object.freeze(an);
      if (Array.isArray(an.candidates)) Object.freeze(an.candidates);
    });
  }
  if (Array.isArray(snapshot.termRules)) {
    Object.freeze(snapshot.termRules);
    snapshot.termRules.forEach((r) => {
      Object.freeze(r);
      Object.freeze(r.variants);
    });
  }
  return snapshot;
}

/**
 * 校验并规整外部数据中的快照列表（旧数据 / 导入文件缺少 snapshots 时返回空列表）。
 * 手工编辑过的 JSON 可能序号错乱，这里重新规范化 ordinal，保证对比结果可信。
 */
export function sanitizeSnapshots(value: unknown): DocSnapshot[] {
  if (!Array.isArray(value)) return [];
  const out: DocSnapshot[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Partial<DocSnapshot>;
    if (!s.doc || !Array.isArray(s.doc.root) || typeof s.doc.title !== 'string') continue;
    // 深拷贝后再规范化：导入往返（含本应用导出的只读冻结快照）不能因冻结 / 共享引用写坏
    const doc: ClauseDocument = {
      id: typeof s.doc.id === 'string' ? s.doc.id : uid('doc'),
      title: s.doc.title,
      root: deepClone(s.doc.root),
      updatedAt: typeof s.doc.updatedAt === 'number' ? s.doc.updatedAt : 0,
    };
    renumberAll(doc.root);
    const confirmed: Record<string, string> = {};
    if (s.confirmed && typeof s.confirmed === 'object') {
      for (const [k, v] of Object.entries(s.confirmed)) {
        if (typeof v === 'string') confirmed[k] = v;
      }
    }
    out.push(
      freezeSnapshot({
        id: typeof s.id === 'string' && s.id ? s.id : uid('snp'),
        name: typeof s.name === 'string' && s.name.trim() ? s.name : '未命名快照',
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
        doc,
        confirmed,
        annotations: sanitizeAnnotations(s.annotations),
        termRules: sanitizeTermRules(s.termRules),
      }),
    );
  }
  return out;
}
