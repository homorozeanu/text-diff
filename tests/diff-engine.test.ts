import { describe, expect, it } from 'vitest';
import {
  buildSections,
  diffInline,
  diffTexts,
  lineKey,
  splitLines,
  type DiffOptions,
  type Row,
  type Segment,
} from '../src/diff-engine';

const kinds = (rows: Row[]): string => rows.map((r) => r.kind[0]).join('');
const join = (segments: Segment[] | undefined): string => (segments ?? []).map((s) => s.text).join('');
const changedText = (segments: Segment[] | undefined): string[] =>
  (segments ?? []).filter((s) => s.changed).map((s) => s.text);

/** Rows must reproduce both inputs exactly, in order, with correct numbers. */
function expectFaithful(a: string, b: string, options: Partial<DiffOptions> = {}): void {
  const { rows } = diffTexts(a, b, options);
  const left = rows.filter((r) => r.left).map((r) => r.left!);
  const right = rows.filter((r) => r.right).map((r) => r.right!);
  expect(left.map((c) => c.text)).toEqual(splitLines(a).lines);
  expect(right.map((c) => c.text)).toEqual(splitLines(b).lines);
  expect(left.map((c) => c.no)).toEqual(left.map((_, i) => i + 1));
  expect(right.map((c) => c.no)).toEqual(right.map((_, i) => i + 1));
  for (const row of rows) {
    if (row.kind === 'equal' || row.kind === 'change') expect(row.left && row.right).toBeTruthy();
    if (row.kind === 'delete') expect(row.left && !row.right).toBeTruthy();
    if (row.kind === 'insert') expect(!row.left && row.right).toBeTruthy();
    if (row.kind === 'equal') {
      const opts = { ignoreCase: false, whitespace: 'exact' as const, ...options };
      expect(lineKey(row.left!.text, opts)).toBe(lineKey(row.right!.text, opts));
    }
    for (const cell of [row.left, row.right]) {
      if (cell?.segments) expect(join(cell.segments)).toBe(cell.text);
    }
  }
}

describe('splitLines', () => {
  it('returns no lines for empty text', () => {
    expect(splitLines('')).toEqual({ lines: [], finalNewline: false });
  });

  it('does not create an extra line for a trailing line break', () => {
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], finalNewline: true });
    expect(splitLines('a\nb')).toEqual({ lines: ['a', 'b'], finalNewline: false });
  });

  it('keeps blank lines', () => {
    expect(splitLines('\n').lines).toEqual(['']);
    expect(splitLines('a\n\n').lines).toEqual(['a', '']);
    expect(splitLines('\n\na').lines).toEqual(['', '', 'a']);
  });

  it('understands LF, CRLF and CR', () => {
    expect(splitLines('a\r\nb\rc\nd').lines).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('lineKey', () => {
  const line = '  Foo \t bar  ';
  it('exact keeps the line as is', () => {
    expect(lineKey(line, { ignoreCase: false, whitespace: 'exact' })).toBe(line);
  });
  it('trailing strips only the end', () => {
    expect(lineKey(line, { ignoreCase: false, whitespace: 'trailing' })).toBe('  Foo \t bar');
  });
  it('amount collapses runs and strips the end', () => {
    expect(lineKey(line, { ignoreCase: false, whitespace: 'amount' })).toBe(' Foo bar');
  });
  it('all removes every whitespace character', () => {
    expect(lineKey(line, { ignoreCase: false, whitespace: 'all' })).toBe('Foobar');
  });
  it('ignoreCase lowercases', () => {
    expect(lineKey('ÄbC', { ignoreCase: true, whitespace: 'exact' })).toBe('äbc');
  });
});

describe('diffTexts: line level', () => {
  it('reports identical texts', () => {
    const r = diffTexts('a\nb\nc', 'a\nb\nc');
    expect(r.identical).toBe(true);
    expect(r.equivalent).toBe(true);
    expect(kinds(r.rows)).toBe('eee');
    expect(r.stats).toMatchObject({ changed: 0, removed: 0, added: 0, unchanged: 3, blocks: 0 });
  });

  it('handles two empty texts', () => {
    const r = diffTexts('', '');
    expect(r.rows).toEqual([]);
    expect(r.identical).toBe(true);
  });

  it('treats everything as added when the original is empty', () => {
    const r = diffTexts('', 'a\nb');
    expect(kinds(r.rows)).toBe('ii');
    expect(r.stats).toMatchObject({ added: 2, removed: 0, changed: 0, blocks: 1 });
  });

  it('treats everything as removed when the changed text is empty', () => {
    const r = diffTexts('a\nb', '');
    expect(kinds(r.rows)).toBe('dd');
    expect(r.stats).toMatchObject({ removed: 2, blocks: 1 });
  });

  it('finds an inserted line', () => {
    const r = diffTexts('a\nc', 'a\nb\nc');
    expect(kinds(r.rows)).toBe('eie');
    expect(r.rows[1]!.right).toMatchObject({ no: 2, text: 'b' });
  });

  it('finds a deleted line', () => {
    const r = diffTexts('a\nb\nc', 'a\nc');
    expect(kinds(r.rows)).toBe('ede');
    expect(r.rows[1]!.left).toMatchObject({ no: 2, text: 'b' });
  });

  it('pairs an edited line with its counterpart', () => {
    const r = diffTexts('one\nthe quick brown fox\nthree', 'one\nthe quick red fox\nthree');
    expect(kinds(r.rows)).toBe('ece');
    const row = r.rows[1]!;
    expect(changedText(row.left!.segments)).toEqual(['brown']);
    expect(changedText(row.right!.segments)).toEqual(['red']);
  });

  it('lines up similar lines inside a larger change block', () => {
    const a = ['start', 'const alpha = 1;', 'const beta = 2;', 'end'].join('\n');
    const b = ['start', 'totally unrelated new line here', 'const alpha = 10;', 'const beta = 20;', 'end'].join('\n');
    const r = diffTexts(a, b);
    expect(kinds(r.rows)).toBe('eicce');
    expect(r.rows[2]!.left!.text).toBe('const alpha = 1;');
    expect(r.rows[2]!.right!.text).toBe('const alpha = 10;');
    expect(r.rows[3]!.left!.text).toBe('const beta = 2;');
    expect(r.rows[3]!.right!.text).toBe('const beta = 20;');
  });

  it('shows unrelated replaced lines side by side without inline marks', () => {
    const r = diffTexts('apples and pears', 'zzz 123 qqq');
    expect(kinds(r.rows)).toBe('c');
    expect(r.rows[0]!.left!.segments).toBeUndefined();
    expect(r.rows[0]!.right!.segments).toBeUndefined();
  });

  it('counts blocks of adjacent changes once', () => {
    const r = diffTexts('a\nb\nc\nd\ne', 'a\nB\nC\nd\nE');
    expect(r.stats.blocks).toBe(2);
    expect(r.stats.changed + r.stats.removed + r.stats.added).toBeGreaterThan(0);
  });

  it('treats CRLF and LF line breaks alike', () => {
    const r = diffTexts('a\r\nb\r\n', 'a\nb\n');
    expect(r.equivalent).toBe(true);
    expect(r.identical).toBe(false);
  });

  it('notes a difference in the final line break', () => {
    const r = diffTexts('a\nb\n', 'a\nb');
    expect(r.equivalent).toBe(true);
    expect(r.identical).toBe(false);
    expect(r.notes).toEqual(['Only the original text ends with a line break.']);
    expect(diffTexts('a', 'a\n').notes).toEqual(['Only the changed text ends with a line break.']);
  });

  it('sees an added blank line at the end', () => {
    const r = diffTexts('a\n', 'a\n\n');
    expect(kinds(r.rows)).toBe('ei');
    expect(r.rows[1]!.right).toMatchObject({ no: 2, text: '' });
  });

  it('keeps duplicate lines in order', () => {
    expectFaithful('x\nx\nx\ny', 'x\ny\nx\nx');
  });
});

describe('diffTexts: options', () => {
  it('ignoreCase makes case-only changes disappear', () => {
    expect(diffTexts('Hello World', 'hello world').equivalent).toBe(false);
    const r = diffTexts('Hello World', 'hello world', { ignoreCase: true });
    expect(r.equivalent).toBe(true);
    expect(r.identical).toBe(false);
    expect(r.stats.ignored).toBe(1);
    expect(r.rows[0]!.left!.text).toBe('Hello World');
    expect(r.rows[0]!.right!.text).toBe('hello world');
  });

  it('whitespace: trailing', () => {
    expect(diffTexts('a  \nb', 'a\nb\t', { whitespace: 'trailing' }).equivalent).toBe(true);
    expect(diffTexts('a b', 'a  b', { whitespace: 'trailing' }).equivalent).toBe(false);
  });

  it('whitespace: amount', () => {
    expect(diffTexts('a b\tc ', 'a   b c', { whitespace: 'amount' }).equivalent).toBe(true);
    expect(diffTexts('ab', 'a b', { whitespace: 'amount' }).equivalent).toBe(false);
    expect(diffTexts(' a', 'a', { whitespace: 'amount' }).equivalent).toBe(false);
  });

  it('whitespace: all', () => {
    expect(diffTexts('  if (a) { b }', 'if(a){b}', { whitespace: 'all' }).equivalent).toBe(true);
    expect(diffTexts('ab', 'ac', { whitespace: 'all' }).equivalent).toBe(false);
  });

  it('does not ignore blank lines, only whitespace within lines', () => {
    const r = diffTexts('a\n\nb', 'a\nb', { whitespace: 'all' });
    expect(kinds(r.rows)).toBe('ede');
  });

  it('inline: off produces no segments', () => {
    const r = diffTexts('the quick brown fox', 'the quick red fox', { inline: 'off' });
    expect(kinds(r.rows)).toBe('c');
    expect(r.rows[0]!.left!.segments).toBeUndefined();
  });

  it('inline highlighting leaves ignored whitespace unmarked', () => {
    const r = diffTexts('foo(a,b)   // old', 'foo( a, b ) // new', { whitespace: 'all' });
    expect(kinds(r.rows)).toBe('c');
    expect(changedText(r.rows[0]!.left!.segments)).toEqual(['old']);
    expect(changedText(r.rows[0]!.right!.segments)).toEqual(['new']);
  });

  it('inline highlighting leaves ignored case unmarked', () => {
    const r = diffTexts('SELECT name FROM users', 'select name from customers', { ignoreCase: true });
    expect(changedText(r.rows[0]!.left!.segments)).toEqual(['users']);
    expect(changedText(r.rows[0]!.right!.segments)).toEqual(['customers']);
  });
});

describe('diffInline', () => {
  it('marks changed words', () => {
    const d = diffInline('port: 8080', 'port: 8443')!;
    expect(changedText(d.left)).toEqual(['8080']);
    expect(changedText(d.right)).toEqual(['8443']);
    expect(join(d.left)).toBe('port: 8080');
    expect(join(d.right)).toBe('port: 8443');
  });

  it('marks changed characters in char mode', () => {
    const d = diffInline('colour', 'color', { inline: 'char' })!;
    expect(changedText(d.left)).toEqual(['u']);
    expect(changedText(d.right)).toEqual([]);
  });

  it('treats punctuation as separate tokens', () => {
    const d = diffInline('call(a, b);', 'call(a, c);')!;
    expect(changedText(d.left)).toEqual(['b']);
    expect(changedText(d.right)).toEqual(['c']);
  });

  it('bridges whitespace between adjacent changes', () => {
    const d = diffInline('the quick brown fox', 'the slow red fox')!;
    expect(changedText(d.left)).toEqual(['quick brown']);
    expect(changedText(d.right)).toEqual(['slow red']);
  });

  it('marks a pure insertion only on the right', () => {
    const d = diffInline('a c', 'a b c')!;
    expect(changedText(d.left)).toEqual([]);
    expect(changedText(d.right).join('')).toContain('b');
    expect(join(d.right)).toBe('a b c');
  });

  it('keeps emoji and combining characters whole in char mode', () => {
    const d = diffInline('I 👍🏽 this', 'I 👎🏽 this', { inline: 'char' })!;
    expect(changedText(d.left)).toEqual(['👍🏽']);
    expect(changedText(d.right)).toEqual(['👎🏽']);
  });

  it('handles non-Latin words', () => {
    const d = diffInline('größe = über', 'größe = unter')!;
    expect(changedText(d.left)).toEqual(['über']);
    expect(changedText(d.right)).toEqual(['unter']);
  });

  it('returns null when switched off', () => {
    expect(diffInline('a', 'b', { inline: 'off' })).toBeNull();
  });

  it('ignores a trailing-whitespace difference in trailing mode', () => {
    const d = diffInline('value = 1  ', 'value = 2', { whitespace: 'trailing' })!;
    expect(changedText(d.left)).toEqual(['1']);
    expect(changedText(d.right)).toEqual(['2']);
    expect(join(d.left)).toBe('value = 1  ');
  });

  it('survives lines that are far too different', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(' ');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join(' ');
    expect(diffInline(a, b)).toBeNull();
  });
});

describe('buildSections', () => {
  const rowsOf = (pattern: string): Row[] =>
    Array.from(pattern, (ch, i) =>
      ch === 'e'
        ? { kind: 'equal' as const, left: { no: i + 1, text: '' }, right: { no: i + 1, text: '' } }
        : { kind: 'delete' as const, left: { no: i + 1, text: '' } },
    );

  it('returns nothing for no rows', () => {
    expect(buildSections([])).toEqual([]);
  });

  it('folds unchanged lines away from a change', () => {
    const rows = rowsOf('e'.repeat(10) + 'd' + 'e'.repeat(10));
    expect(buildSections(rows, 3)).toEqual([
      { type: 'fold', start: 0, end: 7 },
      { type: 'rows', start: 7, end: 14 },
      { type: 'fold', start: 14, end: 21 },
    ]);
  });

  it('does not fold a gap that is too short to be worth it', () => {
    const rows = rowsOf('d' + 'e'.repeat(9) + 'd');
    // 9 unchanged lines, 3 of context on each side leaves 3 hidden: below minFold.
    expect(buildSections(rows, 3)).toEqual([{ type: 'rows', start: 0, end: 11 }]);
  });

  it('folds a gap that is long enough', () => {
    const rows = rowsOf('d' + 'e'.repeat(10) + 'd');
    expect(buildSections(rows, 3)).toEqual([
      { type: 'rows', start: 0, end: 4 },
      { type: 'fold', start: 4, end: 8 },
      { type: 'rows', start: 8, end: 12 },
    ]);
  });

  it('folds everything when nothing changed', () => {
    expect(buildSections(rowsOf('eeeeee'), 3)).toEqual([{ type: 'fold', start: 0, end: 6 }]);
  });

  it('covers every row exactly once', () => {
    const rows = rowsOf('eeeeedeeeeeeeeeeeeddeeeeeeeeeeeeeeeeeeed');
    const sections = buildSections(rows, 2);
    let at = 0;
    for (const s of sections) {
      expect(s.start).toBe(at);
      expect(s.end).toBeGreaterThan(s.start);
      at = s.end;
    }
    expect(at).toBe(rows.length);
    for (const s of sections) {
      if (s.type === 'fold') {
        for (let i = s.start; i < s.end; i++) expect(rows[i]!.kind).toBe('equal');
      }
    }
  });
});

describe('diffTexts: regressions found in review', () => {
  it('does not treat joined words as changed when all whitespace is ignored', () => {
    expect(diffTexts('hello world', 'helloworld', { whitespace: 'all' }).equivalent).toBe(true);
    const r = diffTexts('hello world foo bar 1', 'helloworld foo bar 2', { whitespace: 'all' });
    expect(kinds(r.rows)).toBe('c');
    expect(changedText(r.rows[0]!.left!.segments)).toEqual(['1']);
    expect(changedText(r.rows[0]!.right!.segments)).toEqual(['2']);
  });

  it('still marks whole replaced words when all whitespace is ignored', () => {
    const r = diffTexts('Run the unit tests', 'Run the unit and integration tests', { whitespace: 'all' });
    expect(changedText(r.rows[0]!.left!.segments)).toEqual([]);
    expect(changedText(r.rows[0]!.right!.segments).join('').trim()).toBe('and integration');
  });

  it('ignores case consistently for a Greek sigma at the end of a word', () => {
    for (const inline of ['word', 'char'] as const) {
      const r = diffTexts('sumΣ = 100 units', 'sumσ = 100 units', { ignoreCase: true, inline });
      expect(r.equivalent).toBe(true);
      expect(r.stats.ignored).toBe(1);
    }
    expect(diffTexts("ΑΣ'Β = 100", "ας'β = 100", { ignoreCase: true }).equivalent).toBe(true);
  });

  it('prefers pairing an edited line over pairing two blank lines', () => {
    const r = diffTexts('alpha\n\nresult = compute(1)\nomega', 'alpha\nresult = compute(2)\n  \nomega');
    expect(kinds(r.rows)).toBe('edcie');
    expect(changedText(r.rows[2]!.left!.segments)).toEqual(['1']);
    expect(changedText(r.rows[2]!.right!.segments)).toEqual(['2']);
  });

  it('keeps lines aligned in a change block too big for the exact alignment', () => {
    // 500 x 501 lines is just over the cell limit of the exact alignment.
    const a = Array.from({ length: 500 }, (_, i) => `${i + 1},item-${i + 1},${(i * 37) % 1000}`);
    const b = ['0,item-new,5,active', ...a.map((line) => `${line},active`)];
    const r = diffTexts(a.join('\n'), b.join('\n'));
    expect(r.stats).toMatchObject({ changed: 500, added: 1, removed: 0 });
    expect(r.rows[0]).toMatchObject({ kind: 'insert', right: { text: '0,item-new,5,active' } });
    for (const row of r.rows.slice(1)) {
      expect(row.right!.text).toBe(`${row.left!.text},active`);
      expect(changedText(row.right!.segments).join('')).toBe(',active');
    }
    expect(r.notes).toEqual([]);
  });

  it('aligns a text in which every line was edited and some were added or removed', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `entry ${i}: value=${i * 3} status=open`);
    const b = a.map((line) => line.replace('status=open', 'status=closed'));
    b.splice(15_000, 1); // remove "entry 15000"
    b.splice(5_000, 0, 'an extra line in the middle'); // add before "entry 5000"
    const started = performance.now();
    const r = diffTexts(a.join('\n'), b.join('\n'));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(r.approximate).toBe(false);
    expect(r.stats).toMatchObject({ changed: 19_999, added: 1, removed: 1, unchanged: 0 });
    for (const row of r.rows) {
      if (row.kind === 'change') expect(row.right!.text).toBe(row.left!.text.replace('open', 'closed'));
      if (row.kind === 'delete') expect(row.left!.text).toMatch(/^entry 15000:/);
      if (row.kind === 'insert') expect(row.right!.text).toBe('an extra line in the middle');
    }
  });

  it('finds the unchanged lines of a big text with thousands of scattered edits', () => {
    const a = Array.from({ length: 40_000 }, (_, i) => `row ${i} of the original document`);
    const b: string[] = [];
    let edited = 0;
    for (let i = 0; i < a.length; i++) {
      if (i % 4 === 1) {
        b.push(`${a[i]} (edited)`);
        edited++;
      } else {
        b.push(a[i]!);
      }
    }
    const started = performance.now();
    const r = diffTexts(a.join('\n'), b.join('\n'));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(r.approximate).toBe(false);
    expect(r.stats).toMatchObject({ changed: edited, unchanged: a.length - edited, added: 0, removed: 0 });
  });

  it('stops highlighting inside lines once that takes too long, and says so', () => {
    let seed = 1;
    const next = (): number => (seed = (seed * 48271) % 2147483647) % 100;
    const table = (rows: number, cols: number): string =>
      Array.from({ length: rows }, () => Array.from({ length: cols }, next).join(',')).join('\n');
    const a = table(200, 1000);
    const b = table(200, 1000);
    const started = performance.now();
    const r = diffTexts(a, b);
    expect(performance.now() - started).toBeLessThan(6000);
    // The rows are unrelated random numbers, so how they pair up is arbitrary.
    expect(r.stats.changed + r.stats.removed).toBe(200);
    expect(r.stats.changed + r.stats.added).toBe(200);
    expect(r.notes.some((note) => note.includes('without highlighting'))).toBe(true);
    expectFaithful(a, b);
  }, 30_000);
});

describe('diffTexts: randomised faithfulness', () => {
  // Small deterministic PRNG so failures are reproducible.
  function mulberry32(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  const vocabulary = ['alpha', 'Beta', 'gamma', '  delta', 'eps ilon', 'ZETA ', '', 'x = 1;', 'x = 2;', '\tx  =  1;', 'é', '👍'];
  const variants: Array<Partial<DiffOptions>> = [
    {},
    { inline: 'char' },
    { inline: 'off' },
    { ignoreCase: true },
    { whitespace: 'trailing' },
    { whitespace: 'amount', inline: 'char' },
    { whitespace: 'all', ignoreCase: true },
  ];

  it('always reproduces both inputs', () => {
    const random = mulberry32(20261111);
    const pick = (): string => vocabulary[Math.floor(random() * vocabulary.length)]!;
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: Math.floor(random() * 14) }, pick);
      const edited: string[] = [];
      for (const line of base) {
        const p = random();
        if (p < 0.15) continue; // delete
        if (p < 0.3) edited.push(pick()); // insert before
        edited.push(p > 0.85 ? `${line} ${pick()}` : line); // maybe modify
      }
      const a = base.join('\n') + (random() < 0.5 ? '\n' : '');
      const b = edited.join('\n') + (random() < 0.5 ? '\n' : '');
      expectFaithful(a, b, variants[round % variants.length]);
    }
  });

  it('handles a large, mostly unchanged text quickly', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line number ${i} with some content`);
    const edited = lines.slice();
    edited[5000] = 'line number 5000 with different content';
    edited.splice(12_000, 1);
    edited.splice(15_000, 0, 'a brand new line');
    const started = performance.now();
    const r = diffTexts(lines.join('\n'), edited.join('\n'));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(r.stats).toMatchObject({ changed: 1, removed: 1, added: 1, blocks: 3 });
    expect(r.approximate).toBe(false);
  });
});
