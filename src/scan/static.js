import { statSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { parseFrontmatter } from '../discover.js';

const MAX_BYTES = 1024 * 1024; // larger files are never read line by line
const LONG_LINE = 20000;

// Every regex below avoids nested quantifiers, so matching stays linear in line length.
const BIDI_OR_TAG = /[\u202a-\u202e\u2066-\u2069]|[\u{E0000}-\u{E007F}]/u;
const ZERO_RUN = /[\u200b-\u200d\u2060\ufeff]{2}/;
const LONE_INVISIBLE = /[\u200b-\u200f\u2060\ufeff]/;
const EMOJI_ZWJ = /(\p{Extended_Pictographic}[\ufe0f\u{1F3FB}-\u{1F3FF}]?)\u200d(?=\p{Extended_Pictographic})/gu;
const BASE64_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{300,}/g;
const DATA_URI_TAIL = /data:image\/[\w.+-]+;base64,$/;
const INJECTION = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier)\b[^.\n]{0,20}\b(?:instructions?|rules|prompts?|directions|guidelines)\b/i,
  /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|your|the|these|those)\s+)*instructions?\b/i,
  /\b(?:do not|don['\u2019]t|never)\s+(?:tell|inform|reveal)\s+(?:the\s+)?(?:user|human)\b/i,
  /\bwithout\s+(?:telling|informing|notifying)\s+(?:the\s+)?(?:user|human)\b/i,
  /\b(?:reveal|print|output|show)\s+(?:your\s+)?system\s+prompt\b/i,
  /\byou are now (?:in )?(?:dan|developer mode|jailbroken)\b/i,
];
// Pipes into an interpreter. Shells run whatever they are given; python/node/perl/ruby only count
// when they read the script from stdin (bare, or `-`), so `| python3 -m json.tool` is fine.
const PIPE_TO_INTERPRETER = /(?<!\|)\|\s*(?:sudo\s+(?:-\S+\s+)?)?(?:(?:\/usr)?\/bin\/env\s+|env\s+|xargs\s+(?:-\S+\s+)*)?(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:(?:ba|z|da|k)?sh\b|(?:python3?|perl|ruby|node)(?:\s+-)?\s*(?=$|[;&|)]))/g;
const DOWNLOADER = /\b(?:curl|wget)\b/;
const SHELL_SUBST = /(?:\b(?:ba|z|da|k)?sh|\bsource|\beval|(?:^|[\s;&(])\.)\s+(?:-c\s+)?["']?(?:\$\(|<\(|`)\s*(?:curl|wget)\b/;
// shortcut: remote-exec misses two-step download-then-run, PowerShell iwr | iex and uppercase CURL; add if seen in the wild.
const SECRET_SSH = /\.ssh(?![\w.-])(\/[^\s'"`;|&<>)]*)?/g;
const SECRET_OTHER = /\bid_(?:rsa|ed25519|ecdsa|dsa)\b(?!\.pub)|\.aws\/credentials|\.gnupg\b|\.netrc\b|\.npmrc\b|\.git-credentials|\.pypirc|\.docker\/config\.json|\.config\/gcloud|\.config\/gh\/hosts\.yml|\.kube\/config|\/etc\/shadow|Login Data/;
const NETWORK_CALL = /\b(?:curl|wget|nc|ncat|socat|telnet|scp|rsync|Invoke-RestMethod|Invoke-WebRequest)\b|\/dev\/tcp\/|\bfetch\s*\(|\bhttps?\.request|requests\.(?:get|post|put|patch|delete)|\burllib|\baxios\b|XMLHttpRequest/;
const PERSIST_PATH = /\.(?:bashrc|zshrc|bash_profile|zprofile|profile|zshenv)\b|\.(?:claude|codex)\/(?:settings(?:\.local)?\.json|config\.toml)|\/etc\/(?:cron|systemd|profile\.d|rc\.local)|LaunchAgents|\.config\/(?:autostart|systemd)/;
const WRITE_SIGNAL = />|\btee\b|\bsed\s+-i|\b(?:echo|cp|mv|write|writes|append|appends|modify|modifies|edit|edits|overwrite|patch)\b/i;
const SCHEDULER = /\bcrontab\s+-(?!l\b)|\blaunchctl\s+load\b|\bsystemctl\s+(?:--user\s+)?enable\b/;
const RM_ROOT = /\brm\s+(?:-[a-zA-Z-]+\s+)+(?:--no-preserve-root\s+)?["']?(?:\/|~|\$HOME|\$\{HOME\})(?:\*|\/\*?)?(?=["'\s;|&]|$)/;
const WIPE = /\bmkfs(?:\.\w+)?\s|\bdd\s+[^\n]{0,80}\bof=\/dev\/(?:sd|nvme|disk)/;
const WIDE_TOOLS = /(?:^|[,\s[])(?:\*|Bash(?:\(\s*:?\*?\s*\))?)(?=$|[,\s\]])/;

const anyOf = (res, s) => res.some((re) => re.test(s));

function pipesToInterpreter(line) {
  const first = line.search(DOWNLOADER);
  if (first < 0) return false;
  PIPE_TO_INTERPRETER.lastIndex = 0;
  for (let m; (m = PIPE_TO_INTERPRETER.exec(line));) if (m.index > first) return true;
  return false;
}

function hasBase64(line) {
  BASE64_RUN.lastIndex = 0;
  for (let m; (m = BASE64_RUN.exec(line));) {
    if (!DATA_URI_TAIL.test(line.slice(Math.max(0, m.index - 80), m.index))) return true;
  }
  return false;
}

// A secret path that is not a public key or authorized_keys; bare `.ssh` (whole dir) counts.
function hasSecretPath(line) {
  if (SECRET_OTHER.test(line)) return true;
  SECRET_SSH.lastIndex = 0;
  for (let m; (m = SECRET_SSH.exec(line));) {
    const p = m[1] || '';
    if (!p.endsWith('.pub') && !/\/authorized_keys$/.test(p)) return true;
  }
  return false;
}

export const RULES = [
  { id: 'remote-exec', severity: 'high', reason: 'pipes a downloaded script into a shell',
    test: (line) => pipesToInterpreter(line) || SHELL_SUBST.test(line) },
  { id: 'remote-instructions', severity: 'high', reason: 'fetches a web page and follows its instructions',
    test: (line) => /https?:\/\//i.test(line) && /\b(?:fetch|download|load|read|curl|wget)\b/i.test(line)
      && /\b(?:follow|obey|execute|comply with|adhere to)\b/i.test(line)
      && /\b(?:instructions?|rules|directives?|guidelines|commands|prompt)\b/i.test(line) },
  { id: 'hidden-text', severity: 'high', reason: 'hides text from the reader (invisible characters, comments or encoded data)',
    test: (line, ctx) => BIDI_OR_TAG.test(line) || ZERO_RUN.test(line) || hasBase64(line)
      || (ctx.comment !== '' && anyOf(INJECTION, ctx.comment)) },
  { id: 'hidden-char', severity: 'medium', reason: 'contains an invisible character',
    test: (line) => {
      const plain = line.replace(EMOJI_ZWJ, '$1'); // emoji joiners are normal text
      return LONE_INVISIBLE.test(plain) && !ZERO_RUN.test(plain);
    } },
  { id: 'injection-phrase', severity: 'high', reason: 'tells the AI to ignore its instructions or hide things from you',
    test: (line) => anyOf(INJECTION, line) },
  { id: 'secret-theft', severity: 'high', reason: 'reads private keys or credentials and also sends data over the network',
    // shortcut: needs the path and the network call in one file; read in one file, send in another is not caught.
    test: (line, ctx) => ctx.network && hasSecretPath(line) },
  { id: 'persistence', severity: 'medium', reason: 'changes shell startup, scheduled jobs or agent settings',
    test: (line) => SCHEDULER.test(line) || (PERSIST_PATH.test(line) && WRITE_SIGNAL.test(line)) },
  { id: 'destructive', severity: 'medium', reason: 'deletes or wipes whole folders or disks',
    test: (line) => RM_ROOT.test(line) || WIPE.test(line) },
  { id: 'wide-permissions', severity: 'medium', reason: 'asks for unrestricted tool permissions',
    test: (line, ctx) => ctx.lineNo === ctx.allowedLine && WIDE_TOOLS.test(ctx.allowedTools) },
  { id: 'opaque', severity: 'info', reason: 'contains binary or minified code that cannot be reviewed',
    test: (line) => line.length > LONG_LINE && 'contains a minified or very long single-line file that cannot be reviewed' },
  // Emitted by scanStatic once per skill.outside entry; never matches a line.
  { id: 'outside-link', severity: 'medium', reason: 'links to a file outside the skill folder', test: () => false },
];
const byId = Object.fromEntries(RULES.map((r) => [r.id, r]));

const isBinary = (buf) => {
  const head = buf.subarray(0, 8000);
  return head.includes(0) || (head.length > 3 && head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF');
};

const FENCE = /^\s*(?:```|~~~)/;
const MAX_PER_RULE = 5; // per rule per file, so one noisy file cannot flood the picker

// Physical lines, with backslash-continued lines joined; `no` is the first physical line.
function logicalLines(text) {
  const physical = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < physical.length; i++) {
    const no = i + 1;
    const parts = [];
    while (physical[i].endsWith('\\') && i + 1 < physical.length) parts.push(physical[i++].slice(0, -1));
    parts.push(physical[i]);
    out.push({ text: parts.length > 1 ? parts.join(' ') : parts[0], no });
  }
  return out;
}

// Network calls only count on code: every line of a script, fenced blocks of markdown.
function hasNetworkCall(lines, isMarkdown) {
  let fenced = false;
  for (const { text } of lines) {
    if (isMarkdown && FENCE.test(text)) { fenced = !fenced; continue; }
    if ((!isMarkdown || fenced) && NETWORK_CALL.test(text)) return true;
  }
  return false;
}

function* commentParts(lines) {
  let open = false;
  for (const { text: line } of lines) {
    let out = '';
    let i = 0;
    for (;;) {
      const j = line.indexOf(open ? '-->' : '<!--', i);
      if (j < 0) { if (open) out += line.slice(i); break; }
      if (open) out += line.slice(i, j) + ' ';
      open = !open;
      i = j + (open ? 4 : 3);
    }
    yield out;
  }
}

export function scanStatic(skill) {
  const findings = [];
  const counts = new Map();
  let partial = false;
  const add = (id, file, line, reason) => {
    const key = `${id}\0${file}`;
    const n = counts.get(key) || 0;
    if (n >= MAX_PER_RULE) return;
    counts.set(key, n + 1);
    findings.push({ rule: id, severity: byId[id].severity, file, line, reason: reason || byId[id].reason });
  };

  for (const abs of skill.files) {
    const file = relative(skill.dir, abs).split(sep).join('/');
    let buf;
    try {
      const size = statSync(abs).size;
      if (size > MAX_BYTES) {
        partial = true;
        add('opaque', file, 0, `larger than 1 MB (${(size / MAX_BYTES).toFixed(1)} MB), not read`);
        continue;
      }
      buf = readFileSync(abs);
    } catch { partial = true; continue; }
    if (isBinary(buf)) { add('opaque', file, 0, 'binary file that cannot be reviewed'); continue; }

    const text = buf.toString('utf8').replace(/^\ufeff/, '');
    const lines = logicalLines(text);
    const ctx = {
      network: hasNetworkCall(lines, /\.(?:md|markdown|mdx)$/i.test(file)),
      comment: '', lineNo: 0, allowedLine: -1, allowedTools: '',
    };
    if (abs === skill.skillPath) {
      const fm = parseFrontmatter(text);
      if (fm.allowedTools) {
        ctx.allowedTools = fm.allowedTools;
        ctx.allowedLine = Math.max(1, lines.find((l) => /^allowed-tools:/.test(l.text))?.no ?? 1);
      }
    }
    const comments = commentParts(lines);
    for (const { text: line, no } of lines) {
      ctx.lineNo = no;
      ctx.comment = comments.next().value;
      for (const rule of RULES) {
        const hit = rule.test(line, ctx);
        if (hit) add(rule.id, file, no, typeof hit === 'string' ? hit : undefined);
      }
    }
  }
  for (const rel of skill.outside) { partial = true; add('outside-link', rel, 0); }

  const verdict = findings.some((f) => f.severity === 'high') ? 'block'
    : findings.some((f) => f.severity === 'medium') ? 'warn' : 'ok';
  return { verdict, partial, findings };
}

export function label(result) {
  const f = result.findings.find((x) => x.severity === 'high') || result.findings.find((x) => x.severity === 'medium');
  if (f) return f.reason;
  return result.partial ? 'no issues found (partial scan)' : 'no issues found';
}
