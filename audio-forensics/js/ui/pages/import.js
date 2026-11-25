// 页面 1：证据导入
import { h, clear, toast, badge, shortHash, formatBadge } from '../dom.js';
import { listEvidence, importEvidence, deleteEvidence, verifyCustody } from '../../core/store.js';
import { formatBytes, formatTime } from '../../core/util.js';
import { navigate } from '../app.js';

export async function renderImport(view) {
  clear(view);
  const evidence = await listEvidence();

  const dz = h('div', { class: 'dropzone' },
    h('div', { class: 'dz-title' }, '拖入现场录音，或点击选择文件'),
    h('div', { class: 'dz-sub' }, '支持 WAV(RIFF) 与 MP3(MPEG Layer III) · 按容器魔数识别，不看扩展名 · 文件不离开本机'),
    h('input', {
      type: 'file', accept: '.wav,.mp3,audio/*',
      onchange: async e => {
        const f = e.target.files[0];
        if (f) await handleFile(f);
        e.target.value = '';
      },
    }),
  );
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', async e => {
    e.preventDefault(); dz.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) await handleFile(f);
  });
  dz.addEventListener('click', () => dz.querySelector('input').click());

  const card = h('div', { class: 'card' },
    h('h2', {}, '导入证据 ', h('span', { class: 'hint' }, '导入即计算 SHA-256 并写入保管链首条记录')),
    dz,
  );

  const table = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, '证据编号'), h('th', {}, '原始文件名'), h('th', {}, '格式（魔数）'),
      h('th', {}, '大小'), h('th', {}, 'SHA-256'), h('th', {}, '导入时间'), h('th', {}, '保管链'), h('th', {}, '操作'))),
    h('tbody', {}, evidence.map(ev => h('tr', {},
      h('td', { class: 'mono' }, ev.evidenceId),
      h('td', {}, ev.fileName),
      h('td', {}, formatBadge(ev.detectedMagic)),
      h('td', { class: 'mono' }, formatBytes(ev.fileSize)),
      h('td', { class: 'hash-cell', title: ev.fileHash }, shortHash(ev.fileHash, 18)),
      h('td', { class: 'faint' }, new Date(ev.importedAt).toLocaleString()),
      h('td', {}, chainState(ev.evidenceId)),
      h('td', {}, h('div', { class: 'row tight' },
        h('button', { class: 'small primary', onclick: () => navigate('#/detect/' + ev.evidenceId) }, '检测'),
        h('button', { class: 'small', onclick: () => navigate('#/custody/' + ev.evidenceId) }, '保管链'),
        h('button', { class: 'small danger', onclick: () => remove(ev) }, '删除'),
      )),
    ))),
  );

  const listCard = h('div', { class: 'card' },
    h('h2', {}, `证据库（${evidence.length}）`),
    evidence.length ? table : h('div', { class: 'empty' }, h('div', { class: 'big' }, '尚无证据'), h('div', {}, '导入后元数据与保管链保存在本机 IndexedDB')),
  );

  view.append(card, listCard);

  async function handleFile(file) {
    toast('正在计算哈希并解析容器：' + file.name, 'ok', 6000);
    try {
      const { duplicated } = await importEvidence(file);
      toast(duplicated ? '相同哈希的证据已存在，已去重' : `证据已入库：${file.name}`, duplicated ? 'warn' : 'ok');
      renderImport(view);
    } catch (err) {
      toast('导入失败：' + err.message, 'err', 6000);
    }
  }

  async function remove(ev) {
    if (!confirm(`确认删除证据「${ev.fileName}」及其保管链与全部分析记录？此操作不可恢复。`)) return;
    await deleteEvidence(ev.evidenceId);
    toast('证据已删除', 'warn');
    renderImport(view);
  }
}

async function chainState(evidenceId) {
  const v = await verifyCustody(evidenceId);
  return v.ok ? badge('链完整', 'ok') : badge('链异常', 'bad');
}
