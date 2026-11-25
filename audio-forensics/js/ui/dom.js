// 极简 DOM 辅助与全局 toast
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

export function toast(message, kind = 'ok', ms = 3400) {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.className = 'toast';
    document.body.appendChild(root);
  }
  const item = h('div', { class: `item ${kind}` }, message);
  root.appendChild(item);
  setTimeout(() => { item.style.opacity = '0'; item.style.transition = 'opacity .3s'; setTimeout(() => item.remove(), 320); }, ms);
}

export function badge(text, cls) { return h('span', { class: `badge ${cls}` }, text); }

export function shortHash(x, n = 14) {
  if (!x) return '—';
  return x.length > n ? x.slice(0, n) + '…' : x;
}

export function confidenceBadge(level) {
  const map = { high: ['高置信', 'high'], medium: ['中置信', 'medium'], low: ['低置信', 'low'] };
  const [t, c] = map[level] || [level, 'low'];
  return badge(t, c);
}

export function formatBadge(magic) {
  if (magic === 'audio/wav') return badge('WAV / RIFF', 'wav');
  if (magic === 'audio/mpeg') return badge('MP3 / MPEG', 'mp3');
  return badge('未知格式', 'unknown');
}

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
