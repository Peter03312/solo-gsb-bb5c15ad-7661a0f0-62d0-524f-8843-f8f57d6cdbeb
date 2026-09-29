import type {
  Analysis,
  ArticleEdge,
  ClauseDocument,
  ClauseNode,
  Issue,
  NodePlacement,
  NumStyle,
  RefOccurrence,
  RefResolution,
  RefSpan,
} from '../../shared/model';
import { scanReferences } from './scanner';
import { formatOrdinal } from './numeral';
import { renderArticleSet } from './articleset';

interface FlatNode {
  node: ClauseNode;
  placement: NodePlacement;
}

/** 扁平索引 + 位置表 */
function flatten(doc: ClauseDocument): {
  byId: Map<string, FlatNode>;
  articles: ClauseNode[];
} {
  const byId = new Map<string, FlatNode>();
  doc.root.forEach((article, ai) => {
    byId.set(article.id, {
      node: article,
      placement: { article, articleIndex: ai, paragraphIndex: 0, itemIndex: 0 },
    });
    article.children.forEach((paragraph, pi) => {
      byId.set(paragraph.id, {
        node: paragraph,
        placement: { article, articleIndex: ai, paragraph, paragraphIndex: pi + 1, itemIndex: 0 },
      });
      paragraph.children.forEach((item, ii) => {
        byId.set(item.id, {
          node: item,
          placement: {
            article,
            articleIndex: ai,
            paragraph,
            paragraphIndex: pi + 1,
            item,
            itemIndex: ii + 1,
          },
        });
      });
    });
  });
  return { byId, articles: doc.root };
}

/** 构造确认签名：同节点内、同原文、第 N 次出现（不依赖字符偏移） */
function signatureFor(nodeId: string, span: RefSpan, occurrenceIndex: number): string {
  return `${nodeId}::${span.raw}::${occurrenceIndex}`;
}

export interface AnalyzeOptions {
  /** 歧义引用确认：signature -> targetId */
  confirmed: Record<string, string>;
}

/** 完整分析文档：解析引用、计算问题与边 */
export function analyze(doc: ClauseDocument, opts: AnalyzeOptions = { confirmed: {} }): Analysis {
  const { byId, articles } = flatten(doc);
  const placement: Record<string, NodePlacement> = {};
  const nodes: Record<string, ClauseNode> = {};
  byId.forEach((v, id) => {
    placement[id] = v.placement;
    nodes[id] = v.node;
  });

  // 第一遍：扫描所有节点文本
  const raw: { nodeId: string; span: RefSpan; occurrenceIndex: number }[] = [];
  byId.forEach(({ node }, nodeId) => {
    if (!node.text) return;
    const spans = scanReferences(node.text);
    const seen = new Map<string, number>();
    for (const span of spans) {
      const k = `${span.raw}`;
      const idx = (seen.get(k) ?? 0) + 1;
      seen.set(k, idx);
      raw.push({ nodeId, span, occurrenceIndex: idx });
    }
  });

  const findArticle = (ordinal: number, suffix?: string): ClauseNode | undefined =>
    articles.find((a) => a.ordinal === ordinal && (a.suffix ?? '') === (suffix ?? ''));

  const resolve = (
    nodeId: string,
    span: RefSpan,
  ): { resolution: RefResolution; target?: ClauseNode } => {
    const here = byId.get(nodeId);
    if (!here) return { resolution: { status: 'broken', reason: '源节点不存在' } };
    const { placement: hp } = here;

    // 条级组合 / 闭区间：解析为按文档顺序排列的稳定条 ID 集合
    if (span.kind === 'articleList' || span.kind === 'articleRange') {
      return { resolution: resolveCombined(span, articles) };
    }

    let article: ClauseNode | undefined;
    let paragraphNum: number | undefined;
    let itemNum: number | undefined;
    let reason = '';

    switch (span.kind) {
      case 'absolute': {
        article = findArticle(span.articleNum!, span.articleSuffix);
        if (!article) {
          reason = span.articleSuffix
            ? `找不到“第${formatOrdinal(span.articleNum!, span.articleStyle)}条之${span.articleSuffix}”`
            : `找不到“第${formatOrdinal(span.articleNum!, span.articleStyle)}条”`;
          break;
        }
        paragraphNum = span.paragraphNum;
        itemNum = span.itemNum;
        break;
      }
      case 'this':
        article = hp.article;
        paragraphNum = span.paragraphNum;
        itemNum = span.itemNum;
        break;
      case 'prevArticle':
      case 'nextArticle': {
        const steps = span.articleNum ?? 1;
        const idx = hp.articleIndex + (span.kind === 'prevArticle' ? -steps : steps);
        article = articles[idx];
        if (!article) {
          reason = span.kind === 'prevArticle' ? '引用越过了第一条' : '引用越过了最后一条';
        }
        paragraphNum = span.paragraphNum;
        itemNum = span.itemNum;
        break;
      }
      case 'prevParagraph': {
        article = hp.article;
        if (hp.paragraphIndex <= 1) {
          reason = '本条内不存在前款';
          break;
        }
        paragraphNum = hp.paragraphIndex - 1;
        itemNum = span.itemNum;
        break;
      }
      case 'thisParagraph': {
        article = hp.article;
        if (!hp.paragraph) {
          reason = '“本款”出现在条头，当前没有款';
          break;
        }
        paragraphNum = hp.paragraphIndex;
        itemNum = span.itemNum;
        break;
      }
      case 'prevItem': {
        article = hp.article;
        if (!hp.paragraph || hp.itemIndex <= 1) {
          reason = '当前款内不存在前项';
          break;
        }
        paragraphNum = hp.paragraphIndex;
        itemNum = hp.itemIndex - 1;
        break;
      }
      case 'thisItem': {
        article = hp.article;
        if (!hp.item) {
          reason = '“本项”出现在非项节点中';
          break;
        }
        paragraphNum = hp.paragraphIndex;
        itemNum = hp.itemIndex;
        break;
      }
      case 'bareItem': {
        // （X） 默认指向当前款的第 X 项；在非项/非款语境时歧义
        article = hp.article;
        if (!hp.paragraph) {
          reason = '“（X）”形式出现在没有款结构的条头';
          break;
        }
        paragraphNum = hp.paragraphIndex;
        itemNum = span.itemNum;
        break;
      }
    }

    if (!article) return { resolution: { status: 'broken', reason } };

    let target: ClauseNode = article;

    if (paragraphNum !== undefined) {
      const paragraph = article.children[paragraphNum - 1];
      if (!paragraph) {
        return {
          resolution: {
            status: 'broken',
            reason: `第${articleLabel(article)}只有 ${article.children.length} 款，不存在第${formatOrdinal(
              paragraphNum,
              span.paragraphStyle,
            )}款`,
          },
        };
      }
      target = paragraph;
      if (itemNum !== undefined) {
        const item = paragraph.children[itemNum - 1];
        if (!item) {
          return {
            resolution: {
              status: 'broken',
              reason: `第${articleLabel(article)}第${formatOrdinal(
                paragraphNum,
                span.paragraphStyle,
              )}款只有 ${paragraph.children.length} 项，不存在第${formatOrdinal(
                itemNum,
                span.itemStyle,
              )}项`,
            },
          };
        }
        target = item;
      }
    } else if (itemNum !== undefined) {
      // 直接给项号但没给款号：跨款唯一项才算定位成功
      const matches: ClauseNode[] = [];
      for (const p of article.children) {
        if (p.children[itemNum - 1]) matches.push(p.children[itemNum - 1]);
      }
      if (matches.length === 1) {
        target = matches[0];
      } else if (matches.length === 0) {
        return {
          resolution: {
            status: 'broken',
            reason: `第${articleLabel(article)}不存在第${formatOrdinal(itemNum, span.itemStyle)}项`,
          },
        };
      } else {
        return {
          resolution: {
            status: 'ambiguous',
            candidates: matches.map((n) => n.id),
            reason: `第${formatOrdinal(itemNum, span.itemStyle)}项在 ${matches.length} 款中均存在`,
          },
        };
      }
    }

    // 后缀条引用，且文档中存在多个同序号候选时，标记歧义
    if (span.kind === 'absolute' && !span.articleSuffix) {
      const sameOrdinal = articles.filter((a) => a.ordinal === span.articleNum);
      if (sameOrdinal.length > 1) {
        return {
          resolution: {
            status: 'ambiguous',
            candidates: sameOrdinal.map((n) => n.id),
            reason: `存在 ${sameOrdinal.length} 个“第${formatOrdinal(
              span.articleNum!,
              span.articleStyle,
            )}条”（含“之一/之二”后缀条）`,
          },
        };
      }
    }

    return {
      resolution: {
        status: 'ok',
        targetId: target.id,
        canonical: canonicalText(span, target, placement[target.id]),
      },
      target,
    };
  };

  // 第二遍：解析 + 应用用户确认（确认后解析为 ok，但保留 ambiguity 供复核/撤销）
  const occurrences: RefOccurrence[] = [];
  for (const { nodeId, span, occurrenceIndex } of raw) {
    const signature = signatureFor(nodeId, span, occurrenceIndex);
    const { resolution } = resolve(nodeId, span);
    let finalResolution = resolution;
    if (resolution.status === 'ambiguous') {
      const confirmedId = opts.confirmed[signature];
      if (confirmedId && byId.has(confirmedId)) {
        const targetNode = byId.get(confirmedId)!.node;
        finalResolution = {
          status: 'ok',
          targetId: confirmedId,
          canonical: canonicalText(span, targetNode, placement[confirmedId]),
          ambiguity: {
            candidates: resolution.candidates ?? [],
            reason: resolution.reason,
          },
        };
      }
    }
    occurrences.push({
      key: `${nodeId}:${span.start}:${span.end}`,
      nodeId,
      span,
      resolution: finalResolution,
      occurrenceIndex,
      signature,
    });
  }

  const byNode: Record<string, RefOccurrence[]> = {};
  for (const occ of occurrences) {
    (byNode[occ.nodeId] ??= []).push(occ);
  }

  // 边（条级）：组合引用为每个已解析目标各建一条边（部分缺失时仍关联全部已解析目标）
  const edges: ArticleEdge[] = [];
  for (const occ of occurrences) {
    const targetIds =
      occ.resolution.targetIds ??
      (occ.resolution.status === 'ok' && occ.resolution.targetId
        ? [occ.resolution.targetId]
        : []);
    const src = placement[occ.nodeId];
    if (!src) continue;
    for (const tid of targetIds) {
      const dst = placement[tid];
      if (!dst) continue;
      edges.push({
        sourceArticleId: src.article.id,
        targetArticleId: dst.article.id,
        sourceNodeId: occ.nodeId,
        targetNodeId: tid,
        kind: occ.span.kind,
        status: occ.resolution.status,
        refKey: occ.key,
      });
    }
  }

  // 问题：断链 / 自引用 / 歧义
  const issues: Issue[] = [];
  for (const occ of occurrences) {
    const text = nodes[occ.nodeId]?.text ?? '';
    const sentence = locateSentence(text, occ.span.start, occ.span.end);
    const issueType = classifyOccurrence(occ, placement);
    if (!issueType) continue;
    const base = {
      key: `iss:${occ.key}`,
      // 稳定问题身份：类型 + 源节点稳定 ID + 引用原文 + 该节点内同文序次（不依赖字符偏移）
      identity: occIssueIdentity(occ, issueType),
      sourceNodeId: occ.nodeId,
      sentenceStart: sentence.start,
      sentenceEnd: sentence.end,
      refStart: occ.span.start,
      refEnd: occ.span.end,
      refKey: occ.key,
    };
    if (occ.resolution.status === 'broken') {
      const combined = occ.span.kind === 'articleList' || occ.span.kind === 'articleRange';
      issues.push({
        ...base,
        type: 'broken',
        targetNodeId: undefined,
        // 组合引用：问题面板列出已解析与缺失目标
        ...(combined && occ.resolution.targetIds?.length
          ? { resolvedTargetIds: occ.resolution.targetIds }
          : {}),
        ...(combined && occ.resolution.missingTargets?.length
          ? { missingTargets: occ.resolution.missingTargets }
          : {}),
        message: combined
          ? `组合引用：${occ.span.raw} —— ${occ.resolution.reason ?? '部分目标不存在'}`
          : `断链：${occ.span.raw} —— ${occ.resolution.reason ?? '目标不存在'}`,
      });
    } else if (occ.resolution.status === 'ambiguous') {
      issues.push({
        ...base,
        type: 'ambiguous',
        message: `歧义引用：${occ.span.raw} —— ${occ.resolution.reason ?? '存在多个候选目标'}`,
      });
    } else if (occ.resolution.ambiguity) {
      // 歧义已由用户确认：保留为“已确认”记录，可查看目标或撤销确认
      issues.push({
        ...base,
        type: 'ambiguous',
        targetNodeId: occ.resolution.targetId,
        confirmedTargetId: occ.resolution.targetId,
        message: `歧义引用（已确认）：${occ.span.raw} → ${occ.resolution.canonical ?? ''}`,
      });
    } else if (occ.resolution.targetId === occ.nodeId) {
      issues.push({
        ...base,
        type: 'self',
        targetNodeId: occ.resolution.targetId,
        message: `自引用：${occ.span.raw} 指向其所在节点自身`,
      });
    } else if (
      // 条内以绝对形式回指本条（如本条正文写“第五条”而第五条正是本条）：冗余自指
      occ.span.kind === 'absolute' &&
      placement[occ.resolution.targetId!]?.article.id ===
        placement[occ.nodeId]?.article.id
    ) {
      issues.push({
        ...base,
        type: 'self',
        targetNodeId: occ.resolution.targetId,
        message: `自引用：${occ.span.raw} 以绝对形式指向本条，建议改为“本条”相对引用`,
      });
    } else if (
      // 组合引用的目标集合包含本条（如本条正文写“第一条至第三条”而本条在区间内）
      (occ.span.kind === 'articleList' || occ.span.kind === 'articleRange') &&
      occ.resolution.targetIds?.some(
        (tid) => placement[tid]?.article.id === placement[occ.nodeId]?.article.id,
      )
    ) {
      const selfTarget = occ.resolution.targetIds!.find(
        (tid) => placement[tid]?.article.id === placement[occ.nodeId]?.article.id,
      )!;
      issues.push({
        ...base,
        type: 'self',
        targetNodeId: selfTarget,
        message: `自引用：${occ.span.raw} 的目标集合包含本条`,
      });
    }
  }

  // 循环引用：条级图上的有向环 + 节点级细环
  const cycles = detectCycles(edges);
  for (const cyc of cycles) {
    const firstOcc = occurrences.find((o) => o.key === cyc.edgeKeys[0]);
    if (firstOcc) {
      const text = nodes[firstOcc.nodeId]?.text ?? '';
      const sentence = locateSentence(text, firstOcc.span.start, firstOcc.span.end);
      issues.push({
        key: `cyc:${cyc.edgeKeys.join('>')}`,
        // 循环问题身份：类型 + 排序后的稳定节点 ID 集合（环的方向 / 起点变化不产生新问题）
        identity: `cycle::${cyc.signature}`,
        type: 'cycle',
        sourceNodeId: firstOcc.nodeId,
        sentenceStart: sentence.start,
        sentenceEnd: sentence.end,
        refStart: firstOcc.span.start,
        refEnd: firstOcc.span.end,
        refKey: firstOcc.key,
        targetNodeId: placement[firstOcc.resolution.targetId!]?.article.id,
        cycleNodeIds: cyc.articleIds,
        message: `循环引用：${cyc.articleIds
          .map((id) => '第' + articleLabel(placement[id].article))
          .join(' → ')} → 回到 ${'第' + articleLabel(placement[cyc.articleIds[0]].article)}`,
      });
    }
  }

  return { nodes, articles, placement, occurrences, byNode, issues, edges };
}

function articleLabel(a: ClauseNode): string {
  return formatOrdinal(a.ordinal) + '条' + (a.suffix ? `之${a.suffix}` : '');
}

/**
 * 非循环问题的稳定身份：
 * 类型 + 源节点稳定 ID + 引用原文 + 同文序次（同一节点内同原文第几次出现）。
 * 不含字符偏移：引用前的文字增删只改变偏移，不制造新问题；
 * 类型参与身份：同一引用从断链变为歧义（或经用户确认后消失）视为不同问题。
 */
export function occIssueIdentity(
  occ: Pick<RefOccurrence, 'nodeId' | 'span' | 'occurrenceIndex'>,
  type: Issue['type'],
): string {
  return `${type}::${occ.nodeId}::${occ.span.raw}::${occ.occurrenceIndex}`;
}

/** 判定一次引用出现是否构成问题及其类型（与 analyze 的问题生成分支保持同一套规则） */
function classifyOccurrence(
  occ: RefOccurrence,
  placement: Record<string, NodePlacement>,
): Issue['type'] | null {
  const r = occ.resolution;
  if (r.status === 'broken') return 'broken';
  if (r.status === 'ambiguous' || r.ambiguity) return 'ambiguous';
  if (r.targetId === occ.nodeId) return 'self';
  if (
    occ.span.kind === 'absolute' &&
    placement[r.targetId!]?.article.id === placement[occ.nodeId]?.article.id
  ) {
    return 'self';
  }
  if (
    (occ.span.kind === 'articleList' || occ.span.kind === 'articleRange') &&
    r.targetIds?.some(
      (tid) => placement[tid]?.article.id === placement[occ.nodeId]?.article.id,
    )
  ) {
    return 'self';
  }
  return null;
}

/**
 * 循环问题的稳定身份：类型 + 排序后的稳定节点 ID 集合。
 * detectCycles 已对每个节点集合只报一次，这里直接采用其排序签名。
 */
export function cycleIssueIdentity(sortedNodeIds: readonly string[]): string {
  return `cycle::${[...sortedNodeIds].sort().join('|')}`;
}

/**
 * 解析条级组合 / 闭区间引用：
 * 每个成员（或区间端点）按绝对引用同款规则定位（同序号后缀条视为歧义），
 * 区间在两端点均唯一时按序号闭区间展开；结果按文档顺序排列。
 * 任一成员缺失或有歧义时整体标记 broken，同时保留已解析与缺失目标。
 */
function resolveCombined(span: RefSpan, articles: ClauseNode[]): RefResolution {
  const missing: { raw: string; reason: string }[] = [];
  const found = new Map<string, ClauseNode>();

  const locate = (num: number, suffix: string | undefined, style: NumStyle | undefined): void => {
    const label = `第${formatOrdinal(num, style)}条${suffix ? `之${suffix}` : ''}`;
    const exact = articles.find((a) => a.ordinal === num && (a.suffix ?? '') === (suffix ?? ''));
    if (!exact) {
      missing.push({ raw: label, reason: '目标条不存在' });
      return;
    }
    if (!suffix) {
      const sameOrdinal = articles.filter((a) => a.ordinal === num);
      if (sameOrdinal.length > 1) {
        missing.push({
          raw: label,
          reason: `存在 ${sameOrdinal.length} 个“${label}”（含“之一/之二”后缀条），无法唯一确定`,
        });
        return;
      }
    }
    found.set(exact.id, exact);
  };

  if (span.kind === 'articleList') {
    for (const m of span.members ?? []) locate(m.num, m.suffix, m.style);
  } else {
    const startNum = span.articleNum!;
    const endNum = span.rangeEndNum!;
    locate(startNum, span.articleSuffix, span.articleStyle);
    locate(endNum, span.rangeEndSuffix, span.rangeEndStyle);
    if (missing.length === 0) {
      if (startNum > endNum) {
        missing.push({ raw: span.raw, reason: '区间起点大于终点，无法确定区间' });
      } else {
        for (const a of articles) {
          if (a.ordinal >= startNum && a.ordinal <= endNum) found.set(a.id, a);
        }
      }
    }
  }

  const targets = articles.filter((a) => found.has(a.id));
  const targetIds = targets.map((t) => t.id);
  const ok = missing.length === 0 && targetIds.length > 0;
  return {
    status: ok ? 'ok' : 'broken',
    ...(targetIds.length > 0 ? { targetId: targetIds[0], targetIds } : {}),
    ...(missing.length > 0 ? { missingTargets: missing } : {}),
    ...(ok
      ? {
          canonical: renderArticleSet(
            targets.map((t) => ({
              id: t.id,
              ordinal: t.ordinal,
              suffix: t.suffix ?? '',
              style: 'chinese' as NumStyle,
            })),
            articles.map((a) => ({ id: a.id, ordinal: a.ordinal })),
          ),
        }
      : {}),
    ...(!ok
      ? {
          reason:
            missing.length > 0
              ? `部分目标无法定位：${missing.map((m) => m.raw).join('、')}`
              : '没有可定位的目标',
        }
      : {}),
  };
}

/** 生成规范引用文本：绝对形式、中文数字 */
function canonicalText(_span: RefSpan, target: ClauseNode, p: NodePlacement): string {
  let s = `第${formatOrdinal(p.article.ordinal)}条`;
  if (p.article.suffix) s += `之${p.article.suffix}`;
  if (target.kind === 'paragraph' || target.kind === 'item') {
    s += `第${formatOrdinal(p.paragraphIndex)}款`;
  }
  if (target.kind === 'item') {
    s += `第${formatOrdinal(p.itemIndex)}项`;
  }
  return s;
}

export function locateSentence(text: string, start: number, end: number): { start: number; end: number } {
  const boundaries = new Set(['。', '！', '？', '；', ';', '…', '\n']);
  let s = start;
  while (s > 0 && !boundaries.has(text[s - 1])) s -= 1;
  let e = end;
  while (e < text.length && !boundaries.has(text[e - 1])) e += 1;
  if (e < text.length) e += 1; // 包含句末标点
  return { start: s, end: e };
}

interface Cycle {
  articleIds: string[];
  edgeKeys: string[];
  /** 排序后的环上稳定节点 ID 集合签名（每个节点集合只报一次） */
  signature: string;
}

/** 深度优先枚举有向环（条级图通常很小），每个节点集合只报一次 */
function detectCycles(edges: ArticleEdge[]): Cycle[] {
  const adj = new Map<string, { to: string; key: string }[]>();
  const vertices = new Set<string>();
  for (const e of edges) {
    vertices.add(e.sourceArticleId);
    vertices.add(e.targetArticleId);
    if (e.sourceArticleId === e.targetArticleId) continue; // 自引用单独报告
    const list = adj.get(e.sourceArticleId) ?? [];
    list.push({ to: e.targetArticleId, key: e.refKey });
    adj.set(e.sourceArticleId, list);
  }

  const cycles: Cycle[] = [];
  const seenSignatures = new Set<string>();
  const nodeStack: string[] = [];
  const edgeStack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();

  const visit = (v: string) => {
    visited.add(v);
    nodeStack.push(v);
    onStack.add(v);
    for (const { to, key } of adj.get(v) ?? []) {
      if (!visited.has(to)) {
        edgeStack.push(key);
        visit(to);
        edgeStack.pop();
      } else if (onStack.has(to)) {
        const idx = nodeStack.indexOf(to);
        if (idx >= 0) {
          const ringNodes = nodeStack.slice(idx);
          const ringEdges = [...edgeStack.slice(idx), key];
          const sig = [...ringNodes].sort().join('|');
          if (!seenSignatures.has(sig)) {
            seenSignatures.add(sig);
            cycles.push({ articleIds: ringNodes, edgeKeys: ringEdges, signature: sig });
          }
        }
      }
    }
    nodeStack.pop();
    onStack.delete(v);
  };

  for (const id of vertices) {
    if (!visited.has(id)) visit(id);
  }
  return cycles;
}

export { canonicalText };
