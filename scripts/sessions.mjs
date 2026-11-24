#!/usr/bin/env node
// Hook UserPromptSubmit: atrapa ":sessions …" y lista o borra sesiones guardadas de Claude Code
// sin pasar por Claude. Solo sesiones de la terminal: las del app de escritorio no se tocan.
// Cualquier otro mensaje sigue su camino normal.
//
//   :sessions [texto]            lista (filtra por proyecto o primer mensaje)
//   :sessions delete <números>   prepara el borrado de esos números de la última lista (ej: 2 · 3 4 · 1-5)
//   :sessions delete empty       … de las sesiones sin mensajes
//   :sessions delete +30d        … de las que no se usan hace más de 30 días
//   :sessions confirm            manda a la papelera lo preparado
//   :sessions help
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try { input = JSON.parse(raw || '{}'); } catch {}

const prompt = (input.prompt ?? '').trim();
if (!/^:sessions(\s|$)/i.test(prompt)) process.exit(0); // no es para nosotros

const reply = (text) => {
  // continue:false = el mensaje no llega a Claude; stopReason = lo que ve el usuario.
  // Claude Code lo muestra como "Operation stopped by hook: …", más limpio que decision:block
  // (que agrega "UserPromptSubmit operation blocked by hook:" y "Original prompt: …").
  process.stdout.write(JSON.stringify({ continue: false, stopReason: text }));
  process.exit(0);
};

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = path.join(configDir, 'projects');
const stateDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'session-sweep');
const lastFile = path.join(stateDir, 'last.json');
const pendingFile = path.join(stateDir, 'pending.json');
const PENDING_TTL = 5 * 60 * 1000;
const current = input.session_id;

const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };

// ── Lectura de sesiones ───────────────────────────────────────────
function head(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8').split('\n');
  } finally { fs.closeSync(fd); }
}

// Texto escrito por el usuario: descarta bloques que inyecta Claude Code (<system-reminder>, etc.).
function textOf(content) {
  const blocks = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text ?? '') : [];
  return blocks.map((t) => t.trim()).find((t) => t && !t.startsWith('<')) ?? '';
}

function describe(file) {
  let cwd = null, first = '', entrypoint = null;
  for (const line of head(file)) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    cwd ??= e.cwd ?? null;
    entrypoint ??= e.entrypoint ?? null;
    if (e.type === 'user' && !e.isMeta && !first) first = textOf(e.message?.content);
    if (cwd && first && entrypoint) break;
  }
  return { cwd, first, entrypoint };
}

// Ids de sesiones que el app de escritorio registra como suyas
// (<config del app>/claude-code-sessions/<cuenta>/<org>/local_*.json → cliSessionId).
function desktopSessionIds() {
  const ids = new Set();
  const appDir = process.env.CLAUDE_DESKTOP_DIR || (
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
    : process.platform === 'win32' ? path.join(process.env.APPDATA ?? '', 'Claude')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude'));
  const root = path.join(appDir, 'claude-code-sessions');
  for (const a of ls(root)) for (const b of ls(path.join(root, a))) {
    for (const f of ls(path.join(root, a, b))) {
      if (!/^local_.*\.json$/.test(f)) continue;
      const id = readJson(path.join(root, a, b, f))?.cliSessionId;
      if (id) ids.add(id);
    }
  }
  return ids;
}

// Sesiones con un proceso de Claude Code vivo (~/.claude/sessions/<pid>.json).
function openSessions() {
  const open = new Set();
  for (const f of ls(path.join(configDir, 'sessions'))) {
    if (!f.endsWith('.json')) continue;
    const s = readJson(path.join(configDir, 'sessions', f));
    if (!s?.sessionId || !s.pid) continue;
    try { process.kill(s.pid, 0); open.add(s.sessionId); } catch (e) { if (e.code === 'EPERM') open.add(s.sessionId); }
  }
  return open;
}

// Solo sesiones de Claude Code (terminal); las del app de escritorio se ignoran por completo.
function loadSessions() {
  const open = openSessions();
  const desktop = desktopSessionIds();
  const out = [];
  for (const proj of ls(projectsDir)) {
    const dir = path.join(projectsDir, proj);
    for (const f of ls(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (desktop.has(id)) continue;
      const file = path.join(dir, f);
      const info = describe(file);
      if (info.entrypoint === 'claude-desktop') continue;
      const st = fs.statSync(file);
      out.push({ id, proj, file, mtime: st.mtimeMs, size: st.size, ...info,
        current: id === current, open: id === current || open.has(id) });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Todo lo que Claude Code guarda para una sesión, fuera de la memoria del proyecto.
function artifactsOf(s) {
  const p = [
    s.file,
    path.join(projectsDir, s.proj, s.id),                 // subagentes / herramientas
    path.join(configDir, 'file-history', s.id),
    path.join(configDir, 'session-env', s.id),
    path.join(configDir, 'tasks', s.id),
    path.join(configDir, 'debug', `${s.id}.txt`),
  ];
  for (const f of ls(path.join(configDir, 'todos'))) if (f.startsWith(s.id)) p.push(path.join(configDir, 'todos', f));
  return p.filter(exists);
}

// ── Formato ───────────────────────────────────────────────────────
const projectName = (s) => {
  if (!s.cwd) return '?';
  return s.cwd.replace(os.homedir(), '~');
};
const ago = (ms) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 60) return `hace ${m} min`;
  if (m < 1440) return `hace ${Math.floor(m / 60)} h`;
  return `hace ${Math.floor(m / 1440)} d`;
};
const size = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/\s+/g, ' ');
const mark = (s) => (s.current ? '● ' : s.open ? '▶ ' : '  ');
const row = (s, n) => [
  String(n).padStart(2),
  cut(projectName(s), 28).padEnd(28),
  ago(s.mtime).padEnd(11),
  size(s.size).padStart(7),
  mark(s) + (s.first ? `"${cut(s.first, 48)}"` : '(vacía)'),
].join('  ');
const total = (list) => size(list.reduce((a, s) => a + s.size, 0));

const HELP = [
  ':sessions [texto]          lista (filtra por proyecto o primer mensaje)',
  ':sessions delete <números>   borra esos números de la última lista (ej: 2 · 3 4 · 1-5)',
  ':sessions delete empty     borra las sesiones sin mensajes',
  ':sessions delete +30d      borra las que no se usan hace más de 30 días',
  ':sessions confirm          confirma el borrado preparado',
  '',
  'Solo sesiones de Claude Code en la terminal; las del app de escritorio no aparecen ni se borran.',
  'Lo borrado va a la papelera. ● = la actual, ▶ = abierta en otra ventana; esas nunca se borran.',
].join('\n');

// ── Comandos ──────────────────────────────────────────────────────
const args = prompt.split(/\s+/).slice(1);
const cmd = (args[0] ?? '').toLowerCase();

if (cmd === 'help' || cmd === '-h' || cmd === '--help') reply(HELP);

if (cmd === 'delete' || cmd === 'rm') {
  const sel = args.slice(1);
  if (!sel.length) reply('Indica qué borrar, por ejemplo: :sessions delete 2  (o 3 4, o 1-5)\n\n' + HELP);
  const all = loadSessions();
  const byId = new Map(all.map((s) => [s.id, s]));
  const last = readJson(lastFile)?.ids ?? [];
  const picked = new Map(), errors = [];

  for (const tok of sel) {
    let m;
    if (/^(empty|vacias|vacías)$/i.test(tok)) {
      all.filter((s) => !s.first).forEach((s) => picked.set(s.id, s));
    } else if ((m = /^\+(\d+)d$/i.exec(tok))) {
      const limit = Date.now() - Number(m[1]) * 86400000;
      all.filter((s) => s.mtime < limit).forEach((s) => picked.set(s.id, s));
    } else if ((m = /^(\d+)(?:-(\d+))?$/.exec(tok))) {
      if (!last.length) { errors.push('Primero lista con :sessions para poder usar números.'); continue; }
      const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) {
        const s = byId.get(last[n - 1]);
        if (s) picked.set(s.id, s); else errors.push(`El número ${n} no está en la última lista (o ya no existe).`);
      }
    } else if (byId.has(tok)) {
      picked.set(tok, byId.get(tok));
    } else {
      errors.push(`No entiendo "${tok}".`);
    }
  }

  const skipped = [...picked.values()].filter((s) => s.open);
  const targets = [...picked.values()].filter((s) => !s.open);
  const msg = [];
  if (errors.length) msg.push(...[...new Set(errors)], '');
  if (skipped.length) msg.push(`Se omiten ${skipped.length} abierta(s) (● / ▶): no se pueden borrar mientras están en uso.`, '');
  if (!targets.length) reply([...msg, 'No hay nada para borrar.'].join('\n'));

  writeJson(pendingFile, { at: Date.now(), ids: targets.map((s) => s.id) });
  reply([
    ...msg,
    `Se van a mandar a la papelera ${targets.length} sesión(es) · ${total(targets)}:`,
    '',
    // Mismo número que en la última lista; '·' si no estaba en ella (empty / +30d).
    ...targets.map((s) => row(s, last.includes(s.id) ? last.indexOf(s.id) + 1 : '·')),
    '',
    'Escribe  :sessions confirm  en los próximos 5 minutos para borrarlas.',
  ].join('\n'));
}

if (cmd === 'confirm' || cmd === 'yes' || cmd === 'si' || cmd === 'sí') {
  const pending = readJson(pendingFile);
  if (!pending?.ids?.length || Date.now() - pending.at > PENDING_TTL) {
    try { fs.unlinkSync(pendingFile); } catch {}
    reply('No hay ningún borrado pendiente (o pasaron más de 5 minutos). Prepáralo con :sessions delete …');
  }
  fs.unlinkSync(pendingFile);
  const all = new Map(loadSessions().map((s) => [s.id, s]));
  let done = 0, bytes = 0;
  const failed = [];
  for (const id of pending.ids) {
    const s = all.get(id);
    if (!s || s.open) continue; // ya no existe, o se abrió entre medio
    try {
      for (const p of artifactsOf(s)) trash(p);
      done++; bytes += s.size;
    } catch (e) { failed.push(`${cut(projectName(s), 28)}: ${e.message}`); }
    // Carpeta del proyecto vacía (sin memoria ni otras sesiones) → fuera también.
    const dir = path.join(projectsDir, s.proj);
    if (!ls(dir).length) { try { fs.rmdirSync(dir); } catch {} }
  }
  fs.rmSync(lastFile, { force: true }); // los números de la lista anterior ya no valen
  reply([
    `Listo: ${done} sesión(es) a la papelera · ${size(bytes)}.`,
    ...(failed.length ? ['', 'No se pudieron borrar:', ...failed] : []),
  ].join('\n'));
}

function trash(p) {
  try { execFileSync('gio', ['trash', '--', p], { stdio: 'ignore', timeout: 5000 }); return; } catch {}
  // Sin gio: a una papelera propia dentro de la config de Claude.
  const bin = path.join(configDir, '.trash', `${Date.now()}-${path.basename(p)}`);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.renameSync(p, bin);
}

// ── Listar (por defecto) ──────────────────────────────────────────
const filter = args.join(' ').toLowerCase();
const shown = loadSessions().filter((s) =>
  !filter || projectName(s).toLowerCase().includes(filter) || s.first.toLowerCase().includes(filter));
writeJson(lastFile, { at: Date.now(), ids: shown.map((s) => s.id) });

reply([
  `Sesiones de Claude Code${filter ? ` que coinciden con "${filter}"` : ''}: ${shown.length} · ${total(shown)}   (● actual  ▶ abierta)`,
  '',
  ...shown.map((s, i) => row(s, i + 1)),
  '',
  'Borrar:  :sessions delete <números>  (ej: 2 · 3 4 · 1-5)  ·  delete empty  ·  delete +30d      Ayuda:  :sessions help',
].join('\n'));
