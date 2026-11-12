import './style.css';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import {
  diffTexts,
  splitLines,
  type DiffResult,
  type InlineMode,
  type WhitespaceMode,
} from './diff-engine';
import { renderDiff, type DiffView, type ViewMode } from './render';
import { SAMPLE_CHANGED, SAMPLE_ORIGINAL } from './sample';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Settings {
  view: ViewMode;
  inline: InlineMode;
  whitespace: WhitespaceMode;
  ignoreCase: boolean;
  collapse: boolean;
  showWhitespace: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  view: 'split',
  inline: 'word',
  whitespace: 'exact',
  ignoreCase: false,
  collapse: true,
  showWhitespace: false,
};

const SETTINGS_KEY = 'text-diff:settings';
const THEME_KEY = 'text-diff:theme';
const TEXT_KEY_A = 'text-diff:text-a';
const TEXT_KEY_B = 'text-diff:text-b';

/** Unchanged lines kept around each change when collapsing. */
const CONTEXT_LINES = 3;
/** Texts above this combined size are not kept across a page reload. */
const MAX_STORED_CHARS = 2_000_000;
/** Dropped files above this size are refused. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PATCH_TIMEOUT_MS = 5000;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function loadSettings(): Settings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
      return {
        view: oneOf(r.view, ['split', 'unified'] as const, DEFAULT_SETTINGS.view),
        inline: oneOf(r.inline, ['word', 'char', 'off'] as const, DEFAULT_SETTINGS.inline),
        whitespace: oneOf(r.whitespace, ['exact', 'trailing', 'amount', 'all'] as const, DEFAULT_SETTINGS.whitespace),
        ignoreCase: bool(r.ignoreCase, DEFAULT_SETTINGS.ignoreCase),
        collapse: bool(r.collapse, DEFAULT_SETTINGS.collapse),
        showWhitespace: bool(r.showWhitespace, DEFAULT_SETTINGS.showWhitespace),
      };
    }
  } catch {
    // Storage unavailable or corrupt: fall through to the defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not being able to remember settings is harmless.
  }
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const textA = byId<HTMLTextAreaElement>('text-a');
const textB = byId<HTMLTextAreaElement>('text-b');
const metaA = byId('meta-a');
const metaB = byId('meta-b');
const viewRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="view"]'));
const optInline = byId<HTMLSelectElement>('opt-inline');
const optWhitespace = byId<HTMLSelectElement>('opt-whitespace');
const optCase = byId<HTMLInputElement>('opt-case');
const optCollapse = byId<HTMLInputElement>('opt-collapse');
const optShowWs = byId<HTMLInputElement>('opt-show-ws');
const summary = byId('summary');
const stats = byId('stats');
const navPos = byId('nav-pos');
const btnPrev = byId<HTMLButtonElement>('btn-prev');
const btnNext = byId<HTMLButtonElement>('btn-next');
const btnCopy = byId<HTMLButtonElement>('btn-copy');
const notes = byId('notes');
const output = byId('output');
const empty = byId('empty');
const toast = byId('toast');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const settings = loadSettings();
let result: DiffResult | null = null;
let view: DiffView | null = null;
/** Index of the change block last jumped to, or -1. */
let navIndex = -1;
let navCurrent: Element | null = null;
let timer: number | undefined;
let toastTimer: number | undefined;
/** What the summary chips currently say, to avoid re-announcing them. */
let statsSignature = '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const numberFormat = new Intl.NumberFormat('en-US');

function plural(n: number, word: string): string {
  return `${numberFormat.format(n)} ${word}${n === 1 ? '' : 's'}`;
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2600);
}

function chip(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `chip ${className}`;
  span.textContent = text;
  return span;
}

function saveTexts(): void {
  try {
    if (textA.value.length + textB.value.length > MAX_STORED_CHARS) {
      sessionStorage.removeItem(TEXT_KEY_A);
      sessionStorage.removeItem(TEXT_KEY_B);
      return;
    }
    sessionStorage.setItem(TEXT_KEY_A, textA.value);
    sessionStorage.setItem(TEXT_KEY_B, textB.value);
  } catch {
    // Texts simply will not survive a reload.
  }
}

function restoreTexts(): void {
  try {
    textA.value = sessionStorage.getItem(TEXT_KEY_A) ?? '';
    textB.value = sessionStorage.getItem(TEXT_KEY_B) ?? '';
  } catch {
    // Start empty.
  }
}

function updateMeta(): void {
  const describe = (text: string): string =>
    text === '' ? '' : `${plural(splitLines(text).lines.length, 'line')} · ${plural(text.length, 'character')}`;
  metaA.textContent = describe(textA.value);
  metaB.textContent = describe(textB.value);
}

// ---------------------------------------------------------------------------
// Compare and render
// ---------------------------------------------------------------------------

/** Recomputes the diff from the two text boxes and shows it. */
function compare(): void {
  window.clearTimeout(timer);
  timer = undefined;
  const a = textA.value;
  const b = textB.value;
  updateMeta();
  saveTexts();

  if (a === '' && b === '') {
    result = null;
    view = null;
    output.replaceChildren();
    output.hidden = true;
    stats.replaceChildren();
    statsSignature = '';
    summary.hidden = true;
    notes.hidden = true;
    empty.hidden = false;
    return;
  }

  result = diffTexts(a, b, {
    ignoreCase: settings.ignoreCase,
    whitespace: settings.whitespace,
    inline: settings.inline,
  });
  render();
}

/** Draws the current result with the current display settings. */
function render(): void {
  if (!result) return;
  empty.hidden = true;
  output.hidden = false;
  view = renderDiff(output, result, {
    view: settings.view,
    collapse: settings.collapse,
    showWhitespace: settings.showWhitespace,
    context: CONTEXT_LINES,
  });
  navIndex = -1;
  navCurrent = null;
  renderSummary(result);
}

function renderSummary(r: DiffResult): void {
  summary.hidden = false;
  const s = r.stats;
  const chips: HTMLSpanElement[] = [];

  if (r.identical) {
    chips.push(chip('same', 'The two texts are identical'));
  } else if (r.equivalent) {
    chips.push(chip('same', 'No differing lines'));
  } else {
    if (s.changed > 0) chips.push(chip('chg', `${plural(s.changed, 'line')} changed`));
    if (s.removed > 0) chips.push(chip('del', `${plural(s.removed, 'line')} removed`));
    if (s.added > 0) chips.push(chip('ins', `${plural(s.added, 'line')} added`));
  }
  if (s.ignored > 0) {
    const verb = s.ignored === 1 ? 'differs' : 'differ';
    chips.push(chip('muted', `${plural(s.ignored, 'line')} ${verb} only in ignored case or whitespace`));
  }
  // The chips sit in a live region. Replacing them with identical ones would
  // make a screen reader repeat the summary after every pause in typing.
  const signature = chips.map((c) => `${c.className}:${c.textContent}`).join('|');
  if (signature !== statsSignature) {
    stats.replaceChildren(...chips);
    statsSignature = signature;
  }

  const hasChanges = s.blocks > 0;
  btnPrev.disabled = !hasChanges;
  btnNext.disabled = !hasChanges;
  btnCopy.disabled = r.identical;
  updateNavPosition();

  notes.replaceChildren();
  for (const note of r.notes) {
    const li = document.createElement('li');
    li.textContent = note;
    notes.append(li);
  }
  notes.hidden = r.notes.length === 0;
}

function updateNavPosition(): void {
  const total = result?.stats.blocks ?? 0;
  if (total === 0) navPos.textContent = '';
  else if (navIndex < 0) navPos.textContent = plural(total, 'change');
  else navPos.textContent = `Change ${numberFormat.format(navIndex + 1)} of ${numberFormat.format(total)}`;
}

/** Schedules a comparison shortly after the last edit. */
function schedule(): void {
  window.clearTimeout(timer);
  const size = textA.value.length + textB.value.length;
  timer = window.setTimeout(compare, size > 300_000 ? 500 : 120);
}

// ---------------------------------------------------------------------------
// Navigation between changes
// ---------------------------------------------------------------------------

function changeBlocks(): HTMLElement[] {
  return Array.from(output.querySelectorAll<HTMLElement>('tr[data-block]'));
}

function goToChange(delta: 1 | -1): void {
  if (!view || !result || result.stats.blocks === 0) return;
  // A long diff is drawn in batches, so the change wanted may not be on the
  // page yet: draw more until it is.
  let blocks = changeBlocks();
  let next = navIndex + delta;
  if (next < 0) {
    while (view.renderMore()) {
      // Wrapping backwards needs the real last change, so draw everything.
    }
    blocks = changeBlocks();
    next = blocks.length - 1;
  } else {
    while (next >= blocks.length && view.renderMore()) blocks = changeBlocks();
    if (next >= blocks.length) next = 0;
  }
  if (blocks.length === 0) return;

  navCurrent?.classList.remove('nav-current');
  navIndex = next;
  navCurrent = blocks[next]!;
  navCurrent.classList.add('nav-current');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  navCurrent.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  updateNavPosition();
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to the legacy path below.
  }
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.append(helper);
  helper.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  helper.remove();
  return ok;
}

async function copyPatch(): Promise<void> {
  const patch = createTwoFilesPatch('original', 'changed', textA.value, textB.value, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: PATCH_TIMEOUT_MS,
    headerOptions: FILE_HEADERS_ONLY,
  });
  if (patch === undefined) {
    showToast('These texts are too large to turn into a patch.');
    return;
  }
  showToast((await copyToClipboard(patch)) ? 'Patch copied to the clipboard.' : 'Copying was blocked by the browser.');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function applySettingsToControls(): void {
  for (const radio of viewRadios) radio.checked = radio.value === settings.view;
  optInline.value = settings.inline;
  optWhitespace.value = settings.whitespace;
  optCase.checked = settings.ignoreCase;
  optCollapse.checked = settings.collapse;
  optShowWs.checked = settings.showWhitespace;
}

/** `recompute` is false for settings that only affect how rows are drawn. */
function onSettingChanged(recompute: boolean): void {
  saveSettings();
  if (recompute) compare();
  else render();
}

function setTexts(a: string, b: string): void {
  textA.value = a;
  textB.value = b;
  compare();
}

function setUpFileDrop(area: HTMLTextAreaElement): void {
  const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') ?? false;
  area.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    area.classList.add('dropping');
  });
  area.addEventListener('dragleave', () => area.classList.remove('dropping'));
  area.addEventListener('drop', (event) => {
    area.classList.remove('dropping');
    const file = event.dataTransfer?.files[0];
    if (!file) return; // Dragged text: let the browser insert it.
    event.preventDefault();
    event.stopPropagation();
    if (file.size > MAX_FILE_BYTES) {
      showToast('That file is larger than 10 MB and was not loaded.');
      return;
    }
    file.text().then(
      (text) => {
        area.value = text;
        compare();
      },
      () => showToast('That file could not be read.'),
    );
  });
}

function effectiveTheme(): 'light' | 'dark' {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function init(): void {
  applySettingsToControls();

  textA.addEventListener('input', schedule);
  textB.addEventListener('input', schedule);
  setUpFileDrop(textA);
  setUpFileDrop(textB);
  // A file dropped beside a text box must not navigate away from the page.
  for (const type of ['dragover', 'drop'] as const) {
    window.addEventListener(type, (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    });
  }

  for (const radio of viewRadios) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      settings.view = oneOf(radio.value, ['split', 'unified'] as const, 'split');
      onSettingChanged(false);
    });
  }
  optInline.addEventListener('change', () => {
    settings.inline = oneOf(optInline.value, ['word', 'char', 'off'] as const, 'word');
    onSettingChanged(true);
  });
  optWhitespace.addEventListener('change', () => {
    settings.whitespace = oneOf(optWhitespace.value, ['exact', 'trailing', 'amount', 'all'] as const, 'exact');
    onSettingChanged(true);
  });
  optCase.addEventListener('change', () => {
    settings.ignoreCase = optCase.checked;
    onSettingChanged(true);
  });
  optCollapse.addEventListener('change', () => {
    settings.collapse = optCollapse.checked;
    onSettingChanged(false);
  });
  optShowWs.addEventListener('change', () => {
    settings.showWhitespace = optShowWs.checked;
    onSettingChanged(false);
  });

  byId('btn-swap').addEventListener('click', () => setTexts(textB.value, textA.value));
  byId('btn-sample').addEventListener('click', () => setTexts(SAMPLE_ORIGINAL, SAMPLE_CHANGED));
  byId('btn-clear').addEventListener('click', () => {
    setTexts('', '');
    textA.focus();
  });
  byId('clear-a').addEventListener('click', () => {
    setTexts('', textB.value);
    textA.focus();
  });
  byId('clear-b').addEventListener('click', () => {
    setTexts(textA.value, '');
    textB.focus();
  });

  btnPrev.addEventListener('click', () => goToChange(-1));
  btnNext.addEventListener('click', () => goToChange(1));
  btnCopy.addEventListener('click', () => void copyPatch());
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'F7' || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    goToChange(event.shiftKey ? -1 : 1);
  });

  byId('theme-toggle').addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // The theme then lasts until the page is closed.
    }
  });

  restoreTexts();
  compare();
}

init();
