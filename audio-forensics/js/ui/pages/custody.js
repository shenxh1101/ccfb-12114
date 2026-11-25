// 页面 4：保管链 —— 哈希链展示、完整性校验、篡改演示（仅改内存副本，不落库）
import { h, clear, toast, badge, shortHash } from '../dom.js';
import {
  listEvidence, getChain, verifyCustody, appendCustody, CUSTODY_ACTIONS,
} from '../../core/store.js';
import { verifyChain, computeEntryHash } from '../../core/custody.js';
import { navigate } from '../app.js';

const ACTION_LABEL = {
  import: '证据导入', analyze: '完整性分析', 'export-report': '导出 JSON 报告',
  'export-pdf': '导出 PDF', verify: '哈希校验', 'export-evidence': '导出证据副本',
};

export async function renderCustody(view, param) {
  clear(view);
  const all = await listEvidence();
  if (!all.length) {
    view.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '请先导入证据')));
    return;
  }
  const evidence = all.find(e => e.evidenceId === param) || all[0];
  const entries = await getChain(evidence.evidenceId);
  const verify = verifyChain(entries);

  const head = h('div', { class: 'card' },
    h('h2', {}, `保管链 · ${evidence.fileName}`),
    h('dl', { class: 'kv' },
      h('dt', {}, '证据编号'), h('dd', { class: 'mono' }, evidence.evidenceId),
      h('dt', {}, '当前文件哈希'), h('dd', { class: 'mono strike-verify' }, evidence.fileHash),
      h('dt', {}, '链条目数'), h('dd', {}, String(entries.length)),
      h('dt', {}, '链尾指纹'), h('dd', { class: 'mono strike-verify' }, verify.tip),
    ),
    h('div', { class: 'row tight', style: 'margin-top:14px' },
      h('button', { class: 'small', onclick: () => logVerify() }, '记录一次人工校验'),
      h('button', { class: 'small danger', onclick: () => tamperDemo() }, '篡改演示：改写第 1 条的哈希'),
    ),
  );

  const statusCard = h('div', { class: 'card' },
    h('h2', {}, '链完整性校验'),
    verify.ok
      ? h('div', {}, badge('校验通过：哈希链完整', 'ok'),
        h('div', { class: 'faint', style: 'margin-top:8px;font-size:12.5px' },
          '每条记录的 entryHash 覆盖其全部字段与前一条 entryHash；删除、重排或修改任意一条都会在此报错并定位序号'))
      : h('div', {}, badge(`校验失败：首个断裂序号 ${verify.firstBrokenSeq}`, 'bad'),
        h('ul', { class: 'reasons' }, ...verify.errors.map(e => h('li', {}, e)))),
  );

  const chainVis = h('div', { class: 'chain-vis' },
    ...entries.flatMap((e, i) => {
      const broken = !verify.ok && i >= (verify.firstBrokenSeq ?? 0);
      const node = h('div', { class: 'chain-node' + (broken ? ' tampered' : '') },
        h('div', { class: 'row tight', style: 'justify-content:space-between' },
          h('div', { class: 'row tight' }, h('span', { class: 'seq' }, `#${e.seq}`), badge(ACTION_LABEL[e.action] || e.action, 'info')),
          h('span', { class: 'faint', style: 'font-size:12px' }, new Date(e.timestamp).toLocaleString())),
        h('dl', { class: 'kv', style: 'margin-top:10px;grid-template-columns:130px 1fr' },
          h('dt', {}, '操作人'), h('dd', {}, e.operator),
          h('dt', {}, '关联哈希'), h('dd', { class: 'mono strike-verify' }, e.fileHash || '—'),
          h('dt', {}, 'prevHash'), h('dd', { class: 'mono strike-verify' }, e.prevHash),
          h('dt', {}, 'entryHash'), h('dd', { class: 'mono strike-verify' }, e.entryHash),
          e.detail && Object.keys(e.detail).length ? h('dt', {}, '明细') : h('dt', {}),
          e.detail && Object.keys(e.detail).length ? h('dd', { class: 'code-block' }, JSON.stringify(e.detail)) : h('dd', {}),
        ));
      return i === 0 ? [node] : [h('div', { class: 'chain-link' }), node];
    }),
  );

  const chainCard = h('div', { class: 'card' }, h('h2', {}, '链式记录'), entries.length ? chainVis : h('div', { class: 'faint' }, '暂无记录'));
  view.append(head, statusCard, chainCard);

  async function logVerify() {
    await appendCustody(evidence.evidenceId, CUSTODY_ACTIONS.VERIFY, {
      evidenceName: evidence.fileName,
      fileHash: evidence.fileHash,
      detail: { result: verify.ok ? 'chain-ok' : 'chain-broken', checkedAt: new Date().toISOString() },
    });
    toast('已记录人工校验事件', 'ok');
    renderCustody(view, param);
  }

  // 篡改演示：深拷贝链到内存，改一条记录，立刻重算证明断裂；不写回 IndexedDB
  function tamperDemo() {
    if (entries.length < 2) { toast('至少需要 2 条记录才能演示', 'warn'); return; }
    const cloned = entries.map(e => ({ ...e, detail: { ...e.detail } }));
    const target = cloned[1];
    const original = target.fileHash;
    target.fileHash = 'f' + (target.fileHash || '').slice(1);
    const reVerify = verifyChain(cloned);
    const modal = h('div', {
      style: 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:40',
      onclick: e => { if (e.target === modal) modal.remove(); },
    }, h('div', { class: 'card', style: 'width:min(680px,92vw);margin:0' },
      h('h2', {}, '篡改演示结果（仅内存，未写入存储）'),
      h('div', { class: 'row tight', style: 'margin:8px 0' }, badge('检测到篡改', 'bad'), badge(`断裂序号 #${reVerify.firstBrokenSeq}`, 'warn')),
      h('dl', { class: 'kv' },
        h('dt', {}, '被改字段'), h('dd', {}, '第 1 条 fileHash'),
        h('dt', {}, '原值'), h('dd', { class: 'mono strike-verify' }, original),
        h('dt', {}, '篡改值'), h('dd', { class: 'mono strike-verify' }, target.fileHash),
        h('dt', {}, '重算 entryHash'), h('dd', { class: 'mono strike-verify' }, computeEntryHash(target)),
        h('dt', {}, '记录 entryHash'), h('dd', { class: 'mono strike-verify' }, target.entryHash),
      ),
      h('ul', { class: 'reasons', style: 'margin-top:10px' }, ...reVerify.errors.map(x => h('li', {}, x))),
      h('div', { class: 'row tight', style: 'margin-top:14px' },
        h('button', { class: 'primary small', onclick: () => modal.remove() }, '知道了'),
        h('button', { class: 'small', onclick: () => { modal.remove(); navigate('#/custody/' + evidence.evidenceId); } }, '查看真实保管链')),
    ));
    document.body.appendChild(modal);
  }
}
