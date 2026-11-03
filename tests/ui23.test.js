'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname,'..',p),'utf8');
function appContext(storage = new Map(), cards = []) {
  const toolbar = { setAttribute(){}, hidden:false, innerHTML:'' };
  const root = { querySelector: () => toolbar, querySelectorAll: () => cards };
  const context = { window:{dispatchEvent(){}}, document:{querySelector:()=>root}, location:{pathname:'/release'},
    localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}, Event:class{}, console };
  vm.runInNewContext(read('public/js/common.js'),context);
  return {app:context.window.App,toolbar};
}
test('共享图片映射仅计入正确状态并保留最近/下一次时间', () => {
  const {app}=appContext();
  const jobs=[{status:'pending',scheduledAt:'2026-11-03T10:00:00Z',images:[{key:'a'}]},
    {status:'publishing',scheduledAt:'2026-11-03T09:00:00Z',images:[{key:'a'}]},
    {status:'published',publishedAt:'2026-11-01T09:00:00Z',images:[{key:'a'}]},
    {status:'failed',scheduledAt:'2026-10-01T09:00:00Z',images:[{key:'a'}]}];
  assert.equal(app.pendingImageMap(jobs).a.count,2);
  assert.equal(app.pendingImageMap(jobs).a.next,'2026-11-03T09:00:00Z');
  assert.equal(app.publishedImageMap(jobs).a.count,1);
  assert.equal(app.publishedImageMap(jobs).a.last,'2026-11-01T09:00:00Z');
  assert.equal(app.imageSrc({key:'a b/image.jpg',url:'/original.jpg'},240),'/api/thumb/a%20b/image.jpg?w=240');
  assert.throws(()=>app.imageSrc({key:'a'},999));
});
test('卡片隐藏可恢复、按用户隔离，禁用存储时仍可操作', () => {
  const storage=new Map();
  const card={id:'title-card',dataset:{cardId:'title',cardLabel:'动态标题'},classList:{toggle(_,hidden){this.hidden=hidden;}}};
  const {app,toolbar}=appContext(storage,[card]);
  app.state.user={id:'alice'};
  app.cardVisibility().setVisible('title',false);
  assert.equal(card.classList.hidden,true);
  assert.match(toolbar.innerHTML,/aria-pressed="false"/);
  app.cardVisibility();
  assert.equal(card.classList.hidden,true);
  app.state.user={id:'bob'};
  app.cardVisibility();
  assert.equal(card.classList.hidden,false);
  app.state.user={id:'alice'};
  app.cardVisibility().setVisible('title',true);
  assert.equal(card.classList.hidden,false);
  storage.get=()=>{throw Error('disabled');};storage.set=()=>{throw Error('disabled');};
  app.cardVisibility().setVisible('title',false);
  assert.equal(card.classList.hidden,true);
});
test('队列保留筛选、权限、多选与导入导出入口，去除统计卡', () => {
  const html=read('public/queue.html'), js=read('public/js/pages/queue.js');
  for (const id of ['tabs','filterbar','groupSeg','resultInfo','selectbar','sbInfo','tplLink','importBtn','exportBtn','importFile','importPanel','list','queueSearch']) {
    assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id);
  }
  assert.doesNotMatch(html,/id="metrics"/);
  assert.doesNotMatch(js,/renderMetrics/);
  for(const action of ['all','visible','invert','clear']) assert.ok(html.includes('data-bulk="'+action+'"'));
  assert.match(js,/scopeAll/);assert.match(js,/scope-queue/);
  assert.match(js,/aria-expanded/);assert.match(js,/data-preview=/);
  assert.match(js,/\/api\/jobs\/export/);assert.match(js,/\/api\/jobs\/import/);
});
test('发布图片继续呈现待发布角标与安全缩略图', () => {
  const js=read('public/js/pages/release.js'),css=read('public/css/app.css');
  assert.match(js,/pendingImageMap/);assert.match(js,/pendTip/);assert.match(js,/release-pend-badge/);
  assert.match(css,/\.release-pend-badge\{position:absolute;top:4px;right:4px/);
  assert.match(css,/pointer-events:none/);
});
test('正式页面使用一致的静态资源版本，页面ID无重复', () => {
  const versions=new Set();
  for(const file of fs.readdirSync(path.join(__dirname,'..','public')).filter(x=>x.endsWith('.html')&&!x.startsWith('_'))) {
    const html=read('public/'+file),ids=new Set();
    for(const [,id] of html.matchAll(/\sid="([^"]+)"/g)){assert.ok(!ids.has(id),file+' 重复ID '+id);ids.add(id);}
    for(const [,version] of html.matchAll(/(?:app\.css|\/js\/[^"?]+\.js)\?v=([^"&]+)/g)) versions.add(version);
  }
  assert.equal(versions.size,1,'静态资源版本必须一致');
  assert.doesNotMatch(read('public/js/common.js'),/danbooru/i);
});
