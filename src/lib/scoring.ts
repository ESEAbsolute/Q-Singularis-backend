// ===========================================================================
// Q-Singularis 计分表达式引擎
//
// 每期规则数据驱动：给 N 个 raw data 项，每项配置一个分数表达式 sc_i。
// 表达式由「运算符 + - * / ^」「函数 ln() max() min()」「括号」「浮点数」
// 以及标识符组成。
//
// 标识符：
//   d_n   —— 第 n 个 raw data（1 起始）
//   sc_n  —— 第 n 个分数（可被其它表达式引用，引擎拓扑求解，循环报错）
//   <raw key> —— 也可直接用赛季配置里的 raw 字段名（例如伤害量字段 key 为 damage 时写 damage）
//
// d_n / raw key 不要求等于本项下标：可引用任意原始数据与任意其他分数。
// 引擎对 sc_1..sc_N 做拓扑求解；检测循环引用并报错。总分 = Σ sc_i。
//
// 分数展示取 1 位小数；排行按精确值（未舍入）排序。
// ===========================================================================

export class ScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringError';
  }
}

type Token =
  | { type: 'num'; value: number }
  | { type: 'ident'; name: string } // d_n / sc_n / raw key / 函数名
  | { type: 'op'; op: string } // + - * / ^ , 
  | { type: 'lp' }
  | { type: 'rp' };

const FUNCTIONS = new Set(['ln', 'max', 'min']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = src.replace(/\s+/g, '');
  while (i < s.length) {
    const ch = s[i];
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const raw = s.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new ScoringError(`非法数字: ${raw}`);
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      tokens.push({ type: 'ident', name: s.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(ch)) {
      if (ch === '(') tokens.push({ type: 'lp' });
      else if (ch === ')') tokens.push({ type: 'rp' });
      else tokens.push({ type: 'op', op: ch });
      i++;
      continue;
    }
    throw new ScoringError(`无法识别的字符: "${ch}"`);
  }
  return tokens;
}

// AST
type Node =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string } // d_n / sc_n / raw key
  | { kind: 'unary'; op: '-'; child: Node }
  | { kind: 'bin'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  expect(op: ')' | ',' | string): void {
    const t = this.next();
    if (!t) throw new ScoringError(`缺少 "${op}"`);
    if (op === ')') {
      if (t.type === 'rp') return;
    } else if (op === ',') {
      if (t.type === 'op' && t.op === ',') return;
    } else if (t.type === 'op' && t.op === op) {
      return;
    }
    throw new ScoringError(`期望运算符 "${op}"`);
  }

  parse(): Node {
    if (this.tokens.length === 0) throw new ScoringError('空表达式');
    const node = this.expr();
    if (this.pos < this.tokens.length) throw new ScoringError('表达式存在多余内容');
    return node;
  }

  // + -（低优先级，左结合）
  expr(): Node {
    let left = this.term();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.op === '+' || t.op === '-')) {
        this.next();
        left = { kind: 'bin', op: t.op, left, right: this.term() };
      } else return left;
    }
  }

  // * /（中优先级，左结合）
  term(): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.op === '*' || t.op === '/')) {
        this.next();
        left = { kind: 'bin', op: t.op, left, right: this.unary() };
      } else return left;
    }
  }

  // ^（右结合、优先级高于 * /）+ 一元负号
  unary(): Node {
    const t = this.peek();
    if (t && t.type === 'op' && t.op === '-') {
      this.next();
      return { kind: 'unary', op: '-', child: this.unary() };
    }
    return this.power();
  }

  power(): Node {
    const base = this.primary();
    const t = this.peek();
    if (t && t.type === 'op' && t.op === '^') {
      this.next();
      return { kind: 'bin', op: '^', left: base, right: this.unary() };
    }
    return base;
  }

  primary(): Node {
    const t = this.next();
    if (!t) throw new ScoringError('表达式意外结束');
    if (t.type === 'num') return { kind: 'num', value: t.value };
    if (t.type === 'lp') {
      const inner = this.expr();
      this.expect(')');
      return inner;
    }
    if (t.type === 'ident') {
      // 函数调用：ln(x) / max(a, b, ...) / min(a, b, ...)
      if (FUNCTIONS.has(t.name)) {
        const lp = this.next();
        if (!lp || lp.type !== 'lp') {
          throw new ScoringError(`${t.name} 需要括号参数：${t.name}(...)`);
        }
        const args: Node[] = [];
        if (this.peek()?.type === 'rp') {
          this.next();
        } else {
          args.push(this.expr());
          while (this.peek()?.type === 'op' && (this.peek() as { op: string }).op === ',') {
            this.next();
            args.push(this.expr());
          }
          this.expect(')');
        }
        if (t.name === 'ln' && args.length !== 1) {
          throw new ScoringError('ln 只需要一个参数：ln(x)');
        }
        if ((t.name === 'max' || t.name === 'min') && args.length < 1) {
          throw new ScoringError(`${t.name} 至少需要一个参数`);
        }
        return { kind: 'call', name: t.name, args };
      }
      // 变量：d_n / sc_n / raw key（合法性由 collectRefs 结合 rawKeys 校验）
      return { kind: 'var', name: t.name };
    }
    throw new ScoringError('语法错误');
  }
}

function parse(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

interface VarRefs {
  dRefs: number[];
  scRefs: number[];
  unknown: string[];
}

/** 将变量名解析为 (d 下标 | sc 下标) */
function resolveVar(
  name: string,
  n: number,
  keyIndex: Map<string, number> | null
): { type: 'd' | 'sc'; idx: number } | null {
  const m = /^(d|sc)_([0-9]+)$/.exec(name);
  if (m) {
    const idx = Number(m[2]);
    if (m[1] === 'd') return { type: 'd', idx };
    return { type: 'sc', idx };
  }
  if (keyIndex && keyIndex.has(name)) {
    return { type: 'd', idx: keyIndex.get(name)! };
  }
  return null;
}

function collectRefs(node: Node, out: VarRefs, n: number, keyIndex: Map<string, number> | null): void {
  switch (node.kind) {
    case 'num':
      return;
    case 'var': {
      const resolved = resolveVar(node.name, n, keyIndex);
      if (!resolved) {
        out.unknown.push(node.name);
        return;
      }
      if (resolved.type === 'd') out.dRefs.push(resolved.idx);
      else out.scRefs.push(resolved.idx);
      return;
    }
    case 'unary':
      return collectRefs(node.child, out, n, keyIndex);
    case 'bin':
      collectRefs(node.left, out, n, keyIndex);
      collectRefs(node.right, out, n, keyIndex);
      return;
    case 'call':
      for (const a of node.args) collectRefs(a, out, n, keyIndex);
      return;
  }
}

function evaluate(node: Node, vars: Map<string, number>): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'var': {
      const v = vars.get(node.name);
      if (v === undefined) throw new ScoringError(`缺少变量 ${node.name}`);
      return v;
    }
    case 'unary':
      return -evaluate(node.child, vars);
    case 'bin': {
      const l = evaluate(node.left, vars);
      const r = evaluate(node.right, vars);
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/': {
          if (r === 0) throw new ScoringError('除数为 0');
          return l / r;
        }
        case '^': {
          const v = Math.pow(l, r);
          if (!Number.isFinite(v)) throw new ScoringError(`非法幂运算: ${l}^${r}`);
          return v;
        }
        default:
          throw new ScoringError(`未知运算符 ${node.op}`);
      }
    }
    case 'call': {
      const values = node.args.map((a) => evaluate(a, vars));
      switch (node.name) {
        case 'ln': {
          const a = values[0];
          if (!(a > 0)) throw new ScoringError(`ln 的自变量必须大于 0，当前为 ${a}`);
          return Math.log(a);
        }
        case 'max':
          return Math.max(...values);
        case 'min':
          return Math.min(...values);
        default:
          throw new ScoringError(`未知函数 ${node.name}`);
      }
    }
  }
}

export interface ScoreResult {
  /** sc_1..sc_N（精确值） */
  scores: number[];
  /** 总分 = Σ sc_i（精确值） */
  total: number;
}

/**
 * 依据表达式计算分数。
 * @param expressions sc_1..sc_N 的表达式字符串
 * @param rawValues   d_1..d_N 的原始数据值（长度需一致）
 * @param rawKeys     raw 字段名列表（与 rawValues 同序）；不传则只能引用 d_n/sc_n
 */
export function computeScores(
  expressions: string[],
  rawValues: number[],
  rawKeys?: string[]
): ScoreResult {
  if (expressions.length === 0) throw new ScoringError('未配置任何分数表达式');
  if (rawValues.length !== expressions.length) {
    throw new ScoringError(
      `raw data 数量(${rawValues.length})与表达式数量(${expressions.length})不一致`
    );
  }
  const n = expressions.length;
  const keyIndex = new Map<string, number>();
  if (rawKeys) {
    if (rawKeys.length !== n) {
      throw new ScoringError(`raw key 数量(${rawKeys.length})与表达式数量(${n})不一致`);
    }
    rawKeys.forEach((k, i) => keyIndex.set(k, i + 1));
  }
  const asts = expressions.map((e) => {
    if (typeof e !== 'string' || e.trim() === '')
      throw new ScoringError('存在空表达式');
    return parse(e);
  });

  // 收集依赖（顺便校验未知标识符 / 越界引用）
  const deps: number[][] = asts.map((ast) => {
    const refs: VarRefs = { dRefs: [], scRefs: [], unknown: [] };
    collectRefs(ast, refs, n, keyIndex.size > 0 ? keyIndex : null);
    if (refs.unknown.length > 0) {
      throw new ScoringError(
        `未知标识符 "${refs.unknown[0]}"（可用 d_1..d_${n}、sc_1..sc_${n}${
          rawKeys && rawKeys.length ? ' 或 raw 字段名 ' + rawKeys.join('/') : ''
        }）`
      );
    }
    for (const di of refs.dRefs) {
      if (di < 1 || di > n) throw new ScoringError(`引用了不存在的 d_${di}（当前共 ${n} 项）`);
    }
    for (const si of refs.scRefs) {
      if (si < 1 || si > n) throw new ScoringError(`引用了不存在的 sc_${si}（当前共 ${n} 项）`);
    }
    return refs.scRefs;
  });

  // 拓扑排序（Kahn）。sc 自身依赖自己 -> 环。
  const order: number[] = [];
  const indeg = Array.from({ length: n }, (_, i) => new Set(deps[i]).size);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (const s of deps[i]) {
      if (s - 1 === i) throw new ScoringError(`sc_${i + 1} 引用了自身，存在循环`);
      adj[s - 1].push(i);
    }
  }
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const nx of adj[cur]) {
      indeg[nx]--;
      if (indeg[nx] === 0) queue.push(nx);
    }
  }
  if (order.length !== n) {
    throw new ScoringError('分数表达式存在循环引用（sc 互相依赖）');
  }

  const vars = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    vars.set(`d_${i + 1}`, rawValues[i]);
    if (rawKeys) vars.set(rawKeys[i], rawValues[i]);
  }

  const scores = new Array<number>(n).fill(0);
  for (const i of order) {
    const v = evaluate(asts[i], vars);
    if (!Number.isFinite(v)) throw new ScoringError(`sc_${i + 1} 计算结果不是有限数字`);
    scores[i] = v;
    vars.set(`sc_${i + 1}`, v);
  }
  const total = scores.reduce((a, b) => a + b, 0);
  return { scores, total };
}

/** 校验表达式（建期/改配置时用）：确保语法与引用合法、无环 */
export function validateExpressions(
  expressions: string[],
  itemCount: number,
  rawKeys?: string[]
): void {
  computeScores(expressions, new Array<number>(itemCount).fill(1), rawKeys);
}

/** 展示用：保留 1 位小数（排行仍用精确值） */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function fmt1(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}
