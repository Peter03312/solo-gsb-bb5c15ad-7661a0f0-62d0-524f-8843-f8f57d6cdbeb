import type {
  ArticleSignoff,
  ArticleSignoffHistory,
  ClauseDocument,
  ClauseNode,
  SignoffStatus,
} from '../../shared/model';
import { uid } from './uid';

// ---------- 条文内容指纹 ----------

/** 款 / 项规范化为稳定的结构投影（顺序即结构位置） */
function canonicalItem(item: ClauseNode): unknown {
  return { t: item.text ?? '', c: item.children.map(canonicalItem) };
}

function canonicalParagraph(paragraph: ClauseNode): unknown {
  return { t: paragraph.text ?? '', c: paragraph.children.map(canonicalItem) };
}

/**
 * 条的完整条文规范化投影：条号（ordinal + suffix）、标题、条头正文与全部款、项。
 * 键名缩写仅用于压缩指纹输入，顺序固定；任一内容（含结构调整、引用自动改写）
 * 变化都会改变序列化结果，从而改变指纹。
 */
export function canonicalArticle(article: ClauseNode): unknown {
  return {
    n: article.ordinal,
    s: article.suffix ?? '',
    h: article.title ?? '',
    t: article.text ?? '',
    p: article.children.map(canonicalParagraph),
  };
}

/**
 * 64 位 FNV-1a（BigInt 实现，UTF-8 编码）。
 * 指纹只做变化检测、不做密码学用途；输出 16 位十六进制。
 */
export function fnv1a64(input: string): string {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = OFFSET;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** 计算条当前完整条文（条号、标题、正文、款、项）的内容指纹 */
export function articleFingerprint(article: ClauseNode): string {
  return fnv1a64(JSON.stringify(canonicalArticle(article)));
}

// ---------- 审签记录 ----------

/** 对指定条创建审签（同一条再次签署时归档旧签署信息），返回新记录 */
export function signArticle(
  existing: ArticleSignoff | undefined,
  articleId: string,
  signer: string,
  fingerprint: string,
  now = Date.now(),
): ArticleSignoff {
  const history: ArticleSignoffHistory[] = existing
    ? [
        ...(existing.history ?? []),
        { signer: existing.signer, signedAt: existing.signedAt, fingerprint: existing.fingerprint },
      ]
    : [];
  return {
    id: uid('sgn'),
    articleId,
    signer,
    signedAt: now,
    fingerprint,
    ...(history.length ? { history } : {}),
  };
}

/**
 * 校验并规整外部数据中的审签记录（旧数据 / 导入文件缺少 signoffs 时返回空列表）。
 * 有效性不在规整时判定——一律按加载后的当前条文实时重算。
 */
export function sanitizeSignoffs(value: unknown): ArticleSignoff[] {
  if (!Array.isArray(value)) return [];
  const out: ArticleSignoff[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Partial<ArticleSignoff>;
    if (typeof s.articleId !== 'string' || !s.articleId) continue;
    const signer = typeof s.signer === 'string' ? s.signer.trim() : '';
    if (!signer) continue;
    const fingerprint = typeof s.fingerprint === 'string' ? s.fingerprint : '';
    if (!fingerprint) continue;
    const signedAt = typeof s.signedAt === 'number' && Number.isFinite(s.signedAt) ? s.signedAt : 0;
    const history = Array.isArray(s.history)
      ? s.history
          .filter(
            (h): h is ArticleSignoffHistory =>
              Boolean(
                h &&
                  typeof h === 'object' &&
                  typeof h.signer === 'string' &&
                  typeof h.fingerprint === 'string' &&
                  typeof h.signedAt === 'number',
              ),
          )
          .map((h) => ({ signer: h.signer, signedAt: h.signedAt, fingerprint: h.fingerprint }))
      : undefined;
    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : uid('sgn'),
      articleId: s.articleId,
      signer,
      signedAt,
      fingerprint,
      ...(history && history.length ? { history } : {}),
    });
  }
  return out;
}

// ---------- 当前状态汇总（实时重算，不入库） ----------

export interface SignoffEntry {
  /** 当前文档中的条；已删除时为 null */
  article: ClauseNode | null;
  articleId: string;
  /** 该条最新审签记录；未签时为 null */
  signoff: ArticleSignoff | null;
  /** 当前条文指纹（条已删除时为 null） */
  fingerprint: string | null;
  status: SignoffStatus;
}

export interface SignoffView {
  entries: SignoffEntry[];
  /** 当前条统计（不含已删除记录） */
  counts: { total: number; unsigned: number; valid: number; stale: number };
  /** 条已删除但审签记录保留的条目 */
  deleted: SignoffEntry[];
}

/**
 * 按当前文档对审签记录实时汇总：
 * - 无记录的当前条为「未签」；
 * - 记录指纹与当前条文指纹一致为「有效」；
 * - 不一致（正文编辑、结构调整、自动引用改写等）为「待重签」；
 * - 条已删除的记录单列、不计入当前统计（撤销删除恢复条文后自动回到有效 / 待重签）。
 */
export function buildSignoffView(doc: ClauseDocument, signoffs: ArticleSignoff[]): SignoffView {
  const byArticle = new Map<string, ArticleSignoff>();
  for (const s of signoffs) {
    const prev = byArticle.get(s.articleId);
    if (!prev || s.signedAt > prev.signedAt) byArticle.set(s.articleId, s);
  }

  const entries: SignoffEntry[] = [];
  const counts = { total: doc.root.length, unsigned: 0, valid: 0, stale: 0 };
  for (const article of doc.root) {
    const signoff = byArticle.get(article.id) ?? null;
    const fingerprint = articleFingerprint(article);
    let status: SignoffStatus;
    if (!signoff) {
      status = 'unsigned';
      counts.unsigned += 1;
    } else if (signoff.fingerprint === fingerprint) {
      status = 'valid';
      counts.valid += 1;
    } else {
      status = 'stale';
      counts.stale += 1;
    }
    entries.push({ article, articleId: article.id, signoff, fingerprint, status });
  }

  const deleted: SignoffEntry[] = [];
  for (const [articleId, signoff] of byArticle) {
    if (doc.root.some((a) => a.id === articleId)) continue;
    deleted.push({ article: null, articleId, signoff, fingerprint: null, status: 'deleted' });
  }
  deleted.sort((a, b) => (b.signoff?.signedAt ?? 0) - (a.signoff?.signedAt ?? 0));

  return { entries, counts, deleted };
}
