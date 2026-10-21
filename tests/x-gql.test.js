'use strict';
/* X GraphQL 受限推文抓取（参考 tmd 配方）：stub fetch 断言请求构造与解析分支。
 * 不真实联网；凭据一律假值。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWork, ImportError } = require('../src/importers');

const FAKE_AUTH = 'fake-auth-token-0123456789abcdef';
const FAKE_CT0 = 'fake-csrf-0123456789abcdef0123456789abcdef';

const BEARER_PREFIX = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs';
const QID = '0hWvDhmW8YQ-S_ib3azIrw';

function gqlResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
function imgResponse() {
  return {
    ok: true, status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => PNG_BYTES.buffer.slice(0),
    json: async () => ({})
  };
}
const syndNoMedia = { ok: true, status: 200, json: async () => ({ __typename: 'TweetTombstone', tombstone: {} }) };

function gqlPayload(typename = 'Tweet', nested = false) {
  const legacy = {
    full_text: '受限推文测试图',
    created_at: 'Wed Oct 21 10:00:00 +0000 2107',
    extended_entities: { media: [
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/ABC123' },
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/DEF456' }
    ] }
  };
  const result = nested
    ? { __typename: 'TweetWithVisibilityResults', tweet: { legacy, core: { user_results: { result: { legacy: { screen_name: 'kururu', name: '966' } } } } } }
    : { __typename: 'Tweet', legacy, core: { user_results: { result: { legacy: { screen_name: 'kururu', name: '966' } } } } };
  return { data: { tweetResult: { result } } };
}

test('GraphQL 主路：三头齐全 + queryId/variables 编码正确', async () => {
  const seen = [];
  const fakeFetch = async (url, opts = {}) => {
    seen.push({ url, headers: opts.headers || {} });
    if (url.includes('/i/api/graphql/')) return gqlResponse(gqlPayload());
    if (url.includes('pbs.twimg.com/media/')) return imgResponse();
    return { ok: true, status: 200, json: async () => syndNoMedia };
  };
  // 临时替换全局 fetch（importers 无凭据时走全局 fetch；这里主要验证有凭据路径）
  const origFetch = global.fetch;
  global.fetch = fakeFetch;
  const undici = require('undici');
  const origUfetch = undici.fetch;
  undici.fetch = fakeFetch;
  try {
    const r = await parseWork('https://x.com/kururu/status/2107425650722082924', {
      twitterAuth: FAKE_AUTH, twitterCt0: FAKE_CT0, importProxy: '', timeout: 5000,
      onProgress: () => {}
    });
    assert.equal(r.images.length, 2);
    const g = seen.find(s => s.url.includes('/i/api/graphql/'));
    assert.ok(g, '必须发出 GraphQL 请求');
    assert.ok(g.url.includes('/' + QID + '/TweetResultByRestId'), 'queryId 必须在 URL 中');
    assert.ok(g.url.includes(encodeURIComponent('{"tweetId":"2107425650722082924"')), 'variables 必须含 tweetId');
    assert.match(g.headers.authorization, new RegExp('^' + BEARER_PREFIX));
    assert.equal(g.headers['x-csrf-token'], FAKE_CT0);
    assert.ok(g.headers.cookie.includes('auth_token=' + FAKE_AUTH) && g.headers.cookie.includes('ct0=' + FAKE_CT0));
    // 媒体 URL 加 name=orig
    assert.ok(r.images[0].name.includes('X-受限推文测试图-') || r.images[0].name.startsWith('X-'));
  } finally {
    global.fetch = origFetch; undici.fetch = origUfetch;
  }
});

test('TweetWithVisibilityResults：媒体在 result.tweet.legacy 嵌套层', async () => {
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    if (url.includes('/i/api/graphql/')) return gqlResponse(gqlPayload(null, true));
    if (url.includes('pbs.twimg.com/media/')) return imgResponse();
    return { ok: true, status: 200, json: async () => syndNoMedia };
  };
  const undici = require('undici');
  const origUfetch = undici.fetch; const origFetch = global.fetch;
  undici.fetch = fakeFetch; global.fetch = fakeFetch;
  try {
    const r = await parseWork('https://x.com/kururu/status/2107425650722082924', {
      twitterAuth: FAKE_AUTH, twitterCt0: FAKE_CT0, importProxy: '', timeout: 5000, onProgress: () => {}
    });
    assert.equal(r.images.length, 2, '受限可见推文必须从嵌套层取到两张图');
  } finally { undici.fetch = origUfetch; global.fetch = origFetch; }
});

test('TweetTombstone + syndication 也无图：报受限文案（不误报成功）', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('/i/api/graphql/')) return gqlResponse({ data: { tweetResult: { result: { __typename: 'TweetTombstone' } } } });
    return { ok: true, status: 200, json: async () => syndNoMedia };
  };
  const undici = require('undici');
  const origUfetch = undici.fetch; const origFetch = global.fetch;
  undici.fetch = fakeFetch; global.fetch = fakeFetch;
  try {
    await assert.rejects(
      parseWork('https://x.com/kururu/status/2107425650722082924', {
        twitterAuth: FAKE_AUTH, twitterCt0: FAKE_CT0, importProxy: '', timeout: 5000, onProgress: () => {}
      }),
      e => e instanceof ImportError && /未找到图片|受限/.test(e.message)
    );
  } finally { undici.fetch = origUfetch; global.fetch = origFetch; }
});

test('401/403：凭据失效文案直接抛出（不落 syndication 掩盖）', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('/i/api/graphql/')) return { ok: false, status: 403, json: async () => ({}) };
    throw new Error('should not reach syndication');
  };
  const undici = require('undici');
  const origUfetch = undici.fetch; const origFetch = global.fetch;
  undici.fetch = fakeFetch; global.fetch = fakeFetch;
  try {
    await assert.rejects(
      parseWork('https://x.com/kururu/status/2107425650722082924', {
        twitterAuth: FAKE_AUTH, twitterCt0: FAKE_CT0, importProxy: '', timeout: 5000, onProgress: () => {}
      }),
      e => e instanceof ImportError && /凭据失效/.test(e.message)
    );
  } finally { undici.fetch = origUfetch; global.fetch = origFetch; }
});

test('无凭据：不发 GraphQL（走 syndication 现状）', async () => {
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({ __typename: 'TweetTombstone', tombstone: {} }) };
  };
  const undici = require('undici');
  const origUfetch = undici.fetch; const origFetch = global.fetch;
  undici.fetch = fakeFetch; global.fetch = fakeFetch;
  try {
    await assert.rejects(
      parseWork('https://x.com/kururu/status/2107425650722082924', { twitterAuth: '', twitterCt0: '', importProxy: '', timeout: 5000, onProgress: () => {} }),
      ImportError
    );
    assert.ok(seen.every(u => !u.includes('/i/api/graphql/')), '无凭据不得发 GraphQL');
  } finally { undici.fetch = origUfetch; global.fetch = origFetch; }
});
