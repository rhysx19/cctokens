#!/usr/bin/env node
'use strict';

/*
 * cctokens — realtime Claude Code token & cost monitor
 * ----------------------------------------------------
 * Reads the JSONL transcripts Claude Code writes under ~/.claude/projects and
 * reports token usage and cost — globally per-model, per-session, for today,
 * and as a live-updating dashboard.
 *
 * No dependencies. Node 18+.
 *
 *   cctokens                 global per-model totals + cost   (default)
 *   cctokens today           usage for today only
 *   cctokens session [N]     the N most recent sessions        (default 12)
 *   cctokens live            live dashboard, refreshes         (Ctrl-C to quit)
 *   cctokens --json          machine-readable dump of the summary
 *   cctokens --help
 *
 * Pricing note: rates are USD per 1,000,000 tokens, from Anthropic's model
 * catalog. Cache-write is 1.25x input for the 5-minute TTL and 2x input for
 * the 1-hour TTL; cache-read is 0.1x input. Costs are estimates for your own
 * bookkeeping, not a bill.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Pricing — USD per 1,000,000 tokens (base input/output).
// ---------------------------------------------------------------------------
const PRICING = {
  'claude-opus-4-8':   { input: 5.0,  output: 25.0 },
  'claude-opus-4-7':   { input: 5.0,  output: 25.0 },
  'claude-opus-4-6':   { input: 5.0,  output: 25.0 },
  'claude-opus-4-5':   { input: 5.0,  output: 25.0 },
  'claude-fable-5':    { input: 10.0, output: 50.0 },
  'claude-mythos-5':   { input: 10.0, output: 50.0 },
  'claude-sonnet-5':   { input: 3.0,  output: 15.0 },
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0 },
};
// Cache multipliers relative to base input price.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

// How often the live dashboard repaints.
const REFRESH_MS = 10_000;

// Context-window size per model, for the "context filled" gauge.
const CONTEXT = {
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};
const DEFAULT_CONTEXT = 200_000;

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ---------------------------------------------------------------------------
// ANSI helpers (auto-disabled when not a TTY or NO_COLOR is set).
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = C('2');
const bold = C('1');
const cyan = C('36');
const green = C('32');
const yellow = C('33');
const red = C('31');
const magenta = C('35');
const blue = C('34');

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------
function humanTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function money(n) {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}
function pad(s, w, right = false) {
  s = String(s);
  const len = stripAnsi(s).length;
  if (len >= w) return s;
  const fill = ' '.repeat(w - len);
  return right ? fill + s : s + fill;
}
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Cost of one usage record.
// ---------------------------------------------------------------------------
function costOf(model, u) {
  const p = PRICING[model];
  if (!p) return 0;
  const per = (tokens, rate) => (tokens * rate) / 1e6;
  let cost = 0;
  cost += per(u.input, p.input);
  cost += per(u.output, p.output);
  cost += per(u.write5m, p.input * CACHE_WRITE_5M);
  cost += per(u.write1h, p.input * CACHE_WRITE_1H);
  cost += per(u.read, p.input * CACHE_READ);
  return cost;
}

function emptyUsage() {
  return { input: 0, output: 0, write5m: 0, write1h: 0, read: 0 };
}
function addUsage(a, b) {
  a.input += b.input;
  a.output += b.output;
  a.write5m += b.write5m;
  a.write1h += b.write1h;
  a.read += b.read;
  return a;
}
function usageTotal(u) {
  return u.input + u.output + u.write5m + u.write1h + u.read;
}

// ---------------------------------------------------------------------------
// File discovery & parsing (with an mtime/size cache so re-scans are cheap).
// ---------------------------------------------------------------------------
function listJsonl(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// Derive a stable session id + project name from a transcript path.
function sessionInfo(file) {
  const rel = path.relative(PROJECTS_DIR, file);
  const parts = rel.split(path.sep);
  const project = parts[0] || 'unknown';
  const subIdx = parts.indexOf('subagents');
  const isSub = subIdx > 0;
  // Subagent transcripts attribute to the parent session directory; main
  // transcripts fall back to the filename only when a record lacks sessionId.
  const pathSession = isSub ? parts[subIdx - 1] : path.basename(file, '.jsonl');
  return { project, isSub, pathSession };
}

// Parse one transcript file into deduped usage records.
// Returns [{ model, ts, usage, ctx, session, project }]
function parseFile(file) {
  const { project, isSub, pathSession } = sessionInfo(file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const seen = new Set();
  const records = [];
  let title = null; // the session's user-set name (customTitle), if any
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    if (title === null && line.indexOf('"customTitle"') !== -1) {
      try {
        const t = JSON.parse(line).customTitle;
        if (t) title = t;
      } catch {}
    }
    if (line.indexOf('"usage"') === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg || !msg.usage) continue;
    const model = msg.model;
    if (!model || model === '<synthetic>') continue;

    // Dedup key: Claude Code writes the same message multiple times while a
    // turn streams, and re-logs whole turns into a new transcript on
    // resume/fork/compaction. Key by message id + request id so we count it
    // once — here within the file, and again globally in scanAll(). A record
    // with neither id gets key=null and is never deduped (counted as unique).
    const rawKey = (msg.id || '') + '|' + (obj.requestId || '');
    const key = rawKey === '|' ? null : rawKey;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }

    const u = msg.usage;
    const cc = u.cache_creation || {};
    const write1h = cc.ephemeral_1h_input_tokens || 0;
    const write5m = cc.ephemeral_5m_input_tokens || 0;
    const ccTotal = u.cache_creation_input_tokens || 0;
    const usage = {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      read: u.cache_read_input_tokens || 0,
      // Prefer the explicit 1h/5m split; fall back to treating the whole
      // cache-creation total as a 5m write if the breakdown is absent.
      write1h,
      write5m: cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null
        ? write5m
        : ccTotal,
    };
    // Context currently occupied = everything sent to the model this turn.
    const ctx = usage.input + usage.read + write1h + usage.write5m;
    // Main transcripts group by the in-record sessionId, so resumed/forked
    // files (which repeat the parent's sessionId) collapse into one session;
    // subagent transcripts attribute to their parent session directory.
    const session = isSub ? pathSession : obj.sessionId || pathSession;
    records.push({ key, model, ts: obj.timestamp || null, usage, ctx, session, project });
  }
  // The customTitle line may appear after some usage lines, so stamp the
  // whole file's records once at the end (order-independent).
  if (title) for (const r of records) r.title = title;
  return records;
}

const fileCache = new Map(); // path -> { sig, records }
function scanAll() {
  const files = listJsonl(PROJECTS_DIR, []).sort(); // deterministic order
  const all = [];
  const seen = new Set(); // global dedup across files (resume/fork/compaction copies)
  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const sig = st.mtimeMs + ':' + st.size;
    let entry = fileCache.get(file);
    if (!entry || entry.sig !== sig) {
      entry = { sig, records: parseFile(file), mtime: st.mtimeMs };
      fileCache.set(file, entry);
    } else {
      entry.mtime = st.mtimeMs;
    }
    for (const r of entry.records) {
      // Per-file parsing already deduped streaming copies; this skips the same
      // billed message re-logged into a different transcript.
      if (r.key) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
      }
      all.push(r);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Aggregation.
// ---------------------------------------------------------------------------
function localDay(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function aggregate(records, filterDay) {
  const byModel = new Map();
  const bySession = new Map();
  const byProject = new Map();
  const total = emptyUsage();
  let totalCost = 0;
  let count = 0;

  for (const r of records) {
    if (filterDay && localDay(r.ts) !== filterDay) continue;
    count++;
    const cost = costOf(r.model, r.usage);
    totalCost += cost;
    addUsage(total, r.usage);

    let m = byModel.get(r.model);
    if (!m) {
      m = { usage: emptyUsage(), cost: 0, count: 0 };
      byModel.set(r.model, m);
    }
    addUsage(m.usage, r.usage);
    m.cost += cost;
    m.count++;

    let s = bySession.get(r.session);
    if (!s) {
      s = { usage: emptyUsage(), cost: 0, count: 0, project: r.project, last: r.ts, model: r.model, title: r.title || null };
      bySession.set(r.session, s);
    }
    addUsage(s.usage, r.usage);
    s.cost += cost;
    s.count++;
    s.model = r.model;
    if (r.title && !s.title) s.title = r.title;
    if (r.ts && (!s.last || r.ts > s.last)) s.last = r.ts;

    let p = byProject.get(r.project);
    if (!p) {
      p = { usage: emptyUsage(), cost: 0, count: 0, sessions: new Set(), last: r.ts };
      byProject.set(r.project, p);
    }
    addUsage(p.usage, r.usage);
    p.cost += cost;
    p.count++;
    p.sessions.add(r.session);
    if (r.ts && (!p.last || r.ts > p.last)) p.last = r.ts;
  }
  return { byModel, bySession, byProject, total, totalCost, count };
}

function prettyProject(name) {
  return name.replace(/^-Users-[^-]+-/, '').replace(/-/g, '/') || name;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
function modelColor(model) {
  if (model.includes('fable') || model.includes('mythos')) return magenta;
  if (model.includes('opus')) return cyan;
  if (model.includes('sonnet')) return blue;
  if (model.includes('haiku')) return green;
  return (s) => s;
}

// A per-model usage table. cols: model, msgs, input, output, cache-w, cache-r, total, cost
function renderModelTable(byModel, total, totalCost) {
  const rows = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const W = { model: 18, msgs: 6, in: 9, out: 9, cw: 9, cr: 9, tot: 9, cost: 11 };
  const head =
    pad(dim('model'), W.model) +
    pad(dim('msgs'), W.msgs, true) +
    pad(dim('input'), W.in, true) +
    pad(dim('output'), W.out, true) +
    pad(dim('cache-w'), W.cw, true) +
    pad(dim('cache-r'), W.cr, true) +
    pad(dim('total'), W.tot, true) +
    pad(dim('cost'), W.cost, true);
  const lines = [head];
  for (const [model, m] of rows) {
    const mc = modelColor(model);
    lines.push(
      pad(mc(model), W.model) +
        pad(String(m.count), W.msgs, true) +
        pad(humanTokens(m.usage.input), W.in, true) +
        pad(humanTokens(m.usage.output), W.out, true) +
        pad(humanTokens(m.usage.write5m + m.usage.write1h), W.cw, true) +
        pad(humanTokens(m.usage.read), W.cr, true) +
        pad(humanTokens(usageTotal(m.usage)), W.tot, true) +
        pad(green(money(m.cost)), W.cost, true)
    );
  }
  // Totals row.
  const sep = dim('─'.repeat(W.model + W.msgs + W.in + W.out + W.cw + W.cr + W.tot + W.cost));
  lines.push(sep);
  lines.push(
    pad(bold('TOTAL'), W.model) +
      pad('', W.msgs, true) +
      pad(bold(humanTokens(total.input)), W.in, true) +
      pad(bold(humanTokens(total.output)), W.out, true) +
      pad(bold(humanTokens(total.write5m + total.write1h)), W.cw, true) +
      pad(bold(humanTokens(total.read)), W.cr, true) +
      pad(bold(humanTokens(usageTotal(total))), W.tot, true) +
      pad(bold(green(money(totalCost))), W.cost, true)
  );
  return lines.join('\n');
}

function timeAgo(ts) {
  if (!ts) return '—';
  const then = new Date(ts).getTime();
  if (isNaN(then)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function renderSessions(bySession, n) {
  const rows = [...bySession.entries()]
    .sort((a, b) => (b[1].last || '').localeCompare(a[1].last || ''))
    .slice(0, n);
  const W = { when: 9, name: 26, model: 13, msgs: 6, tot: 10, cost: 11 };
  const head =
    pad(dim('last'), W.when) +
    pad(dim('session'), W.name) +
    pad(dim('model'), W.model) +
    pad(dim('msgs'), W.msgs, true) +
    pad(dim('tokens'), W.tot, true) +
    pad(dim('cost'), W.cost, true);
  const lines = [head];
  for (const [, s] of rows) {
    const label = s.title || prettyProject(s.project);
    const mc = modelColor(s.model);
    lines.push(
      pad(timeAgo(s.last), W.when) +
        pad(label.length > W.name - 1 ? label.slice(0, W.name - 2) + '…' : label, W.name) +
        pad(mc(s.model.replace('claude-', '')), W.model) +
        pad(String(s.count), W.msgs, true) +
        pad(humanTokens(usageTotal(s.usage)), W.tot, true) +
        pad(green(money(s.cost)), W.cost, true)
    );
  }
  return lines.join('\n');
}

function renderProjects(byProject, totalCost) {
  const rows = [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const W = { project: 28, sess: 7, msgs: 7, tot: 10, cost: 12 };
  const head =
    pad(dim('project'), W.project) +
    pad(dim('sessions'), W.sess, true) +
    pad(dim('msgs'), W.msgs, true) +
    pad(dim('tokens'), W.tot, true) +
    pad(dim('cost'), W.cost, true);
  const lines = [head];
  for (const [name, p] of rows) {
    const proj = prettyProject(name);
    lines.push(
      pad(proj.length > W.project - 1 ? proj.slice(0, W.project - 2) + '…' : proj, W.project) +
        pad(String(p.sessions.size), W.sess, true) +
        pad(String(p.count), W.msgs, true) +
        pad(humanTokens(usageTotal(p.usage)), W.tot, true) +
        pad(green(money(p.cost)), W.cost, true)
    );
  }
  lines.push(dim('─'.repeat(W.project + W.sess + W.msgs + W.tot + W.cost)));
  lines.push(
    pad(bold('TOTAL'), W.project) +
      pad('', W.sess, true) +
      pad('', W.msgs, true) +
      pad('', W.tot, true) +
      pad(bold(green(money(totalCost))), W.cost, true)
  );
  return lines.join('\n');
}

function gauge(frac, width) {
  frac = Math.max(0, Math.min(1, frac));
  const filled = Math.round(frac * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const color = frac > 0.9 ? red : frac > 0.7 ? yellow : green;
  return color(bar);
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------
function cmdSummary(asJson) {
  const records = scanAll();
  const agg = aggregate(records);
  if (asJson) {
    const out = { total: agg.total, totalCost: agg.totalCost, messages: agg.count, models: {} };
    for (const [model, m] of agg.byModel) out.models[model] = { ...m.usage, cost: m.cost, messages: m.count };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  const range = dateRange(records);
  console.log(bold(cyan('\n  Claude Code — token usage & cost')) + dim(`   ${range}`));
  console.log();
  console.log('  ' + renderModelTable(agg.byModel, agg.total, agg.totalCost).replace(/\n/g, '\n  '));
  console.log();
  console.log(
    dim('  input') +
      ' = tokens you/context sent to the model   ' +
      dim('output') +
      ' = tokens the model generated'
  );
  console.log(dim('  cache-w') + ' = prompt-cache writes   ' + dim('cache-r') + ' = cache reads (cheap)');
  console.log();
}

function cmdToday() {
  const records = scanAll();
  const today = localDay(new Date().toISOString());
  const agg = aggregate(records, today);
  console.log(bold(cyan(`\n  Claude Code — usage for ${today}`)));
  console.log();
  if (agg.count === 0) {
    console.log(dim('  No usage recorded today yet.'));
    console.log();
    return;
  }
  console.log('  ' + renderModelTable(agg.byModel, agg.total, agg.totalCost).replace(/\n/g, '\n  '));
  console.log();
}

function cmdSessions(n) {
  const records = scanAll();
  const agg = aggregate(records);
  console.log(bold(cyan(`\n  Claude Code — ${Math.min(n, agg.bySession.size)} most recent sessions`)));
  console.log();
  console.log('  ' + renderSessions(agg.bySession, n).replace(/\n/g, '\n  '));
  console.log();
  console.log('  ' + dim(`${agg.bySession.size} sessions total · grand total `) + bold(green(money(agg.totalCost))));
  console.log();
}

// Detailed per-model breakdown for a single session.
function sessionDetail(records, sid, label) {
  const filtered = records.filter((r) => r.session === sid);
  if (filtered.length === 0) {
    console.log('\n  ' + yellow(`No usage recorded for ${label}.`) + '\n');
    return;
  }
  const agg = aggregate(filtered);
  const s = agg.bySession.get(sid);
  const name = s.title ? `"${s.title}"` : sid.slice(0, 8);
  console.log(bold(cyan(`\n  Claude Code — session ${name}`)));
  console.log('  ' + dim(`${prettyProject(s.project)} · ${sid.slice(0, 8)} · ${s.count} msgs · last ${timeAgo(s.last)}`));
  console.log();
  console.log('  ' + renderModelTable(agg.byModel, agg.total, agg.totalCost).replace(/\n/g, '\n  '));
  console.log();
}

// Resolve a query (name substring or id prefix) to a single session id.
function resolveSession(records, q) {
  const agg = aggregate(records);
  const ql = q.toLowerCase();
  const matches = [...agg.bySession.entries()].filter(
    ([sid, s]) => sid.toLowerCase().startsWith(ql) || (s.title && s.title.toLowerCase().includes(ql))
  );
  if (!matches.length) return null;
  matches.sort((a, b) => (b[1].last || '').localeCompare(a[1].last || ''));
  const [sid, s] = matches[0];
  return { sid, label: s.title ? `"${s.title}"` : sid.slice(0, 8) };
}

function cmdThis() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) {
    console.error(
      red('  CLAUDE_CODE_SESSION_ID is not set.') +
        '\n  Run this inside a Claude Code session, or use ' +
        cyan('cctokens session <name>') +
        '.'
    );
    process.exit(1);
  }
  sessionDetail(scanAll(), sid, 'this session');
}

// Resolve a session by user-set name (customTitle, substring) or id prefix.
function cmdSessionByName(q) {
  const records = scanAll();
  const agg = aggregate(records);
  const ql = q.toLowerCase();
  const matches = [...agg.bySession.entries()].filter(
    ([sid, s]) => sid.toLowerCase().startsWith(ql) || (s.title && s.title.toLowerCase().includes(ql))
  );
  if (matches.length === 0) {
    console.log('\n  ' + yellow(`No session matching "${q}".`));
    const named = [...agg.bySession.entries()]
      .filter(([, s]) => s.title)
      .sort((a, b) => (b[1].last || '').localeCompare(a[1].last || ''));
    if (named.length) {
      console.log('  ' + dim('named sessions:'));
      for (const [sid, s] of named.slice(0, 12)) {
        console.log('    ' + s.title + dim('  (' + sid.slice(0, 8) + ')'));
      }
    }
    console.log();
    return;
  }
  matches.sort((a, b) => (b[1].last || '').localeCompare(a[1].last || ''));
  if (matches.length > 1) {
    console.log(
      '\n  ' +
        dim(`${matches.length} sessions match "${q}"; showing the most recent. Others: `) +
        matches.slice(1).map(([sid, s]) => s.title || sid.slice(0, 8)).join(', ')
    );
  }
  sessionDetail(records, matches[0][0], `"${matches[0][1].title || q}"`);
}

function cmdProjects() {
  const records = scanAll();
  const agg = aggregate(records);
  console.log(bold(cyan('\n  Claude Code — usage by project')));
  console.log();
  console.log('  ' + renderProjects(agg.byProject, agg.totalCost).replace(/\n/g, '\n  '));
  console.log();
}

function dateRange(records) {
  let min = null;
  let max = null;
  for (const r of records) {
    if (!r.ts) continue;
    if (!min || r.ts < min) min = r.ts;
    if (!max || r.ts > max) max = r.ts;
  }
  if (!min) return '';
  return `${localDay(min)} → ${localDay(max)}`;
}

// Most-recently-active session, for the live "current" panel.
function activeSession(records) {
  let bestTs = null;
  let bestSession = null;
  const last = new Map(); // session -> latest record
  for (const r of records) {
    const cur = last.get(r.session);
    if (!cur || (r.ts && (!cur.ts || r.ts > cur.ts))) last.set(r.session, r);
    if (r.ts && (!bestTs || r.ts > bestTs)) {
      bestTs = r.ts;
      bestSession = r.session;
    }
  }
  return bestSession ? last.get(bestSession) : null;
}

function renderLiveFrame() {
  const records = scanAll();
  const agg = aggregate(records);
  const today = aggregate(records, localDay(new Date().toISOString()));
  const active = activeSession(records);

  const lines = [];
  lines.push('');
  lines.push(bold(cyan('  ⬢ Claude Code — live token monitor')) + dim('   ' + new Date().toLocaleTimeString()));
  lines.push('');

  // Active session panel.
  if (active) {
    const sess = agg.bySession.get(active.session);
    const ctxMax = CONTEXT[active.model] || DEFAULT_CONTEXT;
    const frac = active.ctx / ctxMax;
    const proj = active.project.replace(/^-Users-[^-]+-/, '').replace(/-/g, '/');
    lines.push('  ' + bold('current session') + dim(`  ${proj} · ${timeAgo(active.ts)}`));
    lines.push(
      '    context ' +
        gauge(frac, 30) +
        ' ' +
        bold(humanTokens(active.ctx)) +
        dim(' / ' + humanTokens(ctxMax)) +
        ' ' +
        (frac > 0.9 ? red : frac > 0.7 ? yellow : dim)((frac * 100).toFixed(0) + '%')
    );
    if (sess) {
      lines.push(
        '    ' +
          modelColor(active.model)(active.model.replace('claude-', '')) +
          dim('  ·  ') +
          humanTokens(usageTotal(sess.usage)) +
          dim(' tokens') +
          dim('  ·  ') +
          green(money(sess.cost)) +
          dim('  ·  ') +
          sess.count +
          dim(' msgs')
      );
    }
    lines.push('');
  }

  // Today panel.
  lines.push('  ' + bold('today') + dim('  ' + localDay(new Date().toISOString())));
  if (today.count === 0) {
    lines.push('    ' + dim('no usage yet today'));
  } else {
    lines.push(
      '    ' +
        humanTokens(usageTotal(today.total)) +
        dim(' tokens') +
        dim('  ·  ') +
        green(money(today.totalCost)) +
        dim('  ·  ') +
        today.count +
        dim(' msgs across ') +
        today.byModel.size +
        dim(' model(s)')
    );
    for (const [model, m] of [...today.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
      lines.push(
        '      ' +
          pad(modelColor(model)(model.replace('claude-', '')), 16) +
          pad(humanTokens(usageTotal(m.usage)), 10, true) +
          '  ' +
          green(money(m.cost))
      );
    }
  }
  lines.push('');

  // Grand total panel.
  lines.push('  ' + bold('all time') + dim(`  ${dateRange(records)}`));
  lines.push(
    '    ' +
      humanTokens(usageTotal(agg.total)) +
      dim(' tokens') +
      dim('  ·  ') +
      bold(green(money(agg.totalCost))) +
      dim('  ·  ') +
      agg.count +
      dim(' msgs across ') +
      agg.bySession.size +
      dim(' sessions')
  );
  lines.push('');
  lines.push(dim(`  refreshing every ${REFRESH_MS / 1000}s · Ctrl-C to quit`));
  return lines.join('\n');
}

// Snapshot of a single session for the scoped live view.
function sessionSnapshot(sid) {
  const records = scanAll().filter((r) => r.session === sid);
  const agg = aggregate(records);
  const s = agg.bySession.get(sid) || null;
  let latest = null;
  for (const r of records) if (r.ts && (!latest || r.ts > latest.ts)) latest = r;
  return { agg, s, latest, sid };
}

function renderLiveSessionFrame(label, snap, baseline) {
  const lines = [];
  lines.push('');
  lines.push(bold(cyan('  ⬢ Claude Code — live · ' + label)) + dim('   ' + new Date().toLocaleTimeString()));
  lines.push('');
  if (!snap.s) {
    lines.push('  ' + yellow('waiting for activity in this session…'));
    lines.push('');
    lines.push(dim(`  refreshing every ${REFRESH_MS / 1000}s · Ctrl-C to quit`));
    return lines.join('\n');
  }
  const s = snap.s;
  const latest = snap.latest;
  lines.push('  ' + dim(prettyProject(s.project) + ' · ' + snap.sid.slice(0, 8) + ' · ' + (latest ? timeAgo(latest.ts) : '—')));
  if (latest) {
    const ctxMax = CONTEXT[latest.model] || DEFAULT_CONTEXT;
    const frac = latest.ctx / ctxMax;
    lines.push(
      '    context ' +
        gauge(frac, 30) +
        ' ' +
        bold(humanTokens(latest.ctx)) +
        dim(' / ' + humanTokens(ctxMax)) +
        ' ' +
        (frac > 0.9 ? red : frac > 0.7 ? yellow : dim)((frac * 100).toFixed(0) + '%')
    );
  }
  lines.push('');
  for (const [model, m] of [...snap.agg.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    lines.push(
      '    ' +
        pad(modelColor(model)(model.replace('claude-', '')), 16) +
        pad(humanTokens(usageTotal(m.usage)), 10, true) +
        '  ' +
        green(money(m.cost))
    );
  }
  lines.push(
    '    ' +
      pad(bold('total'), 16) +
      pad(bold(humanTokens(usageTotal(snap.agg.total))), 10, true) +
      '  ' +
      bold(green(money(snap.agg.totalCost))) +
      dim('  · ' + snap.agg.count + ' msgs')
  );
  if (baseline) {
    const dT = usageTotal(snap.agg.total) - baseline.tokens;
    const dC = snap.agg.totalCost - baseline.cost;
    const dM = snap.agg.count - baseline.msgs;
    lines.push('');
    lines.push(
      '  ' +
        dim('since watching  ') +
        (dT > 0 ? green : dim)('+' + humanTokens(dT) + ' tokens') +
        dim('  ·  ') +
        (dC > 0 ? green : dim)('+' + money(dC)) +
        dim('  ·  ') +
        '+' + dM + dim(' msgs')
    );
  }
  lines.push('');
  lines.push(dim(`  refreshing every ${REFRESH_MS / 1000}s · Ctrl-C to quit`));
  return lines.join('\n');
}

// Shared live-loop machinery: repaint renderFrame() every REFRESH_MS.
function runLive(renderFrame, once) {
  const draw = () => {
    const frame = renderFrame();
    if (once) {
      console.log(frame);
      return;
    }
    // Clear screen + home cursor, then paint.
    process.stdout.write('\x1b[2J\x1b[H' + frame + '\n');
  };
  if (once || !process.stdout.isTTY) {
    draw();
    return;
  }
  process.stdout.write('\x1b[?25l'); // hide cursor
  draw();
  const timer = setInterval(draw, REFRESH_MS);
  const cleanup = () => {
    clearInterval(timer);
    process.stdout.write('\x1b[?25h\n'); // show cursor
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

function cmdLive(once) {
  runLive(renderLiveFrame, once);
}

function cmdLiveSession(sid, label, once) {
  let baseline = null; // captured on the first frame that has data
  runLive(() => {
    const snap = sessionSnapshot(sid);
    if (baseline === null && snap.s) {
      baseline = { tokens: usageTotal(snap.agg.total), cost: snap.agg.totalCost, msgs: snap.agg.count };
    }
    return renderLiveSessionFrame(label, snap, baseline);
  }, once);
}

function cmdHelp() {
  console.log(`
${bold('cctokens')} — realtime Claude Code token & cost monitor

${bold('USAGE')}
  cctokens [command]

${bold('COMMANDS')}
  ${cyan('(none)')}          global per-model token totals and cost   ${dim('(default)')}
  ${cyan('today')}           usage for today only
  ${cyan('this')}            just this terminal's session             ${dim('(reads $CLAUDE_CODE_SESSION_ID)')}
  ${cyan('session')} [N]     the N most recent sessions               ${dim('(default 12)')}
  ${cyan('session')} <name>  one session by name or id                ${dim('(e.g. "Deflekt")')}
  ${cyan('project')}         per-project token totals and cost
  ${cyan('live')}            live global dashboard                    ${dim('(refreshes 10s, Ctrl-C to quit)')}
  ${cyan('live this')}       live view of this terminal's session
  ${cyan('live')} <name>     live view of one named session           ${dim('(e.g. live Deflekt)')}
  ${cyan('--json')}          machine-readable summary
  ${cyan('--help')}          this help

${bold('NOTES')}
  Reads ~/.claude/projects/**/*.jsonl (main sessions + subagents).
  Costs are estimates from Anthropic's published per-token rates:
    cache-write = 1.25x input (5m TTL) or 2x input (1h TTL); cache-read = 0.1x input.
  Set ${dim('NO_COLOR=1')} to disable colors.
`);
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(red(`No Claude Code data found at ${PROJECTS_DIR}`));
    process.exit(1);
  }
  const cmd = args[0];
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return cmdHelp();
  if (cmd === '--json') return cmdSummary(true);
  if (cmd === 'today') return cmdToday();
  if (cmd === 'this' || cmd === 'current') return cmdThis();
  if (cmd === 'session' || cmd === 'sessions') {
    const arg = args[1];
    if (arg && !/^\d+$/.test(arg)) return cmdSessionByName(arg);
    const n = parseInt(arg, 10);
    return cmdSessions(Number.isFinite(n) && n > 0 ? n : 12);
  }
  if (cmd === 'project' || cmd === 'projects') return cmdProjects();
  if (cmd === 'live') {
    const once = args.includes('--once');
    const target = args.slice(1).find((a) => a !== '--once');
    if (!target) return cmdLive(once);
    if (target === 'this' || target === 'current') {
      const sid = process.env.CLAUDE_CODE_SESSION_ID;
      if (!sid) {
        console.error(red('  CLAUDE_CODE_SESSION_ID is not set — use `cctokens live <name>`.'));
        process.exit(1);
      }
      return cmdLiveSession(sid, 'this session', once);
    }
    const r = resolveSession(scanAll(), target);
    if (!r) {
      console.error(yellow(`  No session matching "${target}".`));
      process.exit(1);
    }
    return cmdLiveSession(r.sid, r.label, once);
  }
  if (!cmd || cmd === 'summary') return cmdSummary(false);
  console.error(red(`Unknown command: ${cmd}`) + '\nRun `cctokens --help`.');
  process.exit(1);
}

main();
