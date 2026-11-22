// mend — apply AI-written edits in four formats to a tree of text files.
// Written fresh from SPEC.md (kit/starter/SPEC.md). Node 22, standard library only.
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

type Eol = '\r\n' | '\n';

// A text file: its line-break style, its lines, and whether it ends with a break.
interface Doc {
  eol: Eol;
  lines: string[];
  finalBreak: boolean;
}

type Tree = Map<string, Doc>;

class ParseFail extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

class EditFail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// One parsed edit: the paths it names (checked for safety first) and the
// operation, which mutates the working tree or throws EditFail, and reports
// a move as [oldPath, newPath] when it moves a file.
interface Edit {
  paths: string[];
  apply: (tree: Tree) => [string, string] | null;
}

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// A patch's lines: split at \n, one trailing \r removed, no empty piece
// after a final \n.
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function parseDoc(text: string): Doc {
  if (text === '') return { eol: '\n', lines: [], finalBreak: false };
  let eol: Eol = '\n';
  const firstLf = text.indexOf('\n');
  if (firstLf > 0 && text[firstLf - 1] === '\r') eol = '\r\n';
  const parts = text.split(eol);
  let finalBreak = false;
  if (text.endsWith(eol)) {
    finalBreak = true;
    parts.pop();
  }
  return { eol, lines: parts, finalBreak };
}

function serializeDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.finalBreak ? doc.eol : '');
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Line comparison at a matching tier: 0 exact, 1 trailing ws ignored,
// 2 leading and trailing ws ignored.
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimWs(s);
}

function tierList(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function findOccurrences(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j], tier) !== normLine(pat[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier at which the pattern occurs at least once (at or after `from`).
function firstTierOcc(
  lines: string[],
  pat: string[],
  strict: boolean,
  from = 0,
): { tier: number; occ: number[] } | null {
  for (const t of tierList(strict)) {
    const occ = findOccurrences(lines, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// A line of the replacement: text plus, for a context line, its index into O.
interface NewLine {
  text: string;
  ctx: number | null;
}

// Build the replacement lines: context lines are written as the file's own
// matched lines; at tier 2 other lines are re-indented from O's first-line
// indent to the file's first matched line's indent.
function buildNewLines(
  doc: Doc,
  at: number,
  oldLines: string[],
  news: NewLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  const reindent = oldLines.length > 0 && tier === 2;
  const fLead = reindent && at < doc.lines.length ? leadingWs(doc.lines[at]) : '';
  const pLead = reindent ? leadingWs(oldLines[0]) : '';
  for (const nl of news) {
    if (nl.ctx !== null) {
      out.push(doc.lines[at + nl.ctx]);
      continue;
    }
    let t = nl.text;
    if (reindent && t !== '' && t.trim() !== '' && t.startsWith(pLead)) {
      t = fLead + t.slice(pLead.length);
    }
    out.push(t);
  }
  return out;
}

function readTree(dir: string): Tree {
  const out: Tree = new Map();
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      const r = rel === '' ? name : `${rel}/${name}`;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) out.set(r, parseDoc(readFileSync(p, 'utf8')));
    }
  };
  walk(dir, '');
  return out;
}

function cloneTree(t: Tree): Tree {
  const c: Tree = new Map();
  for (const [k, v] of t) c.set(k, { eol: v.eol, lines: [...v.lines], finalBreak: v.finalBreak });
  return c;
}

// A body line of a unified hunk or a V4A chunk: ' ' context, '-' old,
// '+' new, '\' a "\ No newline at end of file" marker.
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

// Split a body into the old lines O and the new lines N (context lines carry
// their index into O so they can be written as the file's own lines).
function bodyON(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      n.push({ text: b.text, ctx: o.length });
      o.push(b.text);
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

// True when a '\' line follows the body's last context or '+' line.
function bodyNoBreak(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k];
    if (b.kind === ' ' || b.kind === '+') {
      return k + 1 < body.length && body[k + 1].kind === '\\';
    }
  }
  return false;
}

// ---- Format detection (SPEC section 4) ----

function detectFormat(lines: string[]): string | null {
  let first: string | null = null;
  for (const l of lines) {
    if (l.trim() !== '') {
      first = l;
      break;
    }
  }
  if (first !== null) {
    if (first.trim() === '*** Begin Patch') return 'v4a';
    const c = first.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (trimEndWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---- Unified diffs (SPEC section 6) ----

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  create: boolean;
  remove: boolean;
  hunks: UHunk[];
  seenDash: boolean;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
}

// Path from a ---/+++ header line: text after the four characters, up to the
// first tab, surrounding spaces removed, one leading a/ or b/ removed.
function diffPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab !== -1) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const startSection = (gitOld: string | null, gitNew: string | null): USection => {
    const s: USection = {
      create: false,
      remove: false,
      hunks: [],
      seenDash: false,
      dashOld: null,
      dashNew: null,
      renameFrom: null,
      renameTo: null,
      gitOld,
      gitNew,
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/.exec(line);
      if (m === null) throw new ParseFail(i + 1);
      cur = startSection(m[1], m[2]);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFail(i + 1);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new ParseFail(i + 1);
      const hunk: UHunk = { a: Number(m[1]), body: [] };
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ kind: ' ', text: '' });
          j++;
          continue;
        }
        const c = bl[0];
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          hunk.body.push({ kind: c as BodyLine['kind'], text: bl.slice(1) });
          j++;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1];
        if (lastB.kind === ' ' && lastB.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      inHeader = false;
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.seenDash) {
        cur.seenDash = true;
        cur.dashOld = diffPath(line);
        cur.dashNew = diffPath(lines[i + 1]);
        i += 2;
        continue;
      }
      cur = startSection(null, null);
      inHeader = true;
      cur.seenDash = true;
      cur.dashOld = diffPath(line);
      cur.dashNew = diffPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new ParseFail(i + 2);
      if (line.startsWith('+++ ')) {
        cur.dashNew = diffPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new ParseFail(1);
  return sections.map((s) => unifiedEdit(s, strict));
}

// Apply one hunk to a doc; d is the running line-count drift of this section.
function applyHunk(doc: Doc, h: UHunk, d: number, strict: boolean, path: string): Doc {
  const { o, n } = bodyON(h.body);
  const noBreak = bodyNoBreak(h.body);
  if (o.length > 0) {
    const found = firstTierOcc(doc.lines, o, strict);
    if (found === null) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0];
    for (const pos of found.occ) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const built = buildNewLines(doc, best, o, n, found.tier);
    const lines = [...doc.lines.slice(0, best), ...built, ...doc.lines.slice(best + o.length)];
    const touchesEnd = best + o.length === doc.lines.length;
    return { eol: doc.eol, lines, finalBreak: touchesEnd ? !noBreak : doc.finalBreak };
  }
  const insertAt = Math.max(0, Math.min(h.a + d, doc.lines.length));
  const built = n.map((x) => x.text);
  const lines = [...doc.lines.slice(0, insertAt), ...built, ...doc.lines.slice(insertAt)];
  const atEnd = insertAt === doc.lines.length;
  return { eol: doc.eol, lines, finalBreak: atEnd ? !noBreak : doc.finalBreak };
}

function applyHunks(doc: Doc, hunks: UHunk[], strict: boolean, path: string): Doc {
  let curDoc = doc;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = bodyON(h.body);
    curDoc = applyHunk(curDoc, h, d, strict, path);
    d += n.length - o.length;
  }
  return curDoc;
}

// True when a '\' line follows the last '+' line of the section's hunks.
function createNoBreak(s: USection): boolean {
  for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
    const body = s.hunks[hi].body;
    for (let bi = body.length - 1; bi >= 0; bi--) {
      if (body[bi].kind === '+') {
        return bi + 1 < body.length && body[bi + 1].kind === '\\';
      }
    }
  }
  return false;
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldRaw = s.dashOld ?? s.renameFrom ?? s.gitOld;
  const newRaw = s.dashNew ?? s.renameTo ?? s.gitNew;
  const oldIsNull = oldRaw === '/dev/null';
  const newIsNull = newRaw === '/dev/null';
  const oldP = oldIsNull ? null : oldRaw;
  const newP = newIsNull ? null : newRaw;
  if (s.create || oldIsNull) {
    const p = newP ?? '';
    return {
      paths: [p],
      apply: (tree) => {
        if (tree.has(p)) throw new EditFail('exists', p);
        const plus: string[] = [];
        for (const h of s.hunks) {
          for (const b of h.body) if (b.kind === '+') plus.push(b.text);
        }
        tree.set(p, { eol: '\n', lines: plus, finalBreak: plus.length > 0 && !createNoBreak(s) });
        return null;
      },
    };
  }
  if (s.remove || newIsNull) {
    const p = oldP ?? '';
    return {
      paths: [p],
      apply: (tree) => {
        if (!tree.has(p)) throw new EditFail('missing', p);
        tree.delete(p);
        return null;
      },
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return {
      paths: [oldP, newP],
      apply: (tree) => {
        if (!tree.has(oldP)) throw new EditFail('missing', oldP);
        if (tree.has(newP)) throw new EditFail('exists', newP);
        const doc = applyHunks(tree.get(oldP) as Doc, s.hunks, strict, oldP);
        tree.delete(oldP);
        tree.set(newP, doc);
        return [oldP, newP];
      },
    };
  }
  const p = oldP ?? newP ?? '';
  return {
    paths: [p],
    apply: (tree) => {
      if (!tree.has(p)) throw new EditFail('missing', p);
      tree.set(p, applyHunks(tree.get(p) as Doc, s.hunks, strict, p));
      return null;
    },
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    let eq = -1;
    while (j < lines.length) {
      const t = trimEndWs(lines[j]);
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      j++;
    }
    if (eq === -1) throw new ParseFail(searchLine);
    let rep = -1;
    j = eq + 1;
    while (j < lines.length) {
      if (trimEndWs(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      j++;
    }
    if (rep === -1) throw new ParseFail(searchLine);
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k--) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1].path;
      else throw new ParseFail(searchLine);
    }
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseFail(1);
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return {
    paths: [b.path],
    apply: (tree) => {
      if (b.oldLines.length === 0) {
        if (tree.has(b.path)) throw new EditFail('exists', b.path);
        tree.set(b.path, { eol: '\n', lines: [...b.newLines], finalBreak: b.newLines.length > 0 });
        return null;
      }
      const doc = tree.get(b.path);
      if (doc === undefined) throw new EditFail('missing', b.path);
      const found = firstTierOcc(doc.lines, b.oldLines, strict);
      if (found === null) throw new EditFail('no-match', b.path);
      if (found.occ.length > 1) throw new EditFail('ambiguous', b.path);
      const at = found.occ[0];
      const news: NewLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
      const built = buildNewLines(doc, at, b.oldLines, news, found.tier);
      const lines = [...doc.lines.slice(0, at), ...built, ...doc.lines.slice(at + b.oldLines.length)];
      tree.set(b.path, { eol: doc.eol, lines, finalBreak: doc.finalBreak });
      return null;
    },
  };
}

// ---- V4A patches (SPEC section 8) ----

interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4AChunk[];
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFail(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFail(lines.length + 1);
  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  let chunk: V4AChunk | null = null;
  const closeSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') {
        cur.addLines.pop();
      }
    }
    if (cur.kind === 'update') {
      const lastChunk = cur.chunks[cur.chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.body.length > 0) {
          const lb = lastChunk.body[lastChunk.body.length - 1];
          if (lb.kind === ' ' && lb.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) throw new ParseFail(cur.lineNo);
    }
    sections.push(cur);
    cur = null;
    chunk = null;
  };
  const sectionStart = (line: string): V4ASection | null => {
    if (line.startsWith('*** Add File:')) {
      return { kind: 'add', path: line.slice('*** Add File:'.length).trim(), lineNo: 0, addLines: [], moveTo: null, chunks: [] };
    }
    if (line.startsWith('*** Delete File:')) {
      return { kind: 'delete', path: line.slice('*** Delete File:'.length).trim(), lineNo: 0, addLines: [], moveTo: null, chunks: [] };
    }
    if (line.startsWith('*** Update File:')) {
      return { kind: 'update', path: line.slice('*** Update File:'.length).trim(), lineNo: 0, addLines: [], moveTo: null, chunks: [] };
    }
    return null;
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    const started = sectionStart(line);
    if (started !== null) {
      closeSection();
      started.lineNo = i + 1;
      cur = started;
      chunk = null;
      i++;
      continue;
    }
    if (cur === null) {
      if (line.trim() === '') {
        i++;
        continue;
      }
      throw new ParseFail(i + 1);
    }
    if (cur.kind === 'add') {
      if (line === '') {
        cur.addLines.push('');
        i++;
        continue;
      }
      if (line.startsWith('+')) {
        cur.addLines.push(line.slice(1));
        i++;
        continue;
      }
      throw new ParseFail(i + 1);
    }
    if (cur.kind === 'delete') {
      if (line.trim() === '') {
        i++;
        continue;
      }
      throw new ParseFail(i + 1);
    }
    // Update File section.
    if (line === '*** End of File') {
      if (chunk === null) throw new ParseFail(i + 1);
      chunk.eof = true;
      chunk = null;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      cur.chunks.push(chunk);
      i++;
      continue;
    }
    if (line.startsWith('*** Move to:')) {
      if (cur.chunks.length === 0 && chunk === null && cur.moveTo === null) {
        cur.moveTo = line.slice('*** Move to:'.length).trim();
        i++;
        continue;
      }
      throw new ParseFail(i + 1);
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (chunk === null) {
        if (cur.chunks.length > 0) throw new ParseFail(i + 1);
        chunk = { anchor: null, body: [], eof: false };
        cur.chunks.push(chunk);
      }
      const kind: BodyLine['kind'] = line === '' ? ' ' : (line[0] as ' ' | '-' | '+');
      chunk.body.push({ kind, text: line === '' ? '' : line.slice(1) });
      i++;
      continue;
    }
    throw new ParseFail(i + 1);
  }
  closeSection();
  if (sections.length === 0) throw new ParseFail(1);
  return sections.map((s) => v4aEdit(s, strict));
}

function applyV4AChunk(
  doc: Doc,
  c: V4AChunk,
  cursor: number,
  strict: boolean,
  path: string,
): { doc: Doc; cursor: number } {
  let cur = cursor;
  if (c.anchor !== null) {
    const anchor = c.anchor;
    let foundAt = -1;
    for (const t of tierList(strict)) {
      for (let j = cur; j < doc.lines.length; j++) {
        if (normLine(doc.lines[j], t) === normLine(anchor, t)) {
          foundAt = j;
          break;
        }
      }
      if (foundAt !== -1) break;
    }
    if (foundAt === -1) throw new EditFail('no-match', path);
    cur = foundAt + 1;
  }
  const { o, n } = bodyON(c.body);
  if (o.length > 0) {
    let found: { tier: number; occ: number[] } | null = null;
    for (const t of tierList(strict)) {
      const occ = findOccurrences(doc.lines, o, t, cur).filter(
        (pos) => !c.eof || pos + o.length === doc.lines.length,
      );
      if (occ.length > 0) {
        found = { tier: t, occ };
        break;
      }
    }
    if (found === null) throw new EditFail('no-match', path);
    const at = found.occ[0];
    const built = buildNewLines(doc, at, o, n, found.tier);
    const lines = [...doc.lines.slice(0, at), ...built, ...doc.lines.slice(at + o.length)];
    return { doc: { eol: doc.eol, lines, finalBreak: doc.finalBreak }, cursor: at + built.length };
  }
  const insertAt = c.eof ? doc.lines.length : cur;
  const built = n.map((x) => x.text);
  const lines = [...doc.lines.slice(0, insertAt), ...built, ...doc.lines.slice(insertAt)];
  return { doc: { eol: doc.eol, lines, finalBreak: doc.finalBreak }, cursor: insertAt + built.length };
}

function v4aEdit(s: V4ASection, strict: boolean): Edit {
  if (s.kind === 'add') {
    return {
      paths: [s.path],
      apply: (tree) => {
        if (tree.has(s.path)) throw new EditFail('exists', s.path);
        tree.set(s.path, { eol: '\n', lines: [...s.addLines], finalBreak: s.addLines.length > 0 });
        return null;
      },
    };
  }
  if (s.kind === 'delete') {
    return {
      paths: [s.path],
      apply: (tree) => {
        if (!tree.has(s.path)) throw new EditFail('missing', s.path);
        tree.delete(s.path);
        return null;
      },
    };
  }
  const dest = s.moveTo;
  const paths = dest === null ? [s.path] : [s.path, dest];
  return {
    paths,
    apply: (tree) => {
      const doc0 = tree.get(s.path);
      if (doc0 === undefined) throw new EditFail('missing', s.path);
      if (dest !== null && tree.has(dest)) throw new EditFail('exists', dest);
      let doc = doc0;
      let cursor = 0;
      for (const c of s.chunks) {
        const r = applyV4AChunk(doc, c, cursor, strict, s.path);
        doc = r.doc;
        cursor = r.cursor;
      }
      if (dest !== null) {
        tree.delete(s.path);
        tree.set(dest, doc);
        return [s.path, dest];
      }
      tree.set(s.path, doc);
      return null;
    },
  };
}

// ---- JSON edits (SPEC section 9) ----

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + 1;
  }
}

function parseJsonEditObject(obj: unknown, lineNo: number): Edit {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ParseFail(lineNo);
  const rec = obj as Record<string, unknown>;
  if (typeof rec.path !== 'string' || typeof rec.command !== 'string') throw new ParseFail(lineNo);
  const path = rec.path as string;
  if (rec.command === 'create') {
    if (typeof rec.file_text !== 'string') throw new ParseFail(lineNo);
    const text = rec.file_text as string;
    return {
      paths: [path],
      apply: (tree) => {
        if (tree.has(path)) throw new EditFail('exists', path);
        tree.set(path, parseDoc(text));
        return null;
      },
    };
  }
  if (rec.command === 'str_replace') {
    if (typeof rec.old_str !== 'string' || rec.old_str === '') throw new ParseFail(lineNo);
    if (rec.new_str !== undefined && typeof rec.new_str !== 'string') throw new ParseFail(lineNo);
    const oldStr = rec.old_str as string;
    const newStr = (rec.new_str as string | undefined) ?? '';
    return {
      paths: [path],
      apply: (tree) => {
        const doc = tree.get(path);
        if (doc === undefined) throw new EditFail('missing', path);
        if (doc.eol === '\r\n') {
          const text = serializeDoc(doc).replace(/\r\n/g, '\n');
          const o = oldStr.replace(/\r\n/g, '\n');
          const nw = newStr.replace(/\r\n/g, '\n');
          const count = countOccurrences(text, o);
          if (count === 0) throw new EditFail('no-match', path);
          if (count > 1) throw new EditFail('ambiguous', path);
          const idx = text.indexOf(o);
          const replaced = text.slice(0, idx) + nw + text.slice(idx + o.length);
          tree.set(path, parseDoc(replaced.replace(/\n/g, '\r\n')));
        } else {
          const text = serializeDoc(doc);
          const count = countOccurrences(text, oldStr);
          if (count === 0) throw new EditFail('no-match', path);
          if (count > 1) throw new EditFail('ambiguous', path);
          const idx = text.indexOf(oldStr);
          tree.set(path, parseDoc(text.slice(0, idx) + newStr + text.slice(idx + oldStr.length)));
        }
        return null;
      },
    };
  }
  if (rec.command === 'insert') {
    if (!Number.isInteger(rec.insert_line) || typeof rec.new_str !== 'string') throw new ParseFail(lineNo);
    const at = rec.insert_line as number;
    const newStr = rec.new_str as string;
    return {
      paths: [path],
      apply: (tree) => {
        const doc = tree.get(path);
        if (doc === undefined) throw new EditFail('missing', path);
        if (at < 0 || at > doc.lines.length) throw new EditFail('no-match', path);
        const ins = splitPatch(newStr);
        const lines = [...doc.lines.slice(0, at), ...ins, ...doc.lines.slice(at)];
        tree.set(path, { eol: doc.eol, lines, finalBreak: doc.finalBreak });
        return null;
      },
    };
  }
  throw new ParseFail(lineNo);
}

function parseJson(text: string, lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseFail(1);
  const firstCh = lines[firstIdx].trimStart()[0];
  if (firstCh === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseFail(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseFail(firstIdx + 1);
    const edits = arr.map((o) => parseJsonEditObject(o, firstIdx + 1));
    if (edits.length === 0) throw new ParseFail(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new ParseFail(i + 1);
    }
    edits.push(parseJsonEditObject(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

// ---- Invocation, output and atomicity (SPEC sections 1, 2, 10) ----

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): CliArgs | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else {
        return null;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patch: positional.length === 0 ? null : positional[0] };
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(argv: string[]): { code: number; stdout: string } {
  const args = parseArgs(argv);
  if (args === null) return { code: 2, stdout: 'error: usage\n' };
  let patchText: string;
  if (args.patch === null || args.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      return { code: 2, stdout: 'error: no-patch\n' };
    }
  }
  const lines = splitPatch(patchText);
  const fmt = args.format === 'auto' ? detectFormat(lines) : args.format;
  if (fmt === null) return { code: 2, stdout: 'error: format\n' };
  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines, args.strict);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines, args.strict);
    else if (fmt === 'v4a') edits = parseV4A(lines, args.strict);
    else edits = parseJson(patchText, lines);
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, stdout: `error: parse ${e.line}\n` };
    throw e;
  }
  const before = readTree(process.cwd());
  let working = cloneTree(before);
  const failures: { code: string; path: string }[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    let unsafe: string | undefined;
    for (const p of edit.paths) {
      if (!isSafePath(p)) {
        unsafe = p;
        break;
      }
    }
    if (unsafe !== undefined) {
      failures.push({ code: 'unsafe', path: unsafe });
      continue;
    }
    const trial = cloneTree(working);
    try {
      const mv = edit.apply(trial);
      working = trial;
      if (mv !== null) moves.push(mv);
    } catch (e) {
      if (e instanceof EditFail) failures.push({ code: e.code, path: e.path });
      else throw e;
    }
  }
  if (failures.length > 0) {
    const out =
      failures.map((f) => `error: ${f.code} ${f.path}\n`).join('') +
      `failed: ${failures.length} of ${edits.length} edits\n`;
    return { code: 1, stdout: out };
  }
  const qualMoves = moves.filter(
    ([o, n]) => before.has(o) && !working.has(o) && !before.has(n) && working.has(n),
  );
  const moveOldSet = new Set(qualMoves.map(([o]) => o));
  const moveNewMap = new Map(qualMoves.map(([o, n]) => [n, o] as [string, string]));
  const rows: { key: string; line: string }[] = [];
  const allPaths = new Set<string>([...before.keys(), ...working.keys()]);
  for (const p of allPaths) {
    const b = before.get(p);
    const a = working.get(p);
    if (b === undefined && a !== undefined) {
      const oldP = moveNewMap.get(p);
      if (oldP !== undefined) rows.push({ key: p, line: `R ${oldP} -> ${p}` });
      else rows.push({ key: p, line: `A ${p}` });
    } else if (b !== undefined && a === undefined) {
      if (!moveOldSet.has(p)) rows.push({ key: p, line: `D ${p}` });
    } else if (b !== undefined && a !== undefined && serializeDoc(b) !== serializeDoc(a)) {
      rows.push({ key: p, line: `M ${p}` });
    }
  }
  rows.sort((x, y) => byteCompare(x.key, y.key));
  const n = rows.length;
  let out = rows.map((r) => `${r.line}\n`).join('');
  out += n === 1 ? 'ok: 1 file\n' : `ok: ${n} files\n`;
  if (!args.check) {
    for (const p of allPaths) {
      const b = before.get(p);
      const a = working.get(p);
      if (a === undefined && b !== undefined) {
        rmSync(join(process.cwd(), ...p.split('/')), { force: true });
      } else if (a !== undefined && (b === undefined || serializeDoc(a) !== serializeDoc(b))) {
        const f = join(process.cwd(), ...p.split('/'));
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, serializeDoc(a), 'utf8');
      }
    }
  }
  return { code: 0, stdout: out };
}

// When MAKEFUN_ENV_URL is set, hand the trial over to runner.ts; otherwise
// run the CLI.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  runTrial(envUrl).then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`trial failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
} else {
  const { code, stdout } = run(process.argv.slice(2));
  if (stdout.length > 0) writeSync(1, stdout);
  process.exit(code);
}
