import type { NumStyle } from '../../shared/model';

const DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 解析中文 / 阿拉伯（含全角）序数，返回数值与书写风格；非法或为 0 时返回 null */
export function parseOrdinal(input: string): { value: number; style: NumStyle } | null {
  const s = input.trim();
  if (s.length === 0) return null;

  if (/^[0-9]+$/.test(s)) {
    const value = Number(s);
    return value > 0 ? { value, style: 'arabic' } : null;
  }
  if (/^[０-９]+$/.test(s)) {
    const value = Number(
      s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)),
    );
    return value > 0 ? { value, style: 'arabic' } : null;
  }
  if (!/^[零〇一二三四五六七八九十百千万两]+$/.test(s)) return null;

  let total = 0; // 万以上累计
  let section = 0; // 当前万以内段
  let number = 0;
  for (const ch of s) {
    const v = DIGIT[ch];
    if (v !== undefined) {
      number = v;
    } else if (ch === '十') {
      section += (number === 0 ? 1 : number) * 10;
      number = 0;
    } else if (ch === '百') {
      section += (number || 1) * 100;
      number = 0;
    } else if (ch === '千') {
      section += (number || 1) * 1000;
      number = 0;
    } else if (ch === '万') {
      total += (section + number) * 10000;
      section = 0;
      number = 0;
    }
  }
  const value = total + section + number;
  return value > 0 ? { value, style: 'chinese' } : null;
}

function underTenThousand(n: number): string {
  const q = Math.floor(n / 1000);
  const b = Math.floor((n % 1000) / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  let str = '';
  if (q) str += CN_DIGITS[q] + '千';
  if (b) {
    str += CN_DIGITS[b] + '百';
  } else if (q && (t || u)) {
    str += '零';
  }
  if (t) {
    str += CN_DIGITS[t] + '十';
  } else if (b && u) {
    str += '零';
  }
  if (u) str += CN_DIGITS[u];
  if (n >= 10 && n < 20) str = str.replace(/^一十/, '十');
  return str;
}

/** 将正整数格式化为中文序数（支持到 99,999,999） */
export function formatChinese(n: number): string {
  if (!Number.isInteger(n) || n <= 0) return '';
  if (n < 10000) return underTenThousand(n);
  const hi = Math.floor(n / 10000);
  const lo = n % 10000;
  let s = underTenThousand(hi) + '万';
  if (lo === 0) return s;
  if (lo < 1000) s += '零';
  s += underTenThousand(lo);
  return s;
}

export function formatOrdinal(value: number, style: NumStyle = 'chinese'): string {
  return style === 'arabic' ? String(value) : formatChinese(value);
}
