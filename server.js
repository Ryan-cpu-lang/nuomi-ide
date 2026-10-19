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
 *   - POST /api/pack-nup 打包为 NUP 安装包（预览版）{files:[...]|path, name?}
 *   - POST /api/inspect-nup 回读校验 NUP {path}
 *   - POST /api/open-folder 在文件管理器打开目录 {path?}
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

// ---------- NUP 打包（草案预览版，支持多文件） ----------
// ⚠ 说明：NUP 规范当前存在两个 P0 问题（header 64 vs 88、魔数字节序反了），
// 此处按「核对清单建议的修正草案」实现：64 字节头部 + 正确魔数 "NUP!"(0x2150554E) +
// store-only（不压缩、不签名）。等 liam 修复 P0 定稿后，本函数应同步对齐正式规范。
// entries: [{ pathStr: 'a.nuc', payload: <Buffer> }, ...]
function packNup(entries, pkgName) {
  if (!entries.length) throw new Error('没有可打包的条目');

  // ---- Manifest ----
  let manifest = '[Package]\n';
  manifest += 'name=' + pkgName + '\n';
  manifest += 'version=1.0\n';
  manifest += 'entry=' + (entries[0] ? entries[0].pathStr : '') + '\n';
  manifest += '[Files]\n';
  for (const e of entries) manifest += e.pathStr + '=' + e.pathStr + '\n';
  const manifestBuf = Buffer.from(manifest, 'utf8');

  // ---- 布局：header(64) | manifest | file_table(N*16) | 路径区 | 数据区 ----
  const headerSize = 64;
  const manifestOffset = headerSize;
  const manifestLen = manifestBuf.length;
  const fileTableOffset = manifestOffset + manifestLen;
  const fileTableSize = 16 * entries.length;
  const pathRegionOffset = fileTableOffset + fileTableSize;

  // 路径区：每个 path + null
  const pathBytesList = entries.map((e) => Buffer.from(e.pathStr, 'utf8'));
  let pathRegionSize = 0;
  for (const pb of pathBytesList) pathRegionSize += pb.length + 1;
  const dataStart = pathRegionOffset + pathRegionSize;

  // 文件表 + 计算各文件数据偏移
  const entriesBuf = Buffer.alloc(fileTableSize);
  let off = dataStart;
  let totalUncompressed = 0;
  entries.forEach((e, i) => {
    const pb = pathBytesList[i];
    entriesBuf.writeUInt32LE(off, i * 16 + 0);            // file_offset
    entriesBuf.writeUInt32LE(e.payload.length, i * 16 + 4); // file_size
    entriesBuf.writeUInt32LE(e.payload.length, i * 16 + 8); // original_size
    entriesBuf.writeUInt16LE(pb.length, i * 16 + 12);     // path_len（不含 null）
    entriesBuf.writeUInt8(0, i * 16 + 14);                // compress_type = 0 (store)
    entriesBuf.writeUInt8(0, i * 16 + 15);                // reserved
    off += e.payload.length;
    totalUncompressed += e.payload.length;
  });

  // ---- Header ----
  const header = Buffer.alloc(64);
  header.write('NUP!', 0, 'ascii');            // magic（修正后）
  header.writeUInt16LE(1, 4);                  // version
  header.writeUInt16LE(0, 6);                  // flags = store
  header.writeUInt32LE(manifestOffset, 8);     // manifest_offset
  header.writeUInt32LE(manifestLen, 12);       // manifest_len
  header.writeUInt32LE(fileTableOffset, 16);   // file_table_offset
  header.writeUInt16LE(entries.length, 20);    // file_count
  header.writeUInt16LE(0, 22);                 // reserved1
  header.writeUInt32LE(totalUncompressed, 24); // total_uncompressed
  header.writeUInt32LE(0, 28);                 // signature_offset = 0
  header.writeUInt32LE(0, 32);                 // signature_len = 0
  const nameBuf = Buffer.alloc(28);            // package_name（草案 28 字节）
  nameBuf.write(pkgName.slice(0, 28), 0, 'utf8');
  nameBuf.copy(header, 36);

  // 路径区
  const pathParts = [];
  for (const pb of pathBytesList) pathParts.push(pb, Buffer.from([0]));
  const pathRegion = Buffer.concat(pathParts);

  return Buffer.concat([header, manifestBuf, entriesBuf, pathRegion, ...entries.map((e) => e.payload)]);
}

function inspectNup(buf) {
  if (buf.toString('ascii', 0, 4) !== 'NUP!') throw new Error('魔数错误：不是 NUP! 文件');
  const version = buf.readUInt16LE(4);
  const flags = buf.readUInt16LE(6);
  const manifestOffset = buf.readUInt32LE(8);
  const manifestLen = buf.readUInt32LE(12);
  const fileTableOffset = buf.readUInt32LE(16);
  const fileCount = buf.readUInt16LE(20);
  const totalUncompressed = buf.readUInt32LE(24);
  const sigOffset = buf.readUInt32LE(28);
  const sigLen = buf.readUInt32LE(32);
  const packageName = buf.toString('utf8', 36, 64).replace(/\0+$/, '');
  const manifest = buf.toString('utf8', manifestOffset, manifestOffset + manifestLen);
  const entries = [];
  let pathCursor = fileTableOffset + fileCount * 16;
  for (let i = 0; i < fileCount; i++) {
    const base = fileTableOffset + i * 16;
    const fileOffset = buf.readUInt32LE(base);
    const fileSize = buf.readUInt32LE(base + 4);
    const originalSize = buf.readUInt32LE(base + 8);
    const pathLen = buf.readUInt16LE(base + 12);
    const compressType = buf.readUInt8(base + 14);
    const pathStr = buf.toString('utf8', pathCursor, pathCursor + pathLen);
    pathCursor += pathLen + 1;
    entries.push({
      fileOffset, fileSize, originalSize, pathStr, compressType,
      dataValid: fileOffset + fileSize <= buf.length
    });
  }
  return {
    magic: 'NUP!', version, flags, manifestOffset, manifestLen,
    fileTableOffset, fileCount, totalUncompressed, sigOffset, sigLen,
    packageName, manifest, entries, fileSize: buf.length
  };
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

    if (p === '/api/pack-nup' && req.method === 'POST') {
      const body = await readBody(req);
      const st = toolStatus();
      if (!st.nuomi || !st.nucutil) return sendJSON(res, 500, { ok: false, error: '工具链不完整（需要 nuomi.exe 与 nucutil.exe）' });
      // 支持多文件：body.files 为相对路径数组；兼容旧的单文件 body.path
      const rels = (Array.isArray(body.files) && body.files.length) ? body.files
                 : (body.path ? [body.path] : []);
      if (!rels.length) return sendJSON(res, 400, { ok: false, error: '未指定要打包的文件' });

      const entries = [];
      for (const rel of rels) {
        const srcAbs = safeResolve(rel);
        if (!fs.existsSync(srcAbs)) return sendJSON(res, 404, { ok: false, error: '找不到文件：' + rel });
        const nucOut = srcAbs.replace(/\.nuomi$/i, '.nuc');
        const c1 = spawnSync(NUOMI_EXE, ['-c', srcAbs, '-o', nucOut], { cwd: WORKSPACE, encoding: 'utf8', timeout: 20000, maxBuffer: 8e6 });
        if (c1.status !== 0) return sendJSON(res, 200, { ok: false, stage: 'compile', file: rel, compile: { out: (c1.stdout || ''), err: (c1.stderr || ''), code: c1.status } });
        const payload = fs.readFileSync(nucOut);
        const pathStr = rel.replace(/\.nuomi$/i, '.nuc');
        entries.push({ pathStr, payload });
      }

      const pkgName = (body.name && String(body.name).trim()) || path.basename(rels[0], '.nuomi');
      const nupBuf = packNup(entries, pkgName);
      const safeName = pkgName.replace(/[^\w.-]/g, '_').slice(0, 40) || 'package';
      const nupRel = safeName + '.nup';
      fs.writeFileSync(safeResolve(nupRel), nupBuf);
      return sendJSON(res, 200, {
        ok: true, path: nupRel, size: nupBuf.length, fileCount: entries.length,
        note: '预览版：采用 64 字节草案头部 + 正确魔数 NUP!、store-only、未签名。NUP 规范 P0（header 64/88、魔数字节序）待 liam 修复定稿后将启用校验与签名。'
      });
    }

    if (p === '/api/open-folder' && req.method === 'POST') {
      const body = await readBody(req);
      const rel = body.path || '';
      try {
        const abs = rel ? safeResolve(rel) : WORKSPACE;
        const dir = (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) ? abs : path.dirname(abs);
        if (!fs.existsSync(dir)) return sendJSON(res, 404, { ok: false, error: '目录不存在' });
        const dq = '"' + dir.replace(/\//g, '\\') + '"';
        if (process.platform === 'win32') {
          require('child_process').exec('cmd /c start "" ' + dq);
        } else if (process.platform === 'darwin') {
          require('child_process').exec('open ' + dq);
        } else {
          require('child_process').exec('xdg-open ' + dq);
        }
        return sendJSON(res, 200, { ok: true, dir });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
      }
    }

    if (p === '/api/inspect-nup' && req.method === 'POST') {
      const body = await readBody(req);
      const rel = body.path || '';
      const abs = safeResolve(rel);
      if (!fs.existsSync(abs)) return sendJSON(res, 404, { ok: false, error: '文件不存在' });
      try {
        return sendJSON(res, 200, { ok: true, info: inspectNup(fs.readFileSync(abs)) });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: String(e.message || e) });
      }
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
