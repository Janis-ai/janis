/** LaTeX-ish math in canonical text → readable Unicode. The stored format
 *  stays `$…$` — every channel either renders it (web surfaces get styled
 *  spans via richText's 'math' segment) or gets this translation on egress:
 *  push channels can't typeset, so $60^\circ$ becomes 60° and $x^2$ → x².
 *  Subset by design — it covers what a chat agent actually emits (inline
 *  algebra, greek, fractions, roots, scripts); anything unrecognized keeps
 *  its readable form rather than failing closed. */

const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽',
  ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ', 'x': 'ˣ',
};
const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
  '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍',
  ')': '₎', 'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'k': 'ₖ', 'l': 'ₗ',
  'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ',
  'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ',
};
const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ',
  varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const SYMBOLS: Record<string, string> = {
  ...GREEK,
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗',
  star: '⋆', bullet: '•', circ: '∘', otimes: '⊗', oplus: '⊕',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  approx: '≈', cong: '≅', equiv: '≡', sim: '∼', simeq: '≃',
  propto: '∝', parallel: '∥', perp: '⊥', mid: '∣',
  infty: '∞', aleph: 'ℵ',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱',
  to: '→', rightarrow: '→', gets: '←', leftarrow: '←',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
  uparrow: '↑', downarrow: '↓', longrightarrow: '⟶', longleftarrow: '⟵',
  implies: '⟹', impliedby: '⟸', iff: '⟺',
  in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄',
  sum: '∑', prod: '∏', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  nabla: '∇', partial: '∂',
  angle: '∠', measuredangle: '∡', triangle: '△', degree: '°',
  prime: '′', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', wp: '℘',
};
// Named functions render without the backslash — \sin, \log, \lim …
const FUNCS = new Set(
  'sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth ' +
    'log ln lg exp lim limsup liminf sup inf min max det gcd lcm deg arg ' +
    'ker dim hom Pr mod'.split(' '),
);
const LITERAL_CMDS = new Set(
  'text mathrm mathit mathbf mathsf mathtt operatorname textbf textit textnormal mbox'.split(
    ' ',
  ),
);
const ACCENTS: Record<string, string> = {
  hat: '̂', bar: '̄', overline: '̅', vec: '⃗', dot: '̇', ddot: '̈', tilde: '̃',
};
const BB: Record<string, string> = {
  R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', H: 'ℍ', P: 'ℙ', D: '𝔻',
};
const FRAC_SMALL: Record<string, string> = {
  '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾',
  '1/5': '⅕', '2/5': '⅖', '3/5': '⅗', '4/5': '⅘', '1/6': '⅙',
  '5/6': '⅚', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞',
};
const ENV_WRAP: Record<string, [string, string]> = {
  matrix: ['(', ')'], pmatrix: ['(', ')'], bmatrix: ['[', ']'],
  vmatrix: ['|', '|'], Bmatrix: ['{', '}'], Vmatrix: ['‖', '‖'],
  cases: ['{', ''],
};
const DELIMS: Record<string, string> = {
  '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '.': '', '{': '{', '}': '}',
  '\\{': '{', '\\}': '}', '\\|': '‖', '\\langle': '⟨', '\\rangle': '⟩',
  '\\lvert': '|', '\\rvert': '|', '\\lVert': '‖', '\\rVert': '‖',
  '\\lfloor': '⌊', '\\rfloor': '⌋', '\\lceil': '⌈', '\\rceil': '⌉',
};

// Multi-term operands get parens: \frac{x+1}{2} → (x+1)/2, \frac{x}{2} → x/2.
const needsParen = (s: string) =>
  s === '' || /[\s+\-=−×÷·/]/.test(s) ? `(${s})` : s;

/** The inside of one math span — \frac, \sqrt, ^{}/_{}, greek, symbol
 *  commands, \text literals, matrix environments. Unknown commands keep
 *  their name (they read as a function name, which is usually the intent). */
export function latexToUnicode(src: string): string {
  // {a \over b} infix → the same shape \frac produces.
  src = src.replace(
    /\{([^{}]+?)\s*\\over\s*([^{}]+?)\}/g,
    (_, a: string, b: string) => {
      const da = latexToUnicode(a).trim();
      const db = latexToUnicode(b).trim();
      return FRAC_SMALL[`${da}/${db}`] ?? `${needsParen(da)}/${needsParen(db)}`;
    },
  );
  let out = '';
  let i = 0;
  const n = src.length;
  // {}-balanced group or single token (\command / one char); returns the
  // raw inner source so callers can detex it in the right context.
  const readArg = (): string | null => {
    while (i < n && src[i] === ' ') i++;
    if (i >= n) return null;
    if (src[i] === '{') {
      let depth = 0;
      const start = i;
      for (; i < n; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && !--depth) {
          const inner = src.slice(start + 1, i);
          i++;
          return inner;
        }
      }
      return src.slice(start + 1); // unbalanced — take the rest
    }
    if (src[i] === '\\') {
      i++;
      const start = i;
      while (i < n && /[a-zA-Z]/.test(src[i])) i++;
      return i === start ? src.slice(i - 1, ++i) : '\\' + src.slice(start, i);
    }
    return src[i++];
  };
  const toScript = (inner: string | null, map: Record<string, string>, mark: string) => {
    const d = inner == null ? '' : latexToUnicode(inner).trim();
    if (d === '∘' || d === '°') return '°'; // 60^\circ → 60°
    if (d === '′' || d === "'") return '′';
    if (d && [...d].every((c) => map[c])) return [...d].map((c) => map[c]).join('');
    return d ? `${mark}(${d})` : '';
  };
  while (i < n) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      if (i < n && !/[a-zA-Z]/.test(src[i])) {
        // Single-char commands: \\ → newline, \, \; \: \ → space, \! →
        // nothing, \% \_ \& \# \$ \{ \} → the literal char.
        const c1 = src[i++];
        if (c1 === '\\') out += '\n';
        else if (c1 === ',' || c1 === ';' || c1 === ':' || c1 === ' ') out += ' ';
        else if (c1 === '!') { /* negative thin space — drop */ }
        else if (c1 === '|') out += '‖';
        else out += c1;
        continue;
      }
      const start = i;
      while (i < n && /[a-zA-Z]/.test(src[i])) i++;
      const name = src.slice(start, i);
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const a = latexToUnicode(readArg() ?? '').trim();
        const b = latexToUnicode(readArg() ?? '').trim();
        out += FRAC_SMALL[`${a}/${b}`] ?? `${needsParen(a)}/${needsParen(b)}`;
      } else if (name === 'sqrt') {
        while (i < n && src[i] === ' ') i++;
        let nth = '';
        if (src[i] === '[') {
          const close = src.indexOf(']', i);
          nth = latexToUnicode(src.slice(i + 1, close < 0 ? n : close)).trim();
          i = close < 0 ? n : close + 1;
        }
        const g = latexToUnicode(readArg() ?? '').trim();
        const root =
          nth === '3' ? '∛' : nth === '4' ? '∜' : nth ? `${toScript(nth, SUP, '^')}√` : '√';
        out += root + (g.length > 1 ? `(${g})` : g);
      } else if (name === 'binom') {
        const a = latexToUnicode(readArg() ?? '').trim();
        const b = latexToUnicode(readArg() ?? '').trim();
        out += `C(${a}, ${b})`;
      } else if (name === 'boxed') {
        out += `[${latexToUnicode(readArg() ?? '').trim()}]`;
      } else if (name === 'mathbb' || name === 'Bbb') {
        out += [...(readArg() ?? '')].map((c) => BB[c] ?? c).join('');
      } else if (name in ACCENTS) {
        const g = latexToUnicode(readArg() ?? '');
        out += [...g].map((c) => c + ACCENTS[name]).join('');
      } else if (name === 'left' || name === 'right' || /^bigs?g?$/.test(name)) {
        const d = readArg();
        out += d == null ? '' : (DELIMS[d] ?? d);
      } else if (name === 'begin') {
        const envName = (readArg() ?? '').trim();
        const endMark = `\\end{${envName}}`;
        const end = src.indexOf(endMark, i);
        const inner = end < 0 ? src.slice(i) : src.slice(i, end);
        i = end < 0 ? n : end + endMark.length;
        const [l, r] = ENV_WRAP[envName] ?? ['', ''];
        out += l + latexToUnicode(inner).trim() + r;
      } else if (name === 'end') {
        readArg();
      } else if (name === 'quad') out += '  ';
      else if (name === 'qquad') out += '    ';
      else if (
        name === 'displaystyle' || name === 'textstyle' || name === 'limits' ||
        name === 'nolimits' || name === 'nonumber' || name === 'overline'
      ) { /* formatting hints — drop */ }
      else if (LITERAL_CMDS.has(name)) out += readArg() ?? '';
      else if (name in SYMBOLS) out += SYMBOLS[name];
      else if (FUNCS.has(name)) out += name;
      else out += name; // unknown — the bare name reads as a function
      continue;
    }
    if (ch === '^') {
      i++;
      out += toScript(readArg(), SUP, '^');
    } else if (ch === '_') {
      i++;
      out += toScript(readArg(), SUB, '_');
    } else if (ch === '{') {
      out += latexToUnicode(readArg() ?? '');
    } else if (ch === '}') {
      i++; // stray closer
    } else if (ch === '&') {
      out += '  ';
      i++;
    } else if (ch === '~') {
      out += ' ';
      i++;
    } else if (ch === '*') {
      // * in math is multiplication — also stops a bare * surviving into
      // the canonical text and pairing as emphasis downstream.
      out += '×';
      i++;
    } else if (ch === "'") {
      out += '′';
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export interface MathSpan {
  kind: 'text' | 'math';
  text: string;
  /** $$…$$ / \[…\] — block math, not inline. */
  display?: boolean;
}

// $…$ pairs need non-space content at both ends — "costs $5 and $10" fails
// the closing rule ("5 and " ends with a space) so prices stay literal.
// \\\$ inside the inline branch lets $\$28,100$ (a dollar amount wrapped
// in math) match as ONE span instead of the body closing early at the
// escaped $ and leaking "28,100$" as prose.
// MATH_SRC is exported so richer tokenizers (the console's emphasis pass)
// can share the exact same math pattern in a combined alternation.
export const MATH_SRC =
  '\\$\\$([\\s\\S]+?)\\$\\$|\\\\\\[(.+?)\\\\\\]|\\\\\\((.+?)\\\\\\)|\\$((?=[^\\s$])(?:\\\\\\$|[^\\n$])*[^\\s$])\\$';
const MATH_RE = new RegExp(MATH_SRC, 'g');

/** Split text into prose and detexed math spans — $…$, $$…$$, \(…\), \[…\].
 *  Math translates eagerly because every consumer wants the same thing:
 *  renderers wrap the span, text channels keep the Unicode. */
export function splitMath(text: string): MathSpan[] {
  const out: MathSpan[] = [];
  let last = 0;
  MATH_RE.lastIndex = 0;
  for (let m = MATH_RE.exec(text); m; m = MATH_RE.exec(text)) {
    const body = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const d = latexToUnicode(body).trim();
    out.push({ kind: 'math', text: d || m[0], display: m[1] != null || m[2] != null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** LaTeX noise that lands OUTSIDE a closed $…$ span: the model escapes
 *  prose characters (\$, \%, \*, \( …) or glues a lone $ to a percent
 *  ("over $50% of families"). Both leak visible glyphs, so text spans get
 *  this pass — escapes become the literal char, and $N% becomes N% since
 *  a real price never ends in %. Legit math is already a span by then. */
export function cleanMathNoise(text: string): string {
  if (!/[$%\\]/.test(text)) return text;
  return text
    .replace(/\\([$%&#_{}*~^|()[\]])/g, '$1')
    .replace(/\$(\d[\d,.]*)%/g, '$1%');
}

/** Whole-string form — push channels get $60^\circ$ as 60°, $x^2$ as x². */
export function mathToUnicode(text: string): string {
  if (!/[$\\]/.test(text)) return text;
  return splitMath(text)
    .map((s) => (s.kind === 'math' ? s.text : cleanMathNoise(s.text)))
    .join('');
}
