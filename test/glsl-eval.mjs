// A small interpreter for the GLSL the stage's helpers use (float/vec maths,
// declarations, assignments, `if (…) return …;`, swizzles and a handful of
// built-ins), so tests run the shader's own text on the CPU. Vectors are arrays.
// `texture` fetches the nearest texel, as the stage's nearest-filtered LUT does.

const TOKEN = /\s*(\d+\.\d*|\.\d+|\d+|[A-Za-z_]\w*|<=|>=|==|[-+*/<>=(){};,.])/y;

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while (TOKEN.lastIndex < src.length && (m = TOKEN.exec(src))) out.push(m[1]);
  if (TOKEN.lastIndex < src.trimEnd().length) throw new Error("glsl-eval: can't read at " + TOKEN.lastIndex);
  return out;
}

const SWIZZLE = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
const TYPES = new Set(["float", "int", "vec2", "vec3", "vec4", "sampler2D", "bool"]);

function zip(a, b, f) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const n = Array.isArray(a) ? a.length : b.length;
    return Array.from({ length: n }, (_, i) => f(Array.isArray(a) ? a[i] : a, Array.isArray(b) ? b[i] : b));
  }
  return f(a, b);
}
const each = (a, f) => (Array.isArray(a) ? a.map(f) : f(a));
const vec = (n) => (...args) => {
  const flat = args.flat();
  return flat.length === 1 ? Array(n).fill(flat[0]) : flat.slice(0, n);
};

const BUILTINS = {
  vec2: vec(2), vec3: vec(3), vec4: vec(4), float: (x) => x,
  floor: (a) => each(a, Math.floor),
  abs: (a) => each(a, Math.abs),
  min: (a, b) => zip(a, b, Math.min),
  max: (a, b) => zip(a, b, Math.max),
  clamp: (a, lo, hi) => zip(zip(a, lo, Math.max), hi, Math.min),
  mix: (a, b, t) => OPS["+"](a, OPS["*"](OPS["-"](b, a), t)),
  step: (edge, a) => zip(edge, a, (e, x) => (x < e ? 0 : 1)),
  textureSize: (tex) => [tex.width, tex.height],
  texture: (tex, uv) => {
    if (tex.width < 1) return [0, 0, 0, 0];
    const ix = Math.min(tex.width - 1, Math.max(0, Math.floor(uv[0] * tex.width)));
    const iy = Math.min(tex.height - 1, Math.max(0, Math.floor(uv[1] * tex.height)));
    const o = (iy * tex.width + ix) * 4;
    return Array.from(tex.data.subarray(o, o + 4));
  },
};

class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek(k = 0) { return this.t[this.i + k]; }
  next() { return this.t[this.i++]; }
  eat(tok) { if (this.next() !== tok) throw new Error(`glsl-eval: expected ${tok} at token ${this.i - 1}`); }

  program() {
    const fns = {};
    while (this.i < this.t.length) {
      this.next(); // return type
      const name = this.next();
      this.eat("(");
      const params = [];
      while (this.peek() !== ")") {
        this.next();
        params.push(this.next());
        if (this.peek() === ",") this.next();
      }
      this.eat(")");
      fns[name] = { params, body: this.block() };
    }
    return fns;
  }
  block() {
    this.eat("{");
    const stmts = [];
    while (this.peek() !== "}") stmts.push(this.statement());
    this.eat("}");
    return stmts;
  }
  statement() {
    const tok = this.peek();
    if (tok === "return") { this.next(); const e = this.expr(); this.eat(";"); return { kind: "return", e }; }
    if (tok === "if") {
      this.next(); this.eat("(");
      const cond = this.expr();
      this.eat(")");
      return { kind: "if", cond, then: this.statement() };
    }
    if (TYPES.has(tok) && /^[A-Za-z_]/.test(this.peek(1))) {
      this.next();
      const name = this.next();
      this.eat("=");
      const e = this.expr();
      this.eat(";");
      return { kind: "set", name, e };
    }
    const name = this.next();
    this.eat("=");
    const e = this.expr();
    this.eat(";");
    return { kind: "set", name, e };
  }
  expr() { return this.compare(); }
  compare() {
    let l = this.additive();
    while (["<", ">", "<=", ">="].includes(this.peek())) { const op = this.next(); l = { op, l, r: this.additive() }; }
    return l;
  }
  additive() {
    let l = this.term();
    while (this.peek() === "+" || this.peek() === "-") { const op = this.next(); l = { op, l, r: this.term() }; }
    return l;
  }
  term() {
    let l = this.unary();
    while (this.peek() === "*" || this.peek() === "/") { const op = this.next(); l = { op, l, r: this.unary() }; }
    return l;
  }
  unary() {
    if (this.peek() === "-") { this.next(); return { op: "neg", l: this.unary() }; }
    return this.postfix();
  }
  postfix() {
    let e = this.primary();
    while (this.peek() === ".") { this.next(); e = { op: "swz", l: e, s: this.next() }; }
    return e;
  }
  primary() {
    const tok = this.next();
    if (tok === "(") { const e = this.expr(); this.eat(")"); return e; }
    if (/^[\d.]/.test(tok)) return { num: Number(tok) };
    if (this.peek() === "(") {
      this.next();
      const args = [];
      while (this.peek() !== ")") { args.push(this.expr()); if (this.peek() === ",") this.next(); }
      this.eat(")");
      return { call: tok, args };
    }
    return { id: tok };
  }
}

const OPS = {
  "+": (a, b) => zip(a, b, (x, y) => x + y),
  "-": (a, b) => zip(a, b, (x, y) => x - y),
  "*": (a, b) => zip(a, b, (x, y) => x * y),
  "/": (a, b) => zip(a, b, (x, y) => x / y),
  "<": (a, b) => a < b, ">": (a, b) => a > b, "<=": (a, b) => a <= b, ">=": (a, b) => a >= b,
};

/** The source as the host's GLSL preprocessor leaves it for a photo at
 *  `version`: the `#if SL_PROCESS_VERSION >= n` branches resolved and the
 *  directive lines gone. */
export function forVersion(src, version) {
  const taking = [];
  const out = [];
  for (const line of src.split("\n")) {
    const open = /^\s*#if SL_PROCESS_VERSION >= (\d+)\s*$/.exec(line);
    if (open) taking.push(version >= Number(open[1]));
    else if (/^\s*#else\s*$/.test(line)) taking.push(!taking.pop());
    else if (/^\s*#endif\s*$/.test(line)) taking.pop();
    else if (taking.every(Boolean)) out.push(line);
  }
  if (taking.length) throw new Error("glsl-eval: unbalanced #if");
  return out.join("\n");
}

export function compileGlsl(src) {
  const fns = new Parser(tokenize(src)).program();
  const evalExpr = (e, env) => {
    if ("num" in e) return e.num;
    if ("id" in e) {
      if (!(e.id in env)) throw new Error("glsl-eval: unknown " + e.id);
      return env[e.id];
    }
    if ("call" in e) {
      const args = e.args.map((a) => evalExpr(a, env));
      if (fns[e.call]) return run(e.call, args);
      if (BUILTINS[e.call]) return BUILTINS[e.call](...args);
      throw new Error("glsl-eval: unknown function " + e.call);
    }
    if (e.op === "neg") return each(evalExpr(e.l, env), (x) => -x);
    if (e.op === "swz") {
      const v = evalExpr(e.l, env);
      const picked = [...e.s].map((c) => v[SWIZZLE[c]]);
      return picked.length === 1 ? picked[0] : picked;
    }
    return OPS[e.op](evalExpr(e.l, env), evalExpr(e.r, env));
  };
  const exec = (stmts, env) => {
    for (const s of stmts) {
      if (s.kind === "return") return { value: evalExpr(s.e, env) };
      if (s.kind === "set") env[s.name] = evalExpr(s.e, env);
      else if (s.kind === "if" && evalExpr(s.cond, env)) {
        const r = exec([s.then], env);
        if (r) return r;
      }
    }
    return null;
  };
  function run(name, args) {
    const fn = fns[name];
    const env = Object.fromEntries(fn.params.map((p, i) => [p, args[i]]));
    const r = exec(fn.body, env);
    return r ? r.value : undefined;
  }
  return run;
}
