import { statSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { parseFrontmatter } from '../discover.js';

const MAX_BYTES = 1024 * 1024; // larger files are never read line by line
const LONG_LINE = 20000;

// Every regex below avoids nested quantifiers, so matching stays linear in line length.
const ZERO_WIDTH = /[​‎‏⁠-⁤﻿‪-‮⁦-⁩]|[‌‍]{2}|[\u{E0000}-\u{E007F}]/u;
const BASE64_RUN = /[A-Za-z0-9+/]{300,}/;
const INJECTION = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(?:instructions?|rules|prompts?|directions|guidelines)\b/i,
  /\b(?:do not|don't|never)\s+(?:tell|inform|reveal)\s+(?:the\s+)?(?:user|human)\b/i,
  /\b(?:reveal|print|output|show)\s+(?:your\s+)?system\s+prompt\b/i,
  /\byou are now (?:in )?(?:dan|developer mode|jailbroken)\b/i,
];
const COMMENT_EXTRA = /\b(?:secretly|silently|exfiltrat\w*)\b/i;
const PIPE_TO_INTERPRETER = /\|\s*(?:sudo\s+(?:-\S+\s+)?)?(?:(?:ba|z|da|k)?sh|python3?|perl|ruby|node)\b/;
const DOWNLOADER = /\b(?:curl|wget)\b/;
const SHELL_SUBST = /\b(?:ba|z)?sh\s+(?:-c\s+["']?\$\(|<\()\s*(?:curl|wget)\b/;
const SECRET_PATH = /\.ssh\/(?:id_\w+|\w*key\w*)|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.gnupg\b|\.netrc\b|\.npmrc\b|\.docker\/config\.json|\.config\/gcloud|\.kube\/config|\/etc\/shadow|Login Data/;
const NETWORK_CALL = /\b(?:curl|wget|ncat?|scp|Invoke-WebRequest)\b|\bfetch\s*\(|requests\.(?:get|post|put)|\burllib|\baxios\b|http\.request|XMLHttpRequest/;
const PERSIST_PATH = /\.(?:bashrc|zshrc|bash_profile|zprofile|profile|zshenv)\b|\.(?:claude|codex)\/(?:settings(?:\.local)?\.json|config\.toml)|\/etc\/(?:cron|systemd|profile\.d|rc\.local)|LaunchAgents|\.config\/(?:autostart|systemd)/;
const WRITE_SIGNAL = />|\btee\b|\bsed\s+-i|\b(?:echo|cp|mv|write|writes|append|appends|modify|modifies|edit|edits|overwrite|patch)\b/i;
const SCHEDULER = /\bcrontab\s+-(?!l\b)|\blaunchctl\s+load\b|\bsystemctl\s+(?:--user\s+)?enable\b/;
const RM_ROOT = /\brm\s+(?:-[a-zA-Z-]+\s+)+(?:--no-preserve-root\s+)?["']?(?:\/|~|\$HOME|\$\{HOME\})(?:\*|\/\*?)?(?=["'\s;|&]|$)/;
const WIPE = /\bmkfs(?:\.\w+)?\s|\bdd\s+[^\n]{0,80}\bof=\/dev\/(?:sd|nvme|disk)/;
const WIDE_TOOLS = /(?:^|[,\s[])(?:\*|Bash(?:\(\s*:?\*?\s*\))?)(?=$|[,\s\]])/;

const anyOf = (res, s) => res.some((re) => re.test(s));

export const RULES = [
  { id: 'remote-exec', severity: 'high', reason: 'pipes a downloaded script into a shell',
    test(line) {
      const m = PIPE_TO_INTERPRETER.exec(line);
      return (m && DOWNLOADER.test(line.slice(0, m.index))) || SHELL_SUBST.test(line);
    } },
  { id: 'remote-instructions', severity: 'high', reason: 'fetches a web page and follows its instructions',
    test: (line) => /https?:\/\//i.test(line) && /\b(?:fetch|download|load|read|curl|wget)\b/i.test(line)
      && /\b(?:follow|obey|execute|comply with|adhere to)\b/i.test(line)
      && /\b(?:instructions?|rules|directives?|guidelines|commands|prompt)\b/i.test(line) },
  { id: 'hidden-text', severity: 'high', reason: 'hides text from the reader (invisible characters, comments or encoded data)',
    test: (line, ctx) => ZERO_WIDTH.test(line)
      || (BASE64_RUN.test(line) && !line.includes('data:image/'))
      || (ctx.comment !== '' && (anyOf(INJECTION, ctx.comment) || COMMENT_EXTRA.test(ctx.comment))) },
  { id: 'injection-phrase', severity: 'high', reason: 'tells the AI to ignore its instructions or hide things from you',
    test: (line) => anyOf(INJECTION, line) },
  { id: 'secret-theft', severity: 'high', reason: 'reads private keys or credentials and also sends data over the network',
    test: (line, ctx) => ctx.network && SECRET_PATH.test(line) },
  { id: 'persistence', severity: 'medium', reason: 'changes shell startup, scheduled jobs or agent settings',
    test: (line) => SCHEDULER.test(line) || (PERSIST_PATH.test(line) && WRITE_SIGNAL.test(line)) },
  { id: 'destructive', severity: 'medium', reason: 'deletes or wipes whole folders or disks',
    test: (line) => RM_ROOT.test(line) || WIPE.test(line) },
  { id: 'wide-permissions', severity: 'medium', reason: 'asks for unrestricted tool permissions',
    test: (line, ctx) => ctx.lineNo === ctx.allowedLine && WIDE_TOOLS.test(ctx.allowedTools) },
  { id: 'opaque', severity: 'info', reason: 'contains binary or minified code that cannot be reviewed',
    // ctx.opaque is a reason string set by the scanner for binary or oversize files
    test: (line, ctx) => ctx.opaque || (line.length > LONG_LINE && 'contains a minified or very long single-line file that cannot be reviewed') },
  // Emitted by scanStatic once per skill.outside entry; never matches a line.
  { id: 'outside-link', severity: 'medium', reason: 'links to a file outside the skill folder', test: () => false },
];
const byId = Object.fromEntries(RULES.map((r) => [r.id, r]));

const isBinary = (buf) => {
  const head = buf.subarray(0, 8000);
  return head.includes(0) || (head.length > 3 && head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF');
};

function* commentParts(lines) {
  let open = false;
  for (const line of lines) {
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
  let partial = false;
  const add = (id, file, line, reason) => findings.push({ rule: id, severity: byId[id].severity, file, line, reason: reason || byId[id].reason });

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

    const text = buf.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/);
    const ctx = { network: NETWORK_CALL.test(text), comment: '', lineNo: 0, allowedLine: -1, allowedTools: '' };
    if (abs === skill.skillPath) {
      const fm = parseFrontmatter(text);
      if (fm.allowedTools) {
        ctx.allowedTools = fm.allowedTools;
        ctx.allowedLine = lines.findIndex((l) => /^allowed-tools:/.test(l)) + 1;
      }
    }
    const comments = commentParts(lines);
    lines.forEach((line, i) => {
      ctx.lineNo = i + 1;
      ctx.comment = comments.next().value;
      for (const rule of RULES) {
        const hit = rule.test(line, ctx);
        if (hit) add(rule.id, file, ctx.lineNo, typeof hit === 'string' ? hit : undefined);
      }
    });
  }
  for (const rel of skill.outside) { partial = true; add('outside-link', rel, 0); }

  const verdict = findings.some((f) => f.severity === 'high') ? 'block'
    : findings.some((f) => f.severity === 'medium') ? 'warn' : 'ok';
  return { verdict, partial, findings };
}

export function label(result) {
  const f = result.findings.find((x) => x.severity === 'high') || result.findings.find((x) => x.severity === 'medium');
  return f ? f.reason : 'no issues found';
}
