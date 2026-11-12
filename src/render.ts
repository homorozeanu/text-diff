/**
 * Renders a DiffResult as a table, either side by side or unified.
 *
 * All user text reaches the page through text nodes, never through HTML
 * strings, so pasted markup is displayed literally and cannot execute.
 */
import { buildSections, type DiffResult, type LineCell, type Row, type Section } from './diff-engine';

export type ViewMode = 'split' | 'unified';

export interface RenderOptions {
  view: ViewMode;
  /** Fold long stretches of unchanged lines. */
  collapse: boolean;
  /** Draw markers for spaces, tabs and non-breaking spaces. */
  showWhitespace: boolean;
  /** Unchanged lines kept visible around each change when collapsing. */
  context: number;
}

export interface DiffView {
  /** Renders the next batch of a very long diff. False if nothing was left. */
  renderMore(): boolean;
}

/** Rows rendered per batch; the rest waits behind a "show more" button. */
const BATCH_ROWS = 3000;
/** Lines revealed by the partial expand buttons of a fold. */
const FOLD_STEP = 20;

type CellTone = 'ctx' | 'del' | 'ins';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Moves keyboard focus to a row that replaced the button just activated, so
 * the next Tab continues from there instead of from the top of the page.
 */
function focusRow(row: Element | null | undefined): void {
  if (!(row instanceof HTMLElement)) return;
  const button = row.querySelector('button');
  if (button) {
    button.focus({ preventScroll: true });
    return;
  }
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
}

class Renderer implements DiffView {
  private readonly queue: Section[];
  private readonly columns: number;

  constructor(
    private readonly rows: Row[],
    private readonly opts: RenderOptions,
    private readonly tbody: HTMLTableSectionElement,
  ) {
    this.columns = opts.view === 'split' ? 4 : 3;
    this.queue = opts.collapse
      ? buildSections(rows, opts.context)
      : [{ type: 'rows', start: 0, end: rows.length }];
  }

  renderMore(): boolean {
    this.tbody.querySelector('tr.more')?.remove();
    if (this.queue.length === 0) return false;

    const fragment = document.createDocumentFragment();
    let budget = BATCH_ROWS;
    while (this.queue.length > 0 && budget > 0) {
      const section = this.queue[0]!;
      if (section.type === 'fold') {
        fragment.append(this.foldRow(section.start, section.end));
        this.queue.shift();
        budget--;
        continue;
      }
      let end = Math.min(section.end, section.start + budget);
      // Avoid cutting a block of changes in half (within reason).
      while (
        end < section.end &&
        this.rows[end]!.kind !== 'equal' &&
        this.rows[end - 1]!.kind !== 'equal' &&
        end - section.start < BATCH_ROWS * 2
      ) {
        end++;
      }
      fragment.append(this.rowsFragment(section.start, end));
      budget -= end - section.start;
      if (end >= section.end) this.queue.shift();
      else this.queue[0] = { type: 'rows', start: end, end: section.end };
    }
    if (this.queue.length > 0) fragment.append(this.moreRow());
    this.tbody.append(fragment);
    return true;
  }

  private isBlockStart(index: number): boolean {
    return this.rows[index]!.kind !== 'equal' && (index === 0 || this.rows[index - 1]!.kind === 'equal');
  }

  private rowsFragment(start: number, end: number): DocumentFragment {
    const fragment = document.createDocumentFragment();
    if (this.opts.view === 'split') {
      for (let i = start; i < end; i++) fragment.append(this.splitRow(i));
      return fragment;
    }

    let i = start;
    while (i < end) {
      const row = this.rows[i]!;
      if (row.kind === 'equal') {
        fragment.append(this.unifiedRow('equal', row.left!.no, row.right!.no, row.right!, 'ctx'));
        i++;
        continue;
      }
      // Unified convention: all removed lines of a block, then all added ones.
      let j = i;
      while (j < end && this.rows[j]!.kind !== 'equal') j++;
      const trs: HTMLTableRowElement[] = [];
      for (let k = i; k < j; k++) {
        const left = this.rows[k]!.left;
        if (left) trs.push(this.unifiedRow('delete', left.no, undefined, left, 'del'));
      }
      for (let k = i; k < j; k++) {
        const right = this.rows[k]!.right;
        if (right) trs.push(this.unifiedRow('insert', undefined, right.no, right, 'ins'));
      }
      if (this.isBlockStart(i) && trs[0]) trs[0].dataset.block = '';
      fragment.append(...trs);
      i = j;
    }
    return fragment;
  }

  private splitRow(index: number): HTMLTableRowElement {
    const row = this.rows[index]!;
    const tr = el('tr', `row ${row.kind}`);
    if (this.isBlockStart(index)) tr.dataset.block = '';
    const differs = row.kind !== 'equal';
    tr.append(
      this.numberCell(row.left?.no, row.left && differs ? 'del' : 'ctx'),
      this.codeCell(row.left, differs ? 'del' : 'ctx'),
      this.numberCell(row.right?.no, row.right && differs ? 'ins' : 'ctx'),
      this.codeCell(row.right, differs ? 'ins' : 'ctx'),
    );
    return tr;
  }

  private unifiedRow(
    kind: string,
    leftNo: number | undefined,
    rightNo: number | undefined,
    cell: LineCell,
    tone: CellTone,
  ): HTMLTableRowElement {
    const tr = el('tr', `row ${kind}`);
    tr.append(this.numberCell(leftNo, tone), this.numberCell(rightNo, tone), this.codeCell(cell, tone));
    return tr;
  }

  private numberCell(no: number | undefined, tone: CellTone): HTMLTableCellElement {
    const td = el('td', `no ${tone}`);
    // Shown through CSS (attr()), which keeps line numbers out of copied text.
    if (no !== undefined) td.dataset.no = String(no);
    else td.classList.add('empty');
    return td;
  }

  private codeCell(cell: LineCell | undefined, tone: CellTone): HTMLTableCellElement {
    const td = el('td', `code ${tone}`);
    if (!cell) {
      td.classList.add('empty');
      return td;
    }
    if (cell.text === '') {
      // Makes a blank line count as a line when the diff is selected and copied.
      td.append(el('br'));
      return td;
    }
    if (cell.segments) {
      for (const segment of cell.segments) {
        if (segment.changed) {
          const mark = el('span', 'hl');
          this.appendText(mark, segment.text);
          td.append(mark);
        } else {
          this.appendText(td, segment.text);
        }
      }
    } else {
      this.appendText(td, cell.text);
    }
    return td;
  }

  private appendText(parent: HTMLElement, text: string): void {
    if (text === '') return;
    if (!this.opts.showWhitespace || !/[ \t ]/.test(text)) {
      parent.append(document.createTextNode(text));
      return;
    }
    for (const part of text.split(/( +|\t| )/)) {
      if (part === '') continue;
      const first = part[0];
      if (first === ' ' || first === '\t' || first === ' ') {
        const span = el('span', first === ' ' ? 'ws ws-space' : first === '\t' ? 'ws ws-tab' : 'ws ws-nbsp');
        span.textContent = part;
        parent.append(span);
      } else {
        parent.append(document.createTextNode(part));
      }
    }
  }

  private foldRow(start: number, end: number): HTMLTableRowElement {
    const tr = el('tr', 'fold');
    const td = el('td');
    td.colSpan = this.columns;
    const bar = el('div', 'fold-bar');
    const count = end - start;

    const button = (className: string, label: string, title: string, onClick: () => void): HTMLButtonElement => {
      const btn = el('button', `fold-btn ${className}`);
      btn.type = 'button';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', onClick);
      return btn;
    };
    // Swaps this fold for a smaller one, keeping focus on the same button so
    // that pressing Enter again reveals the next step.
    const shrinkTo = (from: number, to: number, focusClass: string): void => {
      const next = this.foldRow(from, to);
      tr.replaceWith(next);
      const target =
        next.querySelector<HTMLButtonElement>(`.${focusClass}`) ?? next.querySelector<HTMLButtonElement>('.fold-all');
      target?.focus({ preventScroll: true });
    };

    // A very long fold opens one batch at a time to keep the page responsive.
    const showAll =
      count <= BATCH_ROWS
        ? button('fold-all', `Show ${plural(count, 'unchanged line')}`, 'Show all hidden lines', () => {
            const revealed = this.rowsFragment(start, end);
            const first = revealed.firstElementChild;
            tr.replaceWith(revealed);
            focusRow(first);
          })
        : button(
            'fold-all',
            `Show ${BATCH_ROWS.toLocaleString('en-US')} of ${plural(count, 'unchanged line')}`,
            `Show the next ${BATCH_ROWS.toLocaleString('en-US')} hidden lines`,
            () => {
              tr.before(this.rowsFragment(start, start + BATCH_ROWS));
              shrinkTo(start + BATCH_ROWS, end, 'fold-all');
            },
          );

    if (count > FOLD_STEP * 2) {
      const down = button('fold-down', `↓ ${FOLD_STEP}`, `Show the next ${FOLD_STEP} lines`, () => {
        tr.before(this.rowsFragment(start, start + FOLD_STEP));
        shrinkTo(start + FOLD_STEP, end, 'fold-down');
      });
      const up = button('fold-up', `↑ ${FOLD_STEP}`, `Show the previous ${FOLD_STEP} lines`, () => {
        tr.after(this.rowsFragment(end - FOLD_STEP, end));
        shrinkTo(start, end - FOLD_STEP, 'fold-up');
      });
      // The arrows alone say too little to a screen reader.
      down.setAttribute('aria-label', down.title);
      up.setAttribute('aria-label', up.title);
      bar.append(down, showAll, up);
    } else {
      bar.append(showAll);
    }
    td.append(bar);
    tr.append(td);
    return tr;
  }

  private moreRow(): HTMLTableRowElement {
    const tr = el('tr', 'more');
    const td = el('td');
    td.colSpan = this.columns;
    const remaining = this.queue.reduce((sum, s) => sum + (s.end - s.start), 0);
    const btn = el('button', 'fold-btn');
    btn.type = 'button';
    btn.textContent = `Show more (${plural(remaining, 'line')} remaining)`;
    btn.addEventListener('click', () => {
      const before = tr.previousElementSibling;
      this.renderMore();
      focusRow(before ? before.nextElementSibling : this.tbody.firstElementChild);
    });
    td.append(btn);
    tr.append(td);
    return tr;
  }
}

/** Replaces the contents of `container` with the rendered diff. */
export function renderDiff(container: HTMLElement, result: DiffResult, opts: RenderOptions): DiffView {
  container.replaceChildren();
  const table = el('table', `diff ${opts.view}`);
  if (opts.showWhitespace) table.classList.add('show-ws');

  // Width of the line-number gutters, in characters.
  const digits = String(Math.max(1, result.rows.length)).length;
  table.style.setProperty('--digits', String(Math.max(2, digits)));

  const colgroup = el('colgroup');
  const layout = opts.view === 'split' ? ['c-no', 'c-code', 'c-no', 'c-code'] : ['c-no', 'c-no', 'c-code'];
  for (const className of layout) colgroup.append(el('col', className));
  const tbody = el('tbody');
  table.append(colgroup, tbody);

  if (opts.view === 'split') {
    // Text selection in a table runs across both columns. Remembering which
    // side a drag started on lets the stylesheet exclude the other side, so
    // one version of the text can be copied on its own.
    table.addEventListener('mousedown', (event) => {
      const cell = event.target instanceof Element ? event.target.closest<HTMLTableCellElement>('td.code') : null;
      if (!cell) return;
      const left = cell.cellIndex === 1;
      table.classList.toggle('select-left', left);
      table.classList.toggle('select-right', !left);
    });
  }

  const renderer = new Renderer(result.rows, opts, tbody);
  renderer.renderMore();
  container.append(table);
  return renderer;
}
