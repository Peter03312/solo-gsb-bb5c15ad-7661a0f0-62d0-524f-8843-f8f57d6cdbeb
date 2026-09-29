// 服务端并发保存集成自检：
// 1) 并发 PUT 按提交顺序串行落盘，最终文件为最后一次提交的完整状态；
// 2) 原子替换：GET 永远读不到半写文件，写入不残留临时文件；
// 3) 写入失败（数据目录只读）时原文件完整保留，恢复可写后后续保存继续可用；
// 4) GET/PUT 响应约定与 400 校验保持不变。
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

function stateWith(title: string, n: number): string {
  return JSON.stringify({ doc: { id: 'd1', title, root: [], updatedAt: n }, confirmed: {} });
}

/** 在单条 TCP 连接上流水线发送若干请求，收集全部响应头（按收齐响应体判定） */
function sendRaw(port: number, raw: string, expectedResponses: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const done = (): void => {
      sock.end();
      resolve(buf.toString());
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      // 解析已完整接收的响应数（响应均为固定 Content-Length 的小 JSON）
      let rest = buf;
      let complete = 0;
      for (;;) {
        const sep = rest.indexOf('\r\n\r\n');
        if (sep < 0) break;
        const head = rest.subarray(0, sep).toString();
        const m = head.match(/content-length:\s*(\d+)/i);
        if (!m) break;
        const len = Number(m[1]);
        if (rest.length < sep + 4 + len) break;
        complete++;
        rest = rest.subarray(sep + 4 + len);
      }
      if (complete >= expectedResponses) done();
    });
    sock.on('error', reject);
    sock.write(raw);
  });
}

function stopServer(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
  });
}

async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'crv-srv-'));
const DATA_DIR = path.join(tmpRoot, 'data');
const PORT = 3917;
const serverFile = path.join(DATA_DIR, 'state.json');

function startServer(): ChildProcessWithoutNullStreams {
  const proc = spawn(process.execPath, ['dist-server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => undefined);
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return proc;
}

let server: ChildProcessWithoutNullStreams;
function restartServer(): Promise<ChildProcessWithoutNullStreams> {
  return stopServer(server).then(() => {
    server = startServer();
    return waitForHealth(PORT).then(() => server);
  });
}

server = startServer();

try {
  await waitForHealth(PORT);

  // 初始无文件：GET 返回 state: null
  {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/state`);
    const data = await res.json();
    check('GET 空数据返回 { state: null }', res.ok && data.state === null);
  }

  // 单连接流水线并发提交 5 个 PUT，服务端必须按顺序串行落盘
  {
    const N = 5;
    let raw = '';
    for (let i = 1; i <= N; i++) {
      const body = stateWith(`版本 ${i}`, i);
      raw +=
        `PUT /api/state HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`;
    }
    const resp = await sendRaw(PORT, raw, N);
    const okCount = (resp.match(/HTTP\/1\.1 200 OK/g) ?? []).length;
    check('5 个并发 PUT 全部成功', okCount === 5, `got ${okCount}`);

    await new Promise((r) => setTimeout(r, 300));
    const saved = JSON.parse(await fsp.readFile(serverFile, 'utf8'));
    check('并发保存后文件为最后一次提交的完整状态', saved.doc.title === '版本 5' && saved.doc.updatedAt === 5);

    const leftovers = (await fsp.readdir(DATA_DIR)).filter(
      (n) => n.endsWith('.tmp') || n === 'state.json.tmp',
    );
    check('写入后无临时文件残留', leftovers.length === 0, leftovers.join(','));
  }

  // 快速连续 30 次 PUT（每条独立连接），最终文件仍是最后一次提交
  {
    const N = 30;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        fetch(`http://127.0.0.1:${PORT}/api/state`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: stateWith(`并发版 ${i + 1}`, i + 1),
        }).then((r) => r.ok),
      ),
    );
    check('30 个并发 PUT 全部成功', results.every(Boolean));
    const saved = JSON.parse(await fsp.readFile(serverFile, 'utf8'));
    check('高并发后文件为最后一次提交', saved.doc.title === `并发版 ${N}` && saved.doc.updatedAt === N);
  }

  // 非法 body 返回 400，约定不变
  {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 1 }),
    });
    const data = await res.json();
    check('非法 body 返回 400', res.status === 400 && typeof data.error === 'string');
  }

  // 健康检查
  {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    const data = await res.json();
    check('GET /api/health 返回服务名', data.ok === true && data.service === 'clause-reference-validator');
  }

  // 写入失败时保留原有完整文件，恢复后后续保存仍可继续
  {
    const good = stateWith('受保护版本', 99);
    const goodRes = await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: good,
    });
    check('准备受保护版本成功', goodRes.ok);

    // 数据目录只读：rename 到该目录失败（root 例外，故跳过本断言条件）
    const isRoot = process.getuid?.() === 0;
    if (!isRoot) {
      await restartServer();
      await fsp.chmod(DATA_DIR, 0o555);

      const failRes = await fetch(`http://127.0.0.1:${PORT}/api/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: stateWith('不应写入的版本', 100),
      });
      check('目录只写失败时返回 500', failRes.status === 500);

      const kept = JSON.parse(await fsp.readFile(serverFile, 'utf8'));
      check('写入失败后原文件完整保留', kept.doc.title === '受保护版本' && kept.doc.updatedAt === 99);

      const leftovers = (await fsp.readdir(DATA_DIR)).filter((n) => n.endsWith('.tmp'));
      check('失败写入不残留临时文件', leftovers.length === 0, leftovers.join(','));

      await fsp.chmod(DATA_DIR, 0o755);
    }

    await restartServer();

    const resumeRes = await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: stateWith('恢复后版本', 101),
    });
    check('恢复可写后后续保存成功', resumeRes.ok);
    const after = JSON.parse(await fsp.readFile(serverFile, 'utf8'));
    check('恢复后文件为新提交状态', after.doc.title === '恢复后版本' && after.doc.updatedAt === 101);
  }

  // 启动时清理历史残留临时文件
  {
    await stopServer(server);
    await fsp.writeFile(path.join(DATA_DIR, '.state.999.deadbeef.tmp'), 'junk');
    server = startServer();
    await waitForHealth(PORT);
    const entries = await fsp.readdir(DATA_DIR);
    check('启动清理残留 .state.*.tmp', !entries.some((n) => n.startsWith('.state.') && n.endsWith('.tmp')));
    check('清理不影响 state.json', entries.includes('state.json'));
  }
} finally {
  await stopServer(server).catch(() => undefined);
  await fsp.chmod(DATA_DIR, 0o755).catch(() => undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n服务端自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
