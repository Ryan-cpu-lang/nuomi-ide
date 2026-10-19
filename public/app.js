'use strict';
/* Nuomi IDE 前端逻辑 */

// ---------- 语法高亮 ----------
const KEYWORDS = new Set(['quote', 'if', 'while', 'define', 'set!', 'lambda', 'begin', 'and', 'or']);
const BUILTINS = new Set([
  '+', '-', '*', '/', '%', '=', '<', '>', '<=', '>=',
  'not', 'equal?', 'eq?',
  'print', 'println',
  'cons', 'car', 'cdr', 'list', 'length', 'nth', 'get', 'set', 'vec', 'str',
  'input', 'input-int'
]);

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(src) {
  const RE = /(;.*$)|("(?:[^"\\]|\\.)*")|(-?\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|([()\[\]{}]|`|,@|,|')|([^\s()\[\]{}";]+)/gm;
  let out = '', last = 0, m;
  while ((m = RE.exec(src))) {
    if (m.index > last) out += escapeHtml(src.slice(last, m.index));
    const t = m[0];
    if (m[1]) out += '<span class="c-com">' + escapeHtml(t) + '</span>';
    else if (m[2]) out += '<span class="c-str">' + escapeHtml(t) + '</span>';
    else if (m[3]) out += '<span class="c-num">' + escapeHtml(t) + '</span>';
    else if (m[4]) out += '<span class="c-par">' + escapeHtml(t) + '</span>';
    else {
      let cls = 'c-sym';
      if (KEYWORDS.has(t)) cls = 'c-kw';
      else if (BUILTINS.has(t)) cls = 'c-fn';
      out += '<span class="' + cls + '">' + escapeHtml(t) + '</span>';
    }
    last = RE.lastIndex;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const highlightPre = $('highlight');
const codeEl = highlightPre.querySelector('code');   // 高亮层里的 <code>
const taEl = $('code');                              // 编辑用的 <textarea id="code">
const gutterEl = $('gutter');
const treeEl = $('tree');
const outputEl = $('output');
const replLog = $('replLog');
const replInput = $('replInput');

// ---------- 状态 ----------
let state = { path: null, name: '未命名', dirty: false, busy: false, lastExport: null };

// ---------- 编辑器 ----------
function render() {
  const src = taEl.value;
  codeEl.innerHTML = highlight(src);
  updateGutter(src);
  updatePos();
}
function updateGutter(src) {
  const n = src.split('\n').length;
  let s = '';
  for (let i = 1; i <= n; i++) s += i + '\n';
  gutterEl.textContent = s;
}
function syncScroll() {
  highlightPre.scrollTop = taEl.scrollTop;
  highlightPre.scrollLeft = taEl.scrollLeft;
  gutterEl.scrollTop = taEl.scrollTop;
}
function updatePos() {
  const p = taEl.selectionStart;
  const before = taEl.value.slice(0, p);
  const line = before.split('\n').length;
  const col = p - before.lastIndexOf('\n');
  $('stPos').textContent = '行 ' + line + ', 列 ' + col;
}
function setDirty(d) {
  state.dirty = d;
  $('dirtyDot').hidden = !d;
}
function setStatus(msg, isErr) {
  const el = $('stMsg');
  el.textContent = msg;
  el.style.color = isErr ? 'var(--err)' : 'var(--accent2)';
}

taEl.addEventListener('input', () => { render(); setDirty(true); });
taEl.addEventListener('scroll', syncScroll);
taEl.addEventListener('keyup', updatePos);
taEl.addEventListener('click', updatePos);
taEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = taEl.selectionStart, en = taEl.selectionEnd;
    taEl.value = taEl.value.slice(0, s) + '  ' + taEl.value.slice(en);
    taEl.selectionStart = taEl.selectionEnd = s + 2;
    render(); setDirty(true);
  }
});

// ---------- API ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

// ---------- 文件树 ----------
async function loadTree() {
  const data = await api('/api/tree');
  if (!data.ok) { treeEl.innerHTML = '<div style="color:var(--err);padding:8px">读取工作区失败</div>'; return; }
  treeEl.innerHTML = '<ul>' + renderNodes(data.tree) + '</ul>';
  treeEl.querySelectorAll('.file > .node').forEach((node) => {
    node.addEventListener('click', () => {
      const rel = node.parentElement.getAttribute('data-rel');
      openFile(rel);
    });
  });
}
function renderNodes(nodes) {
  let h = '';
  for (const n of nodes) {
    if (n.isDir) {
      h += '<li class="dir" data-rel="' + esc(n.rel) + '"><div class="node"><span class="twist">▾</span><span class="ico">📂</span>' + esc(n.name) + '</div><ul>' + renderNodes(n.children || []) + '</ul></li>';
    } else {
      h += '<li class="file" data-rel="' + esc(n.rel) + '"><div class="node"><span class="twist"></span><span class="ico">📄</span>' + esc(n.name) + '</div></li>';
    }
  }
  return h;
}
function esc(s) { return String(s).replace(/"/g, '&quot;'); }

async function openFile(rel) {
  if (state.dirty) {
    if (!confirm('当前文件未保存，切换将丢失改动？')) return;
  }
  const data = await api('/api/file?path=' + encodeURIComponent(rel));
  if (!data.ok) { alert(data.error || '打开失败'); return; }
  taEl.value = data.content;
  state.path = rel; state.name = data.name; setDirty(false);
  $('tabName').textContent = data.name;
  $('stFile').textContent = rel;
  treeEl.querySelectorAll('.node.active').forEach((x) => x.classList.remove('active'));
  const li = treeEl.querySelector('li.file[data-rel="' + cssEsc(rel) + '"] > .node');
  if (li) li.classList.add('active');
  render();
  setStatus('已打开 ' + rel);
}
function cssEsc(s) { return s.replace(/["\\]/g, '\\$&'); }

// ---------- 保存 ----------
async function saveFile(asNew) {
  let rel = state.path;
  if (!rel || asNew) {
    const name = prompt('文件名（建议以 .nuomi 结尾）：', state.path || 'untitled.nuomi');
    if (!name) return false;
    rel = name;
  }
  const data = await api('/api/file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: rel, content: taEl.value })
  });
  if (!data.ok) { alert('保存失败'); return false; }
  state.path = rel; state.name = data.name; setDirty(false);
  $('tabName').textContent = data.name;
  $('stFile').textContent = rel;
  setStatus('已保存 ' + rel);
  loadTree();
  return true;
}

// ---------- 运行 ----------
async function run(mode) {
  if (!state.path) {
    if (!await saveFile(true)) return;
  } else if (state.dirty) {
    await saveFile(false);
  }
  if (state.busy) return;
  state.busy = true; $('btnRun').disabled = true; $('btnCompile').disabled = true;
  setStatus('运行中…');
  showPanel('output');
  try {
    const data = await api('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.path, mode })
    });
    let html = '';
    if (!data.ok) {
      html += '<span class="err">运行失败：' + esc(data.error || '') + '</span>\n';
      if (data.compile) html += renderRun(data.compile, '编译');
      if (data.run) html += renderRun(data.run, '运行');
    } else {
      if (data.compile) {
        html += '⚙ <b>编译阶段</b>\n' + renderRun(data.compile, 'compile');
        html += '\n▶ <b>运行阶段（原生 NUC 入口返回值）</b>\n' + renderRun(data.run, 'run');
      } else {
        html += '▶ <b>解释器输出</b>\n' + renderRun(data.run, 'run');
      }
      html += '\n<span class="ok">✓ 完成</span>';
    }
    outputEl.innerHTML = html;
    setStatus(mode === 'compile' ? '编译运行完成' : '运行完成');
  } catch (e) {
    outputEl.innerHTML = '<span class="err">请求错误：' + esc(String(e)) + '</span>';
    setStatus('运行出错', true);
  } finally {
    state.busy = false; $('btnRun').disabled = false; $('btnCompile').disabled = false;
  }
}
function renderRun(r, label) {
  if (!r) return '';
  let h = '';
  if (r.out) h += escapeHtml(r.out);
  if (r.err) h += '<span class="err">' + escapeHtml(r.err) + '</span>';
  if ((r.out || '').trim() === '' && (r.err || '').trim() === '') h += '（无输出）\n';
  return h;
}

// ---------- 导出 .nup（预览版，支持多文件） ----------
function collectNuomi(nodes, out) {
  for (const n of (nodes || [])) {
    if (n.isDir) collectNuomi(n.children, out);
    else if (n.name.endsWith('.nuomi')) out.push(n.rel);
  }
  return out;
}

function openPackModal() {
  const modal = $('packModal');
  const list = $('packFileList');
  list.innerHTML = '<div class="hint">正在读取工作区…</div>';
  $('packName').value = state.path && state.path.endsWith('.nuomi')
    ? pathBasename(state.path, '.nuomi') : 'my-app';
  modal.hidden = false;
  api('/api/tree').then((data) => {
    if (!data.ok) { list.innerHTML = '<div class="hint">读取失败</div>'; return; }
    const files = collectNuomi(data.tree, []);
    if (!files.length) { list.innerHTML = '<div class="hint">工作区没有 .nuomi 文件</div>'; return; }
    list.innerHTML = '';
    for (const f of files) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = f;
      if (f === state.path) cb.checked = true;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + f));
      list.appendChild(label);
    }
    if (!files.includes(state.path) && files.length) {
      list.querySelector('input').checked = true;
    }
  });
}
function pathBasename(p, ext) {
  const b = p.split(/[\\/]/).pop();
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
}

async function doPack() {
  const modal = $('packModal');
  const checked = Array.from($('packFileList').querySelectorAll('input:checked')).map((c) => c.value);
  if (!checked.length) { alert('请至少勾选一个 .nuomi 文件'); return; }
  $('packDo').disabled = true;
  try {
    const r = await api('/api/pack-nup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: checked, name: $('packName').value.trim() })
    });
    if (!r.ok) {
      let html = '<span class="err">打包失败：' + esc(r.error || '') + '</span>\n';
      if (r.compile) html += renderRun(r.compile, 'compile') + '（文件：' + esc(r.file || '') + '）\n';
      if (r.stage === 'compile') showPanel('output');
      outputEl.innerHTML = html;
      setStatus('打包失败', true);
      return;
    }
    state.lastExport = r.path;
    const ins = await api('/api/inspect-nup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: r.path })
    });
    let html = '📦 <b>已导出 ' + esc(r.path) + '（' + r.size + ' 字节，' + (r.fileCount || 1) + ' 个程序）</b>\n';
    html += '<span class="warn">⚠ ' + esc(r.note) + '</span>\n\n';
    if (ins.ok) {
      const i = ins.info;
      html += '校验回读：\n';
      html += '  魔数: ' + i.magic + '\n';
      html += '  包名: ' + esc(i.packageName) + '\n';
      html += '  版本: ' + i.version + '  标志(store=0): ' + i.flags + '\n';
      html += '  文件数: ' + i.fileCount + '  总大小: ' + i.totalUncompressed + ' B\n';
      for (const e of i.entries) {
        html += '    • ' + esc(e.pathStr) + '  (' + e.fileSize + ' B, ' + (e.dataValid ? '数据完整' : '数据越界') + ')\n';
      }
      html += '\n  Manifest:\n' + escapeHtml(i.manifest);
    } else {
      html += '<span class="err">回读失败：' + esc(ins.error) + '</span>\n';
    }
    showPanel('output');
    outputEl.innerHTML = html;
    setStatus('已导出 ' + r.path + '（' + (r.fileCount || 1) + ' 个文件）');
    modal.hidden = true;
  } catch (e) {
    outputEl.innerHTML = '<span class="err">请求错误：' + esc(String(e)) + '</span>';
    setStatus('出错', true);
  } finally {
    $('packDo').disabled = false;
  }
}

async function openExportFolder() {
  const target = state.lastExport || '';
  try {
    const r = await api('/api/open-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target })
    });
    if (!r.ok) setStatus('无法打开文件夹：' + (r.error || ''), true);
    else setStatus('已打开文件夹：' + r.dir);
  } catch (e) {
    setStatus('打开文件夹出错', true);
  }
}

// ---------- 输出/REPL 面板 ----------
function showPanel(which) {
  document.getElementById('panel-output').hidden = which !== 'output';
  document.getElementById('panel-repl').hidden = which !== 'repl';
  document.querySelectorAll('.btab').forEach((b) => b.classList.toggle('active', b.dataset.tab === which));
}
document.querySelectorAll('.btab').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.tab)));

$('btnClearOut').addEventListener('click', () => {
  if (document.getElementById('panel-output').hidden === false) outputEl.textContent = '';
  else replLog.innerHTML = '';
});

// REPL
let replBusy = false;
async function replSend() {
  if (replBusy) return;
  const line = replInput.value;
  if (line.trim() === '') return;
  replBusy = true;
  appendRepl('nuomi> ' + line, 'in');
  replInput.value = '';
  try {
    const data = await api('/api/repl', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line })
    });
    if (data.out && data.out.trim() !== '') appendRepl(data.out, 'out');
    if (data.err && data.err.trim() !== '') appendRepl(data.err, 'err');
  } catch (e) {
    appendRepl('REPL 错误：' + String(e), 'err');
  } finally {
    replBusy = false;
    replLog.parentElement.scrollTop = replLog.parentElement.scrollHeight;
  }
}
function appendRepl(text, kind) {
  const div = document.createElement('div');
  div.className = 'line-' + kind;
  div.textContent = text.replace(/\n$/, '');
  replLog.appendChild(div);
}
replInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') replSend(); });
$('btnReset').addEventListener('click', async () => {
  await api('/api/repl/reset', { method: 'POST' });
  replLog.innerHTML = '';
  appendRepl('REPL 已重启。', 'out');
});

// ---------- 顶栏按钮 ----------
$('btnNew').addEventListener('click', async () => {
  const name = prompt('新文件名（建议以 .nuomi 结尾）：', 'untitled.nuomi');
  if (!name) return;
  await api('/api/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: name, content: '' }) });
  taEl.value = ''; state.path = name; state.name = name; setDirty(false);
  $('tabName').textContent = name; $('stFile').textContent = name;
  render(); loadTree(); setStatus('已新建 ' + name);
});
$('btnSave').addEventListener('click', () => saveFile(false));
$('btnSaveAs').addEventListener('click', () => saveFile(true));
$('btnRun').addEventListener('click', () => run('interpret'));
$('btnCompile').addEventListener('click', () => run('compile'));
$('btnPack').addEventListener('click', openPackModal);
$('btnOpenExport').addEventListener('click', openExportFolder);
$('packDo').addEventListener('click', doPack);
$('packCancel').addEventListener('click', () => { $('packModal').hidden = true; });
$('packModal').addEventListener('click', (e) => { if (e.target === $('packModal')) $('packModal').hidden = true; });
$('btnTheme').addEventListener('click', () => {
  const b = document.body;
  b.dataset.theme = b.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('nuomi-ide-theme', b.dataset.theme); } catch (e) {}
});

// 快捷键
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(false); }
  if (e.key === 'F5') { e.preventDefault(); run('interpret'); }
});

// ---------- 初始化 ----------
(async function init() {
  const t = localStorage.getItem('nuomi-ide-theme');
  if (t) document.body.dataset.theme = t;
  try {
    const a = await api('/api/about');
    $('stVer').textContent = a.version + (a.tools && a.tools.nuomi ? ' · 工具链已就绪' : ' · ⚠ 工具链缺失');
    if (a.tools && !a.tools.nuomi) setStatus('未找到 nuomi.exe，请用 build.bat 编译工具链', true);
  } catch (e) { $('stVer').textContent = '连接后端失败'; }
  await loadTree();
  // 默认打开 welcome.nuomi
  try { await openFile('welcome.nuomi'); } catch (e) {}
  render();
  taEl.focus();
})();
