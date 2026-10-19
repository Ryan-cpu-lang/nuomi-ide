// SPDX-License-Identifier: GPL-2.0
/*
 * Nuomi IDE — 零依赖本地后端
 * 功能：
 *   - 静态托管 public/（IDE 界面）
 *   - /api/about        版本 + 工具链可用性
 *   - /api/tree         工作区目录树
 *   - /api/file?path=   读文件
 *   - POST /api/file    写文件 {path, content}
 *   - POST /api/run     运行/编译运行 {path, mode:'interpret'|'compile'}
 *   - POST /api/repl    持久 REPL 交互 {line}
 *   - POST /api/repl/reset  重启 REPL
 * 仅用 Node 内置模块，无需 npm install。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const cfgPath = path.join(ROOT, 'ide.config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const PORT = Number(cfg.port) || 7177;
// 工具链目录优先级：环境变量 NUOMI_HOME > 配置文件 nuomi_home > 默认同级 Nuomi 目录
const NUOMI_HOME = process.env.NUOMI_HOME
  ? path.resolve(ROOT, process.env.NUOMI_HOME)
  : path.resolve(ROOT, cfg.nuomi_home || '../Nuomi');
const NUOMI_EXE = path.join(NUOMI_HOME, 'nuomi.exe');
const NUCUTIL_EXE = path.join(NUOMI_HOME, 'nucutil.exe');
const PUBLIC = path.join(ROOT, 'public');
const WORKSPACE = path.resolve(ROOT, cfg.workspace || 'workspace');

if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });

// 首次启动把 samples 拷进工作区（仅当目标不存在，避免覆盖用户改动）
(function seedWorkspace() {
  const samplesSrc = path.join(NUOMI_HOME, 'samples');
  if (fs.existsSync(samplesSrc)) {
    for (const f of fs.readdirSync(samplesSrc)) {
      if (f.endsWith('.nuomi')) {
        const dst = path.join(WORKSPACE, f);
        if (!fs.existsSync(dst)) {
          try { fs.copyFileSync(path.join(samplesSrc, f), dst); } catch (e) { /* ignore */ }
        }
      }
    }
  }
  const welcome = path.join(WORKSPACE, 'welcome.nuomi');
  if (!fs.existsSync(welcome)) {
    fs.writeFileSync(welcome,
      '; 🍡 欢迎使用 Nuomi IDE！\n' +
      '; 这是糯米语言的 Playground，左边写代码，下方点“运行”或切到 REPL 标签交互。\n\n' +
      '(define (square x) (* x x))\n' +
      '(println "3 的平方 =" (square 3))\n' +
      '(define (greet name) (str "你好, " name "!" ))\n' +
      '(println (greet "糯米"))\n', 'utf8');
  }
})();

// 路径安全：所有相对路径必须落在 WORKSPACE 内
function safeResolve(rel) {
  const abs = path.resolve(WORKSPACE, rel || '');
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw new Error('非法路径：超出工作区');
  }
  return abs;
}

function toolStatus() {
  const haveNuomi = fs.existsSync(NUOMI_EXE);
  const haveNucutil = fs.existsSync(NUCUTIL_EXE);
  return { nuomi: haveNuomi, nucutil: haveNucutil, home: NUOMI_HOME };
}

function buildTree(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const e of entries) {
    if (e.name === '.run' || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ name: e.name, isDir: true, rel: path.relative(WORKSPACE, abs), children: buildTree(abs) });
    } else {
      out.push({ name: e.name, isDir: false, rel: path.relative(WORKSPACE, abs) });
    }
  }
  out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return out;
}

// ---------- 持久 REPL 会话 ----------
let repl = null;
let replReady = false;
let replBuf = '';
let replErr = '';
let replSentAt = 0;
let replResolve = null;
let replTimer = null;

function ensureRepl() {
  if (repl && !repl.killed) return;
  replBuf = ''; replErr = ''; replReady = false; replResolve = null;
  repl = spawn(NUOMI_EXE, [], { cwd: NUOMI_HOME, stdio: ['pipe', 'pipe', 'pipe'] });
  repl.stdout.on('data', (d) => {
    replBuf += d.toString('utf8');
    if (!replReady) {
      if (replBuf.indexOf('nuomi> ') !== -1) {
        replReady = true;
        replSentAt = replBuf.length;
        if (replResolve) flushRepl();
      }
    } else if (replResolve && replBuf.indexOf('nuomi> ', replSentAt) !== -1) {
      flushRepl();
    }
  });
  repl.stderr.on('data', (d) => { replErr += d.toString('utf8'); });
  repl.on('exit', () => {
    const r = replResolve; replResolve = null; repl = null;
    if (r) r({ out: replBuf.slice(replSentAt), err: replErr + '\n[REPL 进程已退出]' });
  });
}

function flushRepl() { finishRepl(false); }

function finishRepl(continued) {
  if (replTimer) { clearTimeout(replTimer); replTimer = null; }
  let out = replBuf.slice(replSentAt);
  out = out.replace(/nuomi> $/, '');   // 去掉末尾回显的提示符
  if (continued && out.trim() === '') out = '(等待继续输入… 完成表达式，或点“↻ REPL”重启)';
  replSentAt = replBuf.length;
  const err = replErr; replErr = '';
  const r = replResolve; replResolve = null;
  if (r) r({ out, err });
}

function replEval(line) {
  ensureRepl();
  return new Promise((resolve) => {
    const doSend = () => {
      replResolve = resolve;
      replSentAt = replBuf.length;
      try { repl.stdin.write(line + '\n'); } catch (e) { resolve({ out: '', err: String(e) }); return; }
      replTimer = setTimeout(() => { if (replResolve) finishRepl(true); }, 5000);
    };
    if (replReady) doSend();
    else {
      const chk = setInterval(() => {
        if (replReady) { clearInterval(chk); doSend(); }
      }, 50);
      setTimeout(() => clearInterval(chk), 8000);
    }
  });
}

// ---------- HTTP 辅助 ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUBLIC, path.normalize(rel));
  if (!abs.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (p === '/api/about') {
      const st = toolStatus();
      return sendJSON(res, 200, { ok: true, version: 'Nuomi IDE 0.1', tools: st, workspace: WORKSPACE });
    }

    if (p === '/api/tree' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, tree: buildTree(WORKSPACE) });
    }

    if (p === '/api/file' && req.method === 'GET') {
      const rel = u.searchParams.get('path') || '';
      const abs = safeResolve(rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return sendJSON(res, 404, { ok: false, error: '文件不存在' });
      const content = fs.readFileSync(abs, 'utf8');
      return sendJSON(res, 200, { ok: true, path: rel, content, name: path.basename(abs) });
    }

    if (p === '/api/file' && req.method === 'POST') {
      const body = await readBody(req);
      const rel = body.path || '';
      const content = typeof body.content === 'string' ? body.content : '';
      const abs = safeResolve(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return sendJSON(res, 200, { ok: true, path: rel, name: path.basename(abs) });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      const rel = body.path || '';
      const mode = body.mode === 'compile' ? 'compile' : 'interpret';
      const st = toolStatus();
      if (!st.nuomi) return sendJSON(res, 500, { ok: false, error: '找不到 nuomi.exe，请先运行 build.bat 编译工具链' });
      const abs = safeResolve(rel);
      if (!fs.existsSync(abs)) return sendJSON(res, 404, { ok: false, error: '请先保存文件' });

      if (mode === 'compile') {
        if (!st.nucutil) return sendJSON(res, 500, { ok: false, error: '找不到 nucutil.exe' });
        const out = abs.replace(/\.nuomi$/i, '.nuc');
        const c1 = spawnSync(NUOMI_EXE, ['-c', abs, '-o', out], { cwd: WORKSPACE, encoding: 'utf8', timeout: 20000, maxBuffer: 8e6 });
        const compile = { out: (c1.stdout || ''), err: (c1.stderr || ''), code: c1.status };
        if (c1.status !== 0) return sendJSON(res, 200, { ok: false, stage: 'compile', compile, run: null });
        const c2 = spawnSync(NUCUTIL_EXE, ['run', out], { cwd: WORKSPACE, encoding: 'utf8', timeout: 20000, maxBuffer: 8e6 });
        const run = { out: (c2.stdout || ''), err: (c2.stderr || ''), code: c2.status };
        return sendJSON(res, 200, { ok: true, stage: 'run', compile, run });
      } else {
        const c = spawnSync(NUOMI_EXE, [abs], { cwd: WORKSPACE, encoding: 'utf8', timeout: 20000, maxBuffer: 8e6 });
        const run = { out: (c.stdout || ''), err: (c.stderr || ''), code: c.status };
        return sendJSON(res, 200, { ok: true, stage: 'run', compile: null, run });
      }
    }

    if (p === '/api/repl' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await replEval(String(body.line == null ? '' : body.line));
      return sendJSON(res, 200, { ok: true, out: r.out, err: r.err });
    }

    if (p === '/api/repl/reset' && req.method === 'POST') {
      if (repl && !repl.killed) repl.kill();
      repl = null; replReady = false;
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  const url = 'http://localhost:' + PORT;
  console.log('🍡 Nuomi IDE 已启动: ' + url);
  console.log('   工作区: ' + WORKSPACE);
  console.log('   工具链: ' + NUOMI_HOME);
  if (process.platform === 'win32') {
    try { require('child_process').exec('cmd /c start "" ' + url); } catch (e) { /* user can open manually */ }
  }
});
