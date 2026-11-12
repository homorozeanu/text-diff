/**
 * Diff engine: pure functions, no DOM access.
 *
 * Pipeline:
 *   1. Split both texts into lines.
 *   2. Run a Myers diff (jsdiff) over the lines, compared through a
 *      normalised key so the "ignore case / whitespace" options apply.
 *   3. Inside every block of removed + added lines, pair up the lines that
 *      resemble each other, so an edited line sits next to its counterpart.
 *   4. For each such pair, run a second diff over words or characters to
 *      mark exactly what changed within the line.
 */
import { diffArrays } from 'diff';

export type WhitespaceMode = 'exact' | 'trailing' | 'amount' | 'all';
export type InlineMode = 'word' | 'char' | 'off';

export interface DiffOptions {
  /** Treat upper- and lowercase letters as equal. */
  ignoreCase: boolean;
  /**
   * exact    - whitespace is compared like any other character
   * trailing - whitespace at the end of a line is ignored
   * amount   - runs of whitespace are equal to each other; trailing is ignored
   * all      - whitespace is ignored completely
   */
  whitespace: WhitespaceMode;
  /** Granularity of the highlighting inside changed lines. */
  inline: InlineMode;
}

export const DEFAULT_OPTIONS: DiffOptions = {
  ignoreCase: false,
  whitespace: 'exact',
  inline: 'word',
};

export interface Segment {
  text: string;
  changed: boolean;
}

export interface LineCell {
  /** 1-based line number within its own text. */
  no: number;
  text: string;
  /**
   * Intraline highlighting. Concatenating the segment texts always yields
   * `text`. Absent on unchanged lines and on lines that changed as a whole.
   */
  segments?: Segment[];
}

/**
 * equal  - line present on both sides (possibly differing in ignored details)
 * change - a removed line paired with an added line
 * delete - line only in the original text
 * insert - line only in the changed text
 */
export type RowKind = 'equal' | 'change' | 'delete' | 'insert';

export interface Row {
  kind: RowKind;
  left?: LineCell;
  right?: LineCell;
}

export interface DiffStats {
  /** Rows pairing a removed line with an added one. */
  changed: number;
  removed: number;
  added: number;
  unchanged: number;
  /** Unchanged rows whose raw text differs only in ignored case/whitespace. */
  ignored: number;
  /** Number of contiguous groups of differing rows. */
  blocks: number;
}

export interface DiffResult {
  rows: Row[];
  stats: DiffStats;
  /** Both input strings are exactly the same. */
  identical: boolean;
  /** No differing rows under the current options. */
  equivalent: boolean;
  /** The line diff hit its time limit and fell back to a coarse comparison. */
  approximate: boolean;
  /** Human-readable remarks about things the rows do not show. */
  notes: string[];
}

export type Section =
  | { type: 'rows'; start: number; end: number }
  | { type: 'fold'; start: number; end: number };

/** Two lines are shown as "the same line, edited" from this similarity up. */
const SIMILARITY_THRESHOLD = 0.5;
const LINE_DIFF_TIMEOUT_MS = 3000;
/** Give up on intraline highlighting when two lines are this far apart. */
const INLINE_MAX_EDIT_LENGTH = 2000;
/** Total time one comparison may spend on highlighting inside lines. */
const INLINE_BUDGET_MS = 1000;
/** Limits for the exact similarity alignment inside one change block. */
const ALIGN_MAX_CELLS = 250_000;
const ALIGN_MAX_WORK = 20_000_000;
/** The same kind of limit for all change blocks of one comparison together. */
const ALIGN_TOTAL_WORK = 100_000_000;
/** Time limits for the cheaper alignment used on blocks over those limits. */
const ALIGN_FALLBACK_TIMEOUT_MS = 1000;
const ALIGN_FALLBACK_BUDGET_MS = 2000;

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export interface SplitText {
  lines: string[];
  /** Whether the text ends with a line break. */
  finalNewline: boolean;
}

/**
 * Splits text into lines on LF, CRLF or CR. A trailing line break ends the
 * last line instead of starting an empty one, so "a\n" is the single line "a".
 */
export function splitLines(text: string): SplitText {
  if (text === '') return { lines: [], finalNewline: false };
  const lines: string[] = [];
  const re = /\r\n|\r|\n/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    lines.push(text.slice(last, match.index));
    last = match.index + match[0].length;
  }
  const finalNewline = last === text.length;
  if (!finalNewline) lines.push(text.slice(last));
  return { lines, finalNewline };
}

/** The form of a line that is actually compared, given the options. */
export function lineKey(line: string, opts: Pick<DiffOptions, 'ignoreCase' | 'whitespace'>): string {
  let key = line;
  switch (opts.whitespace) {
    case 'trailing':
      key = key.trimEnd();
      break;
    case 'amount':
      key = key.replace(/\s+/g, ' ').trimEnd();
      break;
    case 'all':
      key = key.replace(/\s+/g, '');
      break;
    case 'exact':
      break;
  }
  return opts.ignoreCase ? foldCase(key) : key;
}

/**
 * Lowercasing that does not depend on the surrounding text. toLowerCase()
 * turns a capital sigma at the end of a word into 'ς' and elsewhere into 'σ',
 * so a whole line and its separate words could otherwise disagree.
 */
function foldCase(text: string): string {
  return text.toLowerCase().replace(/ς/g, 'σ');
}

// ---------------------------------------------------------------------------
// Intraline diff
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  ws: boolean;
}

const WORD_RE = /(\s+)|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_]/gu;
const WS_ONLY_RE = /^\s+$/;
const ASCII_RE = /^[\x00-\x7f]*$/;

const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Splits into user-perceived characters, keeping emoji and accents intact. */
function graphemes(text: string): string[] {
  if (ASCII_RE.test(text)) return text.split('');
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
  return Array.from(text);
}

function tokenize(line: string, mode: 'word' | 'char', mergeWhitespace: boolean): Token[] {
  const tokens: Token[] = [];
  if (mode === 'word') {
    for (const match of line.matchAll(WORD_RE)) {
      tokens.push({ text: match[0], ws: match[1] !== undefined });
    }
    return tokens;
  }
  for (const g of graphemes(line)) {
    const ws = WS_ONLY_RE.test(g);
    const prev = tokens[tokens.length - 1];
    if (ws && mergeWhitespace && prev?.ws) prev.text += g;
    else tokens.push({ text: g, ws });
  }
  return tokens;
}

/**
 * Keys of the tokens that take part in the comparison, plus the index of
 * each one in the token list. Whitespace the options say to ignore is left
 * out, which makes it neutral: it can never show up as a difference.
 */
function comparable(tokens: Token[], opts: DiffOptions): { keys: string[]; index: number[] } {
  const keys: string[] = [];
  const index: number[] = [];
  const ignoreTrailing = opts.whitespace === 'trailing' || opts.whitespace === 'amount';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.ws) {
      if (opts.whitespace === 'all') continue;
      if (ignoreTrailing && i === tokens.length - 1) continue;
      keys.push(opts.whitespace === 'amount' ? ' ' : token.text);
    } else {
      keys.push(opts.ignoreCase ? foldCase(token.text) : token.text);
    }
    index.push(i);
  }
  return { keys, index };
}

function toSegments(tokens: Token[], changed: boolean[]): Segment[] {
  // Unchanged whitespace between two changed tokens joins the highlight, so
  // "quick brown" -> "slow red" reads as one edit rather than two.
  let i = 0;
  while (i < tokens.length) {
    if (changed[i] || !tokens[i]!.ws) {
      i++;
      continue;
    }
    let j = i;
    while (j < tokens.length && !changed[j] && tokens[j]!.ws) j++;
    if (i > 0 && changed[i - 1] && j < tokens.length && changed[j]) {
      for (let k = i; k < j; k++) changed[k] = true;
    }
    i = j;
  }

  const segments: Segment[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const flag = changed[k] === true;
    const last = segments[segments.length - 1];
    if (last && last.changed === flag) last.text += tokens[k]!.text;
    else segments.push({ text: tokens[k]!.text, changed: flag });
  }
  return segments;
}

/**
 * How many leading tokens of x and of y spell exactly the same text, counted
 * up to the last point where a token ends on both sides at once.
 * (["a", "b", "c"], ["ab", "d"]) gives [2, 1].
 */
function sharedLead(x: string[], y: string[]): [number, number] {
  let i = 0;
  let j = 0;
  let restX = '';
  let restY = '';
  let lead: [number, number] = [0, 0];
  for (;;) {
    if (restX === '' && restY === '') lead = [i, j];
    if (restX === '') {
      if (i === x.length) break;
      restX = x[i++]!;
    }
    if (restY === '') {
      if (j === y.length) break;
      restY = y[j++]!;
    }
    const n = Math.min(restX.length, restY.length);
    if (restX.slice(0, n) !== restY.slice(0, n)) break;
    restX = restX.slice(n);
    restY = restY.slice(n);
  }
  return lead;
}

function reverseKeys(keys: string[]): string[] {
  return keys.map((key) => Array.from(key).reverse().join('')).reverse();
}

/**
 * Word- or character-level diff of two lines. Returns null when highlighting
 * is switched off or the lines are too different for it to be worthwhile.
 */
export function diffInline(
  a: string,
  b: string,
  options: Partial<DiffOptions> = {},
): { left: Segment[]; right: Segment[] } | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (opts.inline === 'off') return null;
  const mergeWhitespace = opts.whitespace !== 'exact';
  const tokensA = tokenize(a, opts.inline, mergeWhitespace);
  const tokensB = tokenize(b, opts.inline, mergeWhitespace);
  const compA = comparable(tokensA, opts);
  const compB = comparable(tokensB, opts);

  const changes = diffArrays(compA.keys, compB.keys, { maxEditLength: INLINE_MAX_EDIT_LENGTH });
  if (!changes) return null;

  // With whitespace ignored completely, "a b" and "ab" are the same text but
  // different word tokens. Where a replaced run starts or ends with tokens
  // that spell the same text on both sides, those tokens are not a change.
  // Maps a change to the number of tokens to leave unmarked at [start, end].
  const unmarked = new Map<object, [number, number]>();
  if (opts.whitespace === 'all' && opts.inline === 'word') {
    for (let c = 0; c + 1 < changes.length; c++) {
      const x = changes[c]!;
      const y = changes[c + 1]!;
      if (!((x.removed && y.added) || (x.added && y.removed))) continue;
      const [headX, headY] = sharedLead(x.value, y.value);
      const [tailX, tailY] = sharedLead(reverseKeys(x.value.slice(headX)), reverseKeys(y.value.slice(headY)));
      unmarked.set(x, [headX, tailX]);
      unmarked.set(y, [headY, tailY]);
    }
  }

  const changedA = new Array<boolean>(tokensA.length).fill(false);
  const changedB = new Array<boolean>(tokensB.length).fill(false);
  let i = 0;
  let j = 0;
  for (const change of changes) {
    const count = change.value.length;
    const [head, tail] = unmarked.get(change) ?? [0, 0];
    if (change.removed) {
      for (let k = 0; k < count; k++, i++) {
        if (k >= head && k < count - tail) changedA[compA.index[i]!] = true;
      }
    } else if (change.added) {
      for (let k = 0; k < count; k++, j++) {
        if (k >= head && k < count - tail) changedB[compB.index[j]!] = true;
      }
    } else {
      i += count;
      j += count;
    }
  }
  return { left: toSegments(tokensA, changedA), right: toSegments(tokensB, changedB) };
}

// ---------------------------------------------------------------------------
// Similarity (used to pair removed lines with added lines)
// ---------------------------------------------------------------------------

interface Profile {
  text: string;
  grams: Map<string, number>;
  total: number;
}

function profile(line: string, opts: DiffOptions): Profile {
  // Indentation is collapsed so it cannot make unrelated lines look alike.
  const text = lineKey(line, opts).replace(/\s+/g, ' ').trim();
  const grams = new Map<string, number>();
  for (let i = 0; i + 1 < text.length; i++) {
    const gram = text.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return { text, grams, total: Math.max(0, text.length - 1) };
}

/** Sørensen–Dice coefficient over character bigrams, from 0 to 1. */
function similarity(x: Profile, y: Profile): number {
  // Two blank lines may pair up, but must not outrank a pair with real content.
  if (x.text === y.text) return x.text === '' ? SIMILARITY_THRESHOLD : 1;
  if (x.total === 0 || y.total === 0) return 0;
  const [small, large] = x.grams.size <= y.grams.size ? [x, y] : [y, x];
  let common = 0;
  for (const [gram, count] of small.grams) {
    const other = large.grams.get(gram);
    if (other !== undefined) common += Math.min(count, other);
  }
  return (2 * common) / (x.total + y.total);
}

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------

interface Context {
  a: string[];
  b: string[];
  idsA: number[];
  idsB: number[];
  opts: DiffOptions;
  rows: Row[];
  /** Similarity profiles of the lines in the block being aligned. */
  profilesA: Map<number, Profile>;
  profilesB: Map<number, Profile>;
  /** Budgets shared by all change blocks; see the constants above. */
  inlineMsLeft: number;
  alignWorkLeft: number;
  alignMsLeft: number;
  /** Set when a budget ran out, so the result can say so. */
  inlineSkipped: boolean;
  alignLimited: boolean;
}

function profileOf(ctx: Context, side: 'a' | 'b', index: number): Profile {
  const cache = side === 'a' ? ctx.profilesA : ctx.profilesB;
  let p = cache.get(index);
  if (!p) {
    p = profile((side === 'a' ? ctx.a : ctx.b)[index]!, ctx.opts);
    cache.set(index, p);
  }
  return p;
}

function pushEqual(ctx: Context, ai: number, bi: number): void {
  ctx.rows.push({
    kind: 'equal',
    left: { no: ai + 1, text: ctx.a[ai]! },
    right: { no: bi + 1, text: ctx.b[bi]! },
  });
}

function pushPair(ctx: Context, ai: number, bi: number): void {
  if (ctx.idsA[ai] === ctx.idsB[bi]) {
    // Only reachable after a timed-out (non-minimal) line diff.
    pushEqual(ctx, ai, bi);
    return;
  }
  const left: LineCell = { no: ai + 1, text: ctx.a[ai]! };
  const right: LineCell = { no: bi + 1, text: ctx.b[bi]! };
  if (
    ctx.opts.inline !== 'off' &&
    similarity(profileOf(ctx, 'a', ai), profileOf(ctx, 'b', bi)) >= SIMILARITY_THRESHOLD
  ) {
    if (ctx.inlineMsLeft <= 0) {
      ctx.inlineSkipped = true;
    } else {
      const started = performance.now();
      const inline = diffInline(left.text, right.text, ctx.opts);
      ctx.inlineMsLeft -= performance.now() - started;
      if (inline) {
        left.segments = inline.left;
        right.segments = inline.right;
      }
    }
  }
  ctx.rows.push({ kind: 'change', left, right });
}

/**
 * Cheaper alignment for blocks too big for the table in similarPairs: a Myers
 * diff in which two lines count as equal when they are similar enough and
 * neither has a better match right next to the other. (The second condition
 * matters for uniform data such as logs or CSV, where every line resembles
 * its neighbours.) It is fast when most lines have a counterpart, which is
 * the usual reason for a big block: every line edited a little. Returns []
 * when it runs out of time, and the block is then paired by position.
 */
function similarPairsGreedy(ctx: Context, a0: number, an: number, b0: number, bn: number): Array<[number, number]> {
  if (ctx.alignMsLeft <= 0) {
    ctx.alignLimited = true;
    return [];
  }
  const left = Array.from({ length: an }, (_, i) => i);
  const right = Array.from({ length: bn }, (_, j) => j);
  const sim = (i: number, j: number): number =>
    i < 0 || j < 0 || i >= an || j >= bn
      ? 0
      : similarity(profileOf(ctx, 'a', a0 + i), profileOf(ctx, 'b', b0 + j));
  const started = performance.now();
  const changes = diffArrays(left, right, {
    comparator: (i, j) => {
      const here = sim(i, j);
      return (
        here >= SIMILARITY_THRESHOLD &&
        here >= sim(i, j - 1) &&
        here >= sim(i, j + 1) &&
        here >= sim(i - 1, j) &&
        here >= sim(i + 1, j)
      );
    },
    timeout: Math.min(ALIGN_FALLBACK_TIMEOUT_MS, ctx.alignMsLeft),
  });
  ctx.alignMsLeft -= performance.now() - started;
  if (!changes) {
    ctx.alignLimited = true;
    return [];
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  for (const change of changes) {
    const count = change.value.length;
    if (change.removed) i += count;
    else if (change.added) j += count;
    else for (let k = 0; k < count; k++) pairs.push([i++, j++]);
  }
  return pairs;
}

/**
 * Finds the order-preserving set of (removed, added) line pairs with the
 * highest total similarity, using only pairs above the threshold. Offsets are
 * relative to the block. Blocks too big for this get the greedy version.
 */
function similarPairs(ctx: Context, a0: number, an: number, b0: number, bn: number): Array<[number, number]> {
  let lenA = 0;
  let lenB = 0;
  for (let i = 0; i < an; i++) lenA += ctx.a[a0 + i]!.length;
  for (let j = 0; j < bn; j++) lenB += ctx.b[b0 + j]!.length;
  const work = Math.min(bn * lenA, an * lenB);
  if (an * bn > ALIGN_MAX_CELLS || work > ALIGN_MAX_WORK || work > ctx.alignWorkLeft) {
    return similarPairsGreedy(ctx, a0, an, b0, bn);
  }
  ctx.alignWorkLeft -= work;

  const width = bn + 1;
  const sims = new Float64Array(an * bn);
  const score = new Float64Array((an + 1) * width);
  for (let i = 1; i <= an; i++) {
    const pa = profileOf(ctx, 'a', a0 + i - 1);
    for (let j = 1; j <= bn; j++) {
      const sim = similarity(pa, profileOf(ctx, 'b', b0 + j - 1));
      sims[(i - 1) * bn + (j - 1)] = sim;
      let best = Math.max(score[(i - 1) * width + j]!, score[i * width + j - 1]!);
      if (sim >= SIMILARITY_THRESHOLD) best = Math.max(best, score[(i - 1) * width + j - 1]! + sim);
      score[i * width + j] = best;
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = an;
  let j = bn;
  while (i > 0 && j > 0) {
    const sim = sims[(i - 1) * bn + (j - 1)]!;
    const here = score[i * width + j]!;
    if (sim >= SIMILARITY_THRESHOLD && here === score[(i - 1) * width + j - 1]! + sim) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (here === score[(i - 1) * width + j]!) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

/** Turns one block of `an` removed and `bn` added lines into rows. */
function alignBlock(ctx: Context, a0: number, an: number, b0: number, bn: number): void {
  if (an === 0 && bn === 0) return;
  const anchors = an > 0 && bn > 0 ? similarPairs(ctx, a0, an, b0, bn) : [];
  anchors.push([an, bn]); // sentinel: flushes whatever follows the last pair

  let i = 0;
  let j = 0;
  for (const [ai, bj] of anchors) {
    // Lines between two anchors have no good counterpart. They are laid out
    // side by side in order, and the surplus becomes pure deletes / inserts.
    while (i < ai || j < bj) {
      if (i < ai && j < bj) {
        pushPair(ctx, a0 + i++, b0 + j++);
      } else if (i < ai) {
        const index = a0 + i++;
        ctx.rows.push({ kind: 'delete', left: { no: index + 1, text: ctx.a[index]! } });
      } else {
        const index = b0 + j++;
        ctx.rows.push({ kind: 'insert', right: { no: index + 1, text: ctx.b[index]! } });
      }
    }
    if (ai < an) {
      pushPair(ctx, a0 + ai, b0 + bj);
      i = ai + 1;
      j = bj + 1;
    }
  }
  // Profiles are only useful within the block they belong to.
  ctx.profilesA.clear();
  ctx.profilesB.clear();
}

function computeStats(rows: Row[]): DiffStats {
  const stats: DiffStats = { changed: 0, removed: 0, added: 0, unchanged: 0, ignored: 0, blocks: 0 };
  let inBlock = false;
  for (const row of rows) {
    if (row.kind === 'equal') {
      stats.unchanged++;
      if (row.left!.text !== row.right!.text) stats.ignored++;
      inBlock = false;
      continue;
    }
    if (row.kind === 'change') stats.changed++;
    else if (row.kind === 'delete') stats.removed++;
    else stats.added++;
    if (!inBlock) stats.blocks++;
    inBlock = true;
  }
  return stats;
}

/** Compares two texts line by line. */
export function diffTexts(aText: string, bText: string, options: Partial<DiffOptions> = {}): DiffResult {
  const opts: DiffOptions = { ...DEFAULT_OPTIONS, ...options };
  const splitA = splitLines(aText);
  const splitB = splitLines(bText);
  const a = splitA.lines;
  const b = splitB.lines;

  // Compare small integers instead of strings: equal keys share an id.
  const table = new Map<string, number>();
  const intern = (line: string): number => {
    const key = lineKey(line, opts);
    let id = table.get(key);
    if (id === undefined) {
      id = table.size;
      table.set(key, id);
    }
    return id;
  };
  const idsA = a.map(intern);
  const idsB = b.map(intern);

  const ctx: Context = {
    a,
    b,
    idsA,
    idsB,
    opts,
    rows: [],
    profilesA: new Map(),
    profilesB: new Map(),
    inlineMsLeft: INLINE_BUDGET_MS,
    alignWorkLeft: ALIGN_TOTAL_WORK,
    alignMsLeft: ALIGN_FALLBACK_BUDGET_MS,
    inlineSkipped: false,
    alignLimited: false,
  };

  // Shared head and tail need no diffing at all.
  const shortest = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shortest && idsA[prefix] === idsB[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && idsA[a.length - 1 - suffix] === idsB[b.length - 1 - suffix]) suffix++;

  const midA = idsA.slice(prefix, a.length - suffix);
  const midB = idsB.slice(prefix, b.length - suffix);
  let approximate = false;
  let ai = 0;
  let bi = 0;
  for (let k = 0; k < prefix; k++) pushEqual(ctx, ai++, bi++);

  if (midA.length > 0 || midB.length > 0) {
    // A line that occurs on one side only can never be matched, so it is
    // left out of the line diff, whose cost grows with the square of the
    // number of differing lines. The matches found are the same either way.
    const inA = new Set(midA);
    const inB = new Set(midB);
    const keepA: number[] = [];
    const keepB: number[] = [];
    for (let k = 0; k < midA.length; k++) if (inB.has(midA[k]!)) keepA.push(k);
    for (let k = 0; k < midB.length; k++) if (inA.has(midB[k]!)) keepB.push(k);
    const startA = ai;
    const startB = bi;
    // Everything between two matched lines is one block of changes.
    const blockUpTo = (endA: number, endB: number): void => {
      alignBlock(ctx, ai, endA - ai, bi, endB - bi);
      ai = endA;
      bi = endB;
    };

    const changes =
      keepA.length === 0 || keepB.length === 0
        ? []
        : diffArrays(
            keepA.map((k) => midA[k]!),
            keepB.map((k) => midB[k]!),
            { timeout: LINE_DIFF_TIMEOUT_MS },
          );
    if (!changes) {
      approximate = true;
    } else {
      let x = 0;
      let y = 0;
      for (const change of changes) {
        const count = change.value.length;
        if (change.removed) x += count;
        else if (change.added) y += count;
        else {
          for (let k = 0; k < count; k++) {
            blockUpTo(startA + keepA[x++]!, startB + keepB[y++]!);
            pushEqual(ctx, ai++, bi++);
          }
        }
      }
    }
    blockUpTo(startA + midA.length, startB + midB.length);
  }
  for (let k = 0; k < suffix; k++) pushEqual(ctx, ai++, bi++);

  const stats = computeStats(ctx.rows);
  const notes: string[] = [];
  if (approximate) {
    notes.push(
      'Comparing these texts took too long and was cut short. ' +
        'Every line is still shown, but lines that match may be reported as changed.',
    );
  }
  if (ctx.alignLimited) {
    notes.push(
      'Some very large blocks of changed lines were matched up only roughly, ' +
        'so a line may not sit next to its counterpart there.',
    );
  }
  if (ctx.inlineSkipped) {
    notes.push('To keep the comparison fast, some changed lines are shown without highlighting inside the line.');
  }
  if (a.length > 0 && b.length > 0 && splitA.finalNewline !== splitB.finalNewline) {
    notes.push(
      splitA.finalNewline
        ? 'Only the original text ends with a line break.'
        : 'Only the changed text ends with a line break.',
    );
  }

  return {
    rows: ctx.rows,
    stats,
    identical: aText === bText,
    equivalent: stats.changed + stats.removed + stats.added === 0,
    approximate,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Folding of unchanged regions
// ---------------------------------------------------------------------------

/**
 * Groups rows into visible ranges and folds. Rows that differ stay visible
 * together with `context` unchanged rows on either side; longer unchanged
 * stretches become folds. `end` is exclusive.
 */
export function buildSections(rows: Row[], context = 3, minFold = 4): Section[] {
  const n = rows.length;
  if (n === 0) return [];
  const visible = new Uint8Array(n);
  let lastChange = -Infinity;
  for (let i = 0; i < n; i++) {
    if (rows[i]!.kind !== 'equal') lastChange = i;
    if (i - lastChange <= context) visible[i] = 1;
  }
  let nextChange = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    if (rows[i]!.kind !== 'equal') nextChange = i;
    if (nextChange - i <= context) visible[i] = 1;
  }

  const sections: Section[] = [];
  let i = 0;
  while (i < n) {
    const flag = visible[i];
    let j = i;
    while (j < n && visible[j] === flag) j++;
    const type = flag === 1 || j - i < minFold ? 'rows' : 'fold';
    const last = sections[sections.length - 1];
    if (type === 'rows' && last?.type === 'rows') last.end = j;
    else sections.push({ type, start: i, end: j });
    i = j;
  }
  return sections;
}
