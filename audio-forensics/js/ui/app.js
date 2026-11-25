// 应用入口与哈希路由（#/import、#/detect ...），全部视图本地渲染。
import { renderImport } from '../ui/pages/import.js';
import { renderDetect } from '../ui/pages/detect.js';
import { renderTimeline } from '../ui/pages/timeline.js';
import { renderCustody } from '../ui/pages/custody.js';
import { renderReport } from '../ui/pages/report.js';
import { toast } from './dom.js';

const ROUTES = {
  import: { title: '证据导入', render: renderImport },
  detect: { title: '篡改检测', render: renderDetect },
  timeline: { title: '时间线', render: renderTimeline },
  custody: { title: '保管链', render: renderCustody },
  report: { title: '报告', render: renderReport },
};

const TITLES = {
  import: '证据导入', detect: '篡改检测', timeline: '时间线', custody: '保管链', report: '报告',
};

export function currentRoute() {
  const raw = (location.hash || '#/import').replace('#/', '');
  const [name, param] = raw.split('/');
  return { name: ROUTES[name] ? name : 'import', param: param || null };
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

export async function render() {
  const { name, param } = currentRoute();
  document.querySelectorAll('#nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.route === name);
  });
  document.getElementById('page-title').textContent = TITLES[name];
  const view = document.getElementById('view');
  view.innerHTML = '<div class="empty"><div class="big">加载中…</div></div>';
  try {
    await ROUTES[name].render(view, param);
  } catch (err) {
    view.innerHTML = `<div class="empty"><div class="big">页面渲染失败</div><div class="muted">${err.message}</div></div>`;
    toast('渲染失败：' + err.message, 'err');
  }
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);
