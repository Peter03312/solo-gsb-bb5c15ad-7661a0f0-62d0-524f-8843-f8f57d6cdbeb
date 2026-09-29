import type { ClauseDocument, ClauseNode, TermRule } from '../../shared/model';

let seq = 0;
function id(p: string): string {
  seq += 1;
  return `${p}${seq}`;
}

function art(ordinal: number, title: string | undefined, children: ClauseNode[]): ClauseNode {
  return { id: id('art'), kind: 'article', ordinal, ...(title ? { title } : {}), text: '', children };
}
function par(text: string, children: ClauseNode[] = []): ClauseNode {
  return { id: id('par'), kind: 'paragraph', ordinal: 0, text, children };
}
function itm(text: string): ClauseNode {
  return { id: id('itm'), kind: 'item', ordinal: 0, text, children: [] };
}

/**
 * 内置示例配套的规范用语规则（id 固定，便于重复载入时去重）。
 * 示例正文中故意保留了若干禁用变体，方便在「规范用语审校」侧栏看到命中与批量替换。
 */
export function sampleTermRules(): TermRule[] {
  return [
    { id: 'trm-sample-1', canonical: '依照', variants: ['按照'], createdAt: 0 },
    { id: 'trm-sample-2', canonical: '应当', variants: ['应该'], createdAt: 0 },
  ];
}

/** 内置示例：包含断链、自引用、循环引用、歧义等典型情形 */
export function sampleDocument(): ClauseDocument {
  const root = [
    art(1, '立法目的', [
      par(
        '为了规范条款引用活动，根据宪法，制定本法。本法所称条款引用，适用第三条至第八条的规定。',
      ),
    ]),
    art(2, '适用范围', [
      par('本法适用于规范性文件的起草、审查与公布活动。'),
      par('法律、行政法规另有规定的，从其规定；具体程序依照前款规定执行。', [
        itm('起草阶段应当按照本款第（一）项的要求标注全部交叉引用。'),
        itm('审查阶段发现引用错误的，应当按照第十条规定的程序处理。'),
      ]),
    ]),
    art(3, '引用格式', [
      par('条款引用应当使用“第X条”“第X条第X款”“第X条第X款第X项”的规范格式。'),
      par('引用本条其他款的，可以简写为“本条第X款”；引用前一款的，可以简写为“前款”。', [
        itm('引用同一款内前一项的，可以简写为“前项”，如（一）所述情形。'),
        itm('引用本项自身的，应当避免出现本项这类自指表述。'),
      ]),
    ]),
    art(4, '绝对引用', [
      par('条、款、项层级齐全的，应当使用绝对引用，例如第五条第二款第（一）项。'),
      par('编号发生调整的，应当同步更新第五条、第六条中的相关引用。'),
    ]),
    art(5, '相对引用', [
      par('相对引用包括前条、后条、前款、前项等形式，起草者应该统一使用上述写法。'),
      par('引用后条内容的，应当确认后条已经就同一事项作出规定，参见第七条。'),
      par('本款仅适用于前条所列情形；第（二）项未尽事宜，按照后条第二款处理。', [
        itm('相对引用不得指向不存在的层级，例如第十二条第三款。'),
        itm('前项已经明确的事项，本项不再重复；本项另有规定的除外。'),
      ]),
    ]),
    art(6, '条号调整', [
      par('条的顺序调整后，所有可唯一定位的绝对引用应原子更新；本条与第七条互相援引构成循环。'),
    ]),
    art(7, '循环示例', [
      par('本条规定事项的处理，适用第六条；第六条未规定的，回到本条处理。'),
    ]),
    art(8, '歧义示例', [
      par('修订后出现“第八条之一”时，单独书写“第八条”将产生歧义，应要求人工确认。'),
    ]),
    art(8, undefined, [par('本条为新增的修订条款，与原第八条序号相同，需以“之”后缀区分。')]),
  ];

  // 修正后缀条标记
  root[root.length - 1].suffix = '一';

  root.forEach((article) =>
    article.children.forEach((p, pi) => {
      p.ordinal = pi + 1;
      p.children.forEach((c, ci) => (c.ordinal = ci + 1));
    }),
  );

  return {
    id: 'sample-doc',
    title: '条款引用校验示例法',
    root,
    updatedAt: Date.now(),
  };
}
