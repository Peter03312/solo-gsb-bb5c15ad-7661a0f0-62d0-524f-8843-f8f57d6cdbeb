// 浏览器端保存队列自检（mock fetch，不依赖浏览器）：
// 1) 同一时刻最多一个 PUT 在途；
// 2) 在途期间的连续修改合并为最新待写状态，按提交顺序串行，最终发送的是最新完整状态；
// 3) 发送失败后自动重试，重试期间的新修改提前顶替旧状态；
// 4) 5xx/网络错误重试，4xx 不重试，放弃后下一次编辑仍可继续。
import { serverStore } from '../src/lib/storage';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function state(title: string): { doc: { id: string; title: string; root: unknown[] }; confirmed: {} } {
  return { doc: { id: 'd', title, root: [] }, confirmed: {} };
}

interface Call {
  title: string;
  release: () => void;
}

/** 可控的 mock fetch：请求进入时挂起，直到 test 手动 release */
function installControlledFetch(): { calls: Call[]; inFlight: () => number } {
  const calls: Call[] = [];
  let current = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { doc: { title: string } };
    const slot: Call = { title: body.doc.title, release: () => undefined };
    const gate = new Promise<void>((resolve) => {
      slot.release = resolve;
    });
    current++;
    calls.push(slot);
    await gate;
    current--;
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, inFlight: () => current };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. 串行 + 合并：在途期间的多次保存只产生一次后续发送，且内容为最新 ----
{
  const { calls, inFlight } = installControlledFetch();
  const p1 = serverStore.save(state('A'));
  await tick(5);
  check('第一个保存立即发出', calls.length === 1 && calls[0].title === 'A');
  check('首个请求在途时 inFlight=1', inFlight() === 1);

  const p2 = serverStore.save(state('B'));
  const p3 = serverStore.save(state('C'));
  await tick(5);
  check('在途期间后续保存不并发新请求', calls.length === 1 && inFlight() === 1);

  calls[0].release();
  await tick(5);
  check('在途结束后只发一次合并请求', calls.length === 2);
  check('合并发送的是最新状态 C（不发送中间态 B）', calls[1].title === 'C');
  check('第二次请求独立在途', inFlight() === 1);
  calls[1].release();
  // 被合并的保存随最新状态一并结算：C 成功时 A/B/C 都已完整落在服务器
  const results = await Promise.all([p1, p2, p3]);
  check('三个保存均按最新一次成功提交结算', results.every((r) => r === true));
  await tick(5);
  check('队列清空后无在途请求', inFlight() === 0 && calls.length === 2);
}

// ---- 2. 提交顺序：A 在途时 B 入队，先发 A 再发 B，不越序 ----
{
  const { calls } = installControlledFetch();
  void serverStore.save(state('A'));
  await tick(5);
  void serverStore.save(state('B'));
  await tick(5);
  check('顺序：仍只有 A 在途', calls.length === 1 && calls[0].title === 'A');
  calls[0].release();
  await tick(5);
  check('顺序：A 完成后发送 B', calls.length === 2 && calls[1].title === 'B');
  calls[1].release();
  await tick(5);
}

// ---- 3. 瞬时失败（5xx）自动重试并最终成功 ----
{
  let attempts = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    attempts++;
    if (attempts < 3) return new Response('{"error":"busy"}', { status: 500 });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  const t0 = Date.now();
  const ok = await serverStore.save(state('R'));
  check('5xx 后自动重试到成功', ok === true && attempts === 3, `attempts=${attempts}`);
  check('重试存在退避延迟（非忙循环）', Date.now() - t0 >= 350);
}

// ---- 4. 网络错误重试；重试期间新状态顶替，旧状态不再发送 ----
{
  let networkCalls = 0;
  let sentTitles: string[] = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
    networkCalls++;
    const body = JSON.parse(String(init?.body)) as { doc: { title: string } };
    sentTitles.push(body.doc.title);
    // 旧状态 X 一直网络失败；新状态 Y 首次即成功
    if (body.doc.title === 'X') throw new Error('network down');
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;

  const px = serverStore.save(state('X'));
  // 让 X 经历前两次失败（0ms、400ms 退避），在第二次退避中插入 Y
  await tick(450);
  check('X 已被尝试至少两次', networkCalls >= 2 && sentTitles.every((t) => t === 'X'));
  const py = serverStore.save(state('Y'));
  const [rx, ry] = await Promise.all([px, py]);
  check('Y 成功写入', ry === true);
  check('X 随最新状态一并结算（不因被合并而永远 pending）', rx === true);
  check('最新一次成功提交的是 Y，且最终没有再发送 X', sentTitles.at(-1) === 'Y');
}

// ---- 5. 4xx 不重试；失败放弃后，下一次编辑仍可继续保存 ----
{
  const seq: number[] = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    seq.push(400);
    return new Response('{"error":"bad"}', { status: 400 });
  }) as typeof fetch;
  const bad = await serverStore.save(state('Bad'));
  check('4xx 立即失败、不重试', bad === false && seq.length === 1);

  (globalThis as { fetch: typeof fetch }).fetch = (async () =>
    new Response('{"ok":true}', { status: 200 })) as typeof fetch;
  const good = await serverStore.save(state('Good'));
  check('放弃后后续保存仍可成功', good === true);
}

// ---- 6. 超过重试上限后放弃，下一次编辑重新尝试并成功 ----
{
  let n = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    n++;
    throw new Error('network down');
  }) as typeof fetch;
  const gone = await serverStore.save(state('Gone'));
  check('持续网络失败到达上限后放弃', gone === false && n === 4);

  (globalThis as { fetch: typeof fetch }).fetch = (async () =>
    new Response('{"ok":true}', { status: 200 })) as typeof fetch;
  const back = await serverStore.save(state('Back'));
  check('放弃后新编辑重新入队并成功', back === true);
}

console.log(`\n客户端保存队列自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
