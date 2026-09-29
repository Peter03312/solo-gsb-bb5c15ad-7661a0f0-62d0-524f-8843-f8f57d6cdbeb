// 导入文档的全树结构校验（页面 JSON 导入与服务端 /api/validate、/api/state 共用同一套规则）
//
// 背景：旧实现仅检查 document.root 是否为数组。两处条款共用同一节点 ID 时，
// 分析索引按 id 建表会覆盖前一节点，引用定位与审签可能关联到错误节点；
// 子节点缺少 children 时，renumberAll / analyzer 直接遍历会抛错。
// 因此导入前必须按「条 → 款 → 项」校验节点类型、必需字段与全树 ID 唯一性，
// 任一节点不合格都给出可定位的原因，由调用方拒绝整次导入（现有状态保持原状）。

import type { ClauseDocument, NodeKind, PersistedState } from './model';

export interface DocumentValidation {
  ok: boolean;
  /** 全部不合格原因（含所在结构路径，便于修正）；ok 时为空 */
  errors: string[];
  /** root 节点总数（仅在结构可统计时给出） */
  rootCount?: number;
}

const KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['article', 'paragraph', 'item']);

const KIND_LABEL: Record<NodeKind, string> = {
  article: '条',
  paragraph: '款',
  item: '项',
};

/** 各深度允许的节点类型：0=条，1=款，2=项（项不可再有子节点） */
const KIND_AT_DEPTH: NodeKind[] = ['article', 'paragraph', 'item'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 结构路径中的中文定位，如「第 1 条」「第 1 条第 2 款第 1 项」 */
function pathLabel(trail: { kind: NodeKind; ordinal: number }[]): string {
  if (trail.length === 0) return 'document.root';
  return trail.map((t) => `第 ${t.ordinal} ${KIND_LABEL[t.kind]}`).join('');
}

/**
 * 校验条款树：深度即层级（0 条 / 1 款 / 2 项），全树 ID 必须唯一。
 * 遍历时同时做防环保护（环结构必然伴随重复 ID，也不允许导入）。
 */
function validateTree(
  root: unknown,
  errors: string[],
  seenIds: Map<string, string>,
  visiting: WeakSet<object>,
  trail: { kind: NodeKind; ordinal: number }[],
): void {
  if (!Array.isArray(root)) {
    errors.push(`${pathLabel(trail)} 的 children 必须是数组（层级：条 → 款 → 项）`);
    return;
  }

  const depth = trail.length; // 即将校验的节点所在深度
  const expectedKind = KIND_AT_DEPTH[depth];

  root.forEach((rawNode, index) => {
    const here = [...trail, { kind: expectedKind ?? 'item', ordinal: index + 1 }];
    const label = pathLabel(here);

    if (!isObject(rawNode)) {
      errors.push(`${label}：节点必须是对象`);
      return; // 无法继续下钻
    }

    // —— 必需字段：id ——
    const id = rawNode.id;
    if (typeof id !== 'string' || id.trim() === '') {
      errors.push(`${label}：缺少必需字段 id（非空字符串），节点 ID 用于引用定位与审签关联`);
    } else {
      const first = seenIds.get(id);
      if (first !== undefined) {
        errors.push(`${label}：节点 id「${id}」与 ${first} 重复，全树节点 ID 必须唯一`);
      } else {
        seenIds.set(id, label);
      }
    }

    // —— 必需字段：kind，且必须符合 条 → 款 → 项 层级 ——
    const kind = rawNode.kind;
    let kindOk = false;
    if (typeof kind !== 'string' || !KINDS.has(kind as NodeKind)) {
      errors.push(
        `${label}：kind 必须是 article / paragraph / item 之一${
          kind === undefined ? '（字段缺失）' : `（实际为 ${JSON.stringify(kind)}）`
        }`,
      );
    } else if (depth >= KIND_AT_DEPTH.length || kind !== expectedKind) {
      errors.push(
        `${label}：层级不合法，该位置应为「${KIND_LABEL[expectedKind]}」节点（kind=${kind}），结构只允许 条 → 款 → 项`,
      );
    } else {
      kindOk = true;
    }

    // —— 必需字段：ordinal（数字；导入后统一按结构位置重编号）——
    if (typeof rawNode.ordinal !== 'number' || !Number.isFinite(rawNode.ordinal)) {
      errors.push(`${label}：缺少必需字段 ordinal（数字）`);
    }

    // —— 必需字段：text（字符串；允许空字符串，表示空条款）——
    if (typeof rawNode.text !== 'string') {
      errors.push(`${label}：缺少必需字段 text（字符串，可为空串）`);
    }

    // —— 可选字段：title / suffix 若出现必须是字符串 ——
    if (rawNode.title !== undefined && typeof rawNode.title !== 'string') {
      errors.push(`${label}：title 必须是字符串`);
    }
    if (rawNode.suffix !== undefined && typeof rawNode.suffix !== 'string') {
      errors.push(`${label}：suffix 必须是字符串`);
    }

    // —— 必需字段：children（数组）；项节点不可再嵌套 ——
    if (!Array.isArray(rawNode.children)) {
      errors.push(`${label}：缺少必需字段 children（数组，叶子节点为空数组）`);
      return;
    }
    if (kind === 'item' && rawNode.children.length > 0) {
      errors.push(`${label}：项节点不可再包含子节点（结构只允许 条 → 款 → 项 三层）`);
      return;
    }
    if (depth >= KIND_AT_DEPTH.length - 1) {
      // 已是最深层（项），不得继续下钻
      return;
    }

    // 防环：同一对象再次出现在自己的后代链上时停止（其重复 ID 已另行报错）
    if (visiting.has(rawNode)) {
      errors.push(`${label}：节点树存在循环引用，无法按树结构导入`);
      return;
    }
    visiting.add(rawNode);
    if (kindOk) {
      validateTree(rawNode.children, errors, seenIds, visiting, here);
    } else {
      // kind 不符层级时不继续按深度下钻，避免对同一坏结构刷屏
    }
    visiting.delete(rawNode);
  });
}

/**
 * 校验一份条款文档：document.root 必须是数组，且整棵树满足
 * 条 → 款 → 项层级、必需字段齐全、全树 ID 唯一。root 为空数组视为合法文档。
 */
export function validateClauseDocument(doc: unknown): DocumentValidation {
  const errors: string[] = [];
  if (!isObject(doc)) {
    return { ok: false, errors: ['document 必须是对象'] };
  }
  if (doc.title !== undefined && typeof doc.title !== 'string') {
    errors.push('document.title 必须是字符串');
  }
  if (!Array.isArray(doc.root)) {
    return { ok: false, errors: ['MISSING_ROOT'] };
  }
  const seenIds = new Map<string, string>();
  validateTree(doc.root, errors, seenIds, new WeakSet<object>(), []);
  return {
    ok: errors.length === 0,
    errors,
    rootCount: doc.root.length,
  };
}

/**
 * 校验导入包 / 持久化状态中的文档：
 * - ExportBundle 取 document；PersistedState 取 doc；
 * - 校验规则与页面导入、POST /api/validate 完全一致。
 */
export function validateImportBundle(
  bundle: unknown,
): { validation: DocumentValidation; doc?: ClauseDocument } {
  if (!isObject(bundle)) {
    return { validation: { ok: false, errors: ['导入内容必须是 JSON 对象'] } };
  }
  const hasDocument = 'document' in bundle;
  const hasDoc = 'doc' in bundle;
  if (!hasDocument && !hasDoc) {
    return { validation: { ok: false, errors: ['MISSING_ROOT'] } };
  }
  const rawDoc = hasDocument
    ? (bundle.document as unknown)
    : ((bundle as unknown as PersistedState).doc as unknown);
  const validation = validateClauseDocument(rawDoc);
  return validation.ok ? { validation, doc: rawDoc as ClauseDocument } : { validation };
}

/** 类型守卫：供 /api/state 等持久化入口复用同一套全树校验规则 */
export function isValidPersistedState(v: unknown): v is PersistedState {
  if (!isObject(v)) return false;
  if (typeof v.confirmed !== 'object' || v.confirmed === null || Array.isArray(v.confirmed)) {
    return false;
  }
  const doc = (v as unknown as PersistedState).doc;
  if (!isObject(doc) || typeof doc.title !== 'string') return false;
  return validateClauseDocument(doc).ok;
}
