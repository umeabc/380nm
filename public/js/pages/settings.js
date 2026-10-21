'use strict';
(async function () {
  const { $, api, toast } = App;

  App.boot({
    active: 'settings',
    title: '全站设置',
    ready: async (me) => {
      if (me.role !== 'admin') { location.href = '/dashboard'; return; }
      const s = (await api('GET', '/api/settings')).settings;
      const ph = (v, has) => (has ? `已配置 ${v}（留空保持不变）` : '未设置');
      $('#set-pixiv').placeholder = ph(s.pixivSession, s.hasPixivSession);
      $('#set-auth').placeholder = ph(s.twitterAuth, s.hasTwitterAuth);
      $('#set-ct0').placeholder = ph(s.twitterCt0, s.hasTwitterCt0);
      $('#set-proxy').value = s.importProxy || '';

      // X 账号测试：读服务端**已保存**的凭据真实请求 X；响应到达前二次点击无效
      let xTesting = false;
      $('#btn-x-test').addEventListener('click', async () => {
        if (xTesting) return;
        const btn = $('#btn-x-test');
        const box = $('#x-test-result');
        xTesting = true;
        btn.disabled = true;
        btn.textContent = '测试中…';
        box.className = 'x-test-hint';
        box.textContent = '';
        try {
          const r = await api('POST', '/api/settings/x-test');
          if (r && r.ok) {
            const handle = r.handle || '';
            const name = r.name && r.name !== handle && r.name !== handle.replace(/^@/, '') ? r.name + ' ' : '';
            box.className = 'x-test-hint ck-ok';
            box.textContent = '凭据可用：' + name + handle;
          } else {
            box.className = 'x-test-hint ck-bad';
            box.textContent = (r && r.reason) || '测试失败，请稍后再试';
          }
        } catch (e) {
          box.className = 'x-test-hint ck-bad';
          box.textContent = e.message;
        } finally {
          xTesting = false;
          btn.disabled = false;
          btn.textContent = 'X账号测试';
        }
      });

      $('#btn-save').addEventListener('click', async () => {
        try {
          const body = { importProxy: $('#set-proxy').value.trim() };
          for (const [id, key] of [['#set-pixiv', 'pixivSession'], ['#set-auth', 'twitterAuth'], ['#set-ct0', 'twitterCt0']]) {
            const v = $(id).value.trim();
            if (v) body[key] = v; // 留空 = 保持不变
          }
          await api('PUT', '/api/settings', body);
          toast('设置已保存', 'success');
          // 刷新占位提示
          const s2 = (await api('GET', '/api/settings')).settings;
          const ph = (v, has) => (has ? `已配置 ${v}（留空保持不变）` : '未设置');
          $('#set-pixiv').placeholder = ph(s2.pixivSession, s2.hasPixivSession);
          $('#set-auth').placeholder = ph(s2.twitterAuth, s2.hasTwitterAuth);
          $('#set-ct0').placeholder = ph(s2.twitterCt0, s2.hasTwitterCt0);
          $('#set-pixiv').value = ''; $('#set-auth').value = ''; $('#set-ct0').value = '';
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    }
  }).catch((e) => toast(e.message, 'error'));
})();
