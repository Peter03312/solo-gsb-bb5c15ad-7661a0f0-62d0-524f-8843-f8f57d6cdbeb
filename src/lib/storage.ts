import type { PersistedState } from '../../shared/model';
import { isValidPersistedState } from '../../shared/validation';

const LS_KEY = 'clause-reference-validator:v1';

/** localStorage 持久化（主）；服务器文件存储为可选镜像 */
export const localStore = {
  load(): PersistedState | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedState;
      // 与服务端 PUT /api/state、页面 JSON 导入同一套全树校验：结构不合法的缓存不加载
      if (!isValidPersistedState(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  },
  save(state: PersistedState): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      // 存储空间不足等情况下静默失败，界面仍可使用
    }
  },
  clear(): void {
    localStorage.removeItem(LS_KEY);
  },
};

/** 单次 PUT 结果：ok 成功；retry 可重试的瞬时失败；reject 不重试的永久失败（如 4xx） */
type PutOutcome = 'ok' | 'retry' | 'reject';

async function putState(state: PersistedState): Promise<PutOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
  } catch {
    // 网络错误 / 服务暂不可用：可重试
    return 'retry';
  }
  if (res.ok) return 'ok';
  // 4xx 是请求内容本身的问题，重试无益；5xx（含 500 保存失败）允许后续重试
  return res.status >= 500 ? 'retry' : 'reject';
}

async function loadState(): Promise<PersistedState | null> {
  const res = await fetch('/api/state');
  if (!res.ok) return null;
  const data = (await res.json()) as { state: PersistedState | null };
  return data.state;
}

/**
 * 服务端镜像保存队列（单连接、严格按提交顺序）：
 * - 任一时刻最多只有一个 PUT 在发送；新状态进入时若已有请求在途，则
 *   合并为“最新待写状态”，在途请求结束后只发送这份最新完整状态；
 * - 因此连续编辑只会串行提交，旧状态不可能越过新状态覆盖服务器文件；
 * - 发送失败（网络错误 / 5xx）按退避重试，重试期间产生的修改会顶替为
 *   最新待写状态并优先发送；重试有上限，放弃后下次编辑仍会重新触发；
 * - localStorage 始终同步即时写入，队列失败不影响本地保存与界面操作。
 */
class ServerSaveQueue {
  /** 在途或正在排队发送的最新完整状态；null 表示队列空闲 */
  private pending: PersistedState | null = null;
  /** 等待本次发送结果的回调（合并掉的中间状态与最新状态一并在此等待） */
  private waiters: Array<(ok: boolean) => void> = [];
  private running = false;
  /** 失败退避期间用于唤醒的定时器；有新状态进入时提前结束退避 */
  private wake: (() => void) | null = null;

  save(state: PersistedState): Promise<boolean> {
    // 合并发送期间产生的修改：后到的完整状态覆盖待写状态
    this.pending = state;
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
    return new Promise<boolean>((resolve) => {
      this.waiters.push(resolve);
      if (!this.running) void this.pump();
    });
  }

  private settle(ok: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve(ok));
  }

  private sleepOrWake(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async pump(): Promise<void> {
    this.running = true;
    try {
      while (this.pending) {
        const state = this.pending;
        const result = await this.sendWithRetry(state);
        if (this.pending === state) {
          // 发送期间没有更新的状态：本轮结束，报告结果
          this.pending = null;
          this.settle(result === 'ok');
        } else {
          // 发送期间（含重试退避）产生了更新的状态：
          // 本轮等待者不结算，随最新状态一并在外层循环继续发送；
          // 旧状态被合并丢弃，最终只保留最新一次成功提交的完整状态。
        }
      }
    } finally {
      this.running = false;
      // 竞态兜底：退出循环后、清 running 前若又有状态进入
      if (this.pending && !this.running) void this.pump();
    }
  }

  private async sendWithRetry(state: PersistedState): Promise<PutOutcome> {
    // 最多 4 次尝试：间隔 0.4s / 1.2s / 3s
    const delays = [0, 400, 1200, 3000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (attempt > 0) {
        // 退避期间若被更新的状态唤醒，则不再重试这份旧状态
        if (this.pending !== state) return 'retry';
        await this.sleepOrWake(delays[attempt]);
        if (this.pending !== state) return 'retry';
      }
      const outcome = await putState(state);
      if (outcome === 'ok' || outcome === 'reject') return outcome;
    }
    return 'retry';
  }
}

const saveQueue = new ServerSaveQueue();

/** 服务器侧文件存储镜像（失败时降级为仅本地浏览器存储） */
export const serverStore = {
  async load(): Promise<PersistedState | null> {
    try {
      return await loadState();
    } catch {
      return null;
    }
  },
  /**
   * 按提交顺序串行保存；调用方无需等待上一请求，发送期间产生的修改
   * 会合并为最新待写状态。返回本次入队状态是否已成功写入服务器
   * （被更新状态合并的中间保存随最新状态一并结算）。
   */
  async save(state: PersistedState): Promise<boolean> {
    return saveQueue.save(state);
  },
};
