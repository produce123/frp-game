const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/main-5VdM8zCl.js","assets/platformAccount-DeArrWH5.js","assets/platformAccount-B1CDsOdc.css","assets/sound-8k0_OVw5.js","assets/quality-u8pQUhPE.js","assets/platform-j81mZcj9.js","assets/sound-Z1VqUxd2.css","assets/main-BTsYyABb.css"])))=>i.map(i=>d[i]);
import{o as e,r as t,t as n}from"./brand-CjVdkeHi.js";import{f as r,n as i,r as a}from"./platformAccount-DeArrWH5.js";import{f as o,n as s}from"./platform-j81mZcj9.js";var c=`<!-- 顶条与信息栏由 shell/plain.html 填入。 -->\r
<div id="obs-view" hidden>\r
  <header id="topbar" class="page-topbar"></header>\r
  <div id="obs-main">\r
    <div id="map"></div>\r
    <div\r
      id="info-resizer"\r
      role="separator"\r
      aria-orientation="vertical"\r
      aria-label="调整村民信息栏宽度"\r
      aria-controls="info-panel"\r
      title="拖动调整宽度；双击恢复默认宽度"\r
      tabindex="0"\r
      hidden\r
    ></div>\r
    <aside id="info-panel" class="collapsed" hidden></aside>\r
  </div>\r
  <footer id="event-bar">\r
    <div id="event-latest">\r
      <span id="event-latest-text">暂无事件</span>\r
      <button id="event-latest-dismiss" title="不再停在这条重要事件上" hidden>关闭</button>\r
      <button id="event-expand">展开</button>\r
    </div>\r
    <div id="event-full" hidden>\r
      <div id="event-toolbar">\r
        <button class="event-filter on" data-f="all">全部</button>\r
        <button class="event-filter" data-f="speech">对话</button>\r
        <button class="event-filter" data-f="thought">想法</button>\r
        <button class="event-filter" data-f="important">重要</button>\r
        <label id="event-autoscroll-label">\r
          <input type="checkbox" id="event-autoscroll" checked /> 自动滚动\r
        </label>\r
        <span class="spacer" style="flex: 1"></span>\r
        <button id="event-collapse">收起</button>\r
      </div>\r
      <div id="event-list"></div>\r
    </div>\r
  </footer>\r
</div>\r
\r
<!-- 日志页：整页替换地图页，按天看执行记录与想法 -->\r
<div id="diary-view" class="page-view" hidden>\r
  <header id="diary-topbar" class="page-topbar">\r
    <button id="diary-back">← 返回地图</button>\r
    <span id="diary-title">日志</span>\r
    <span class="dim"\r
      >世界写的执行记录与村民自己的想法，按时间穿插；天头是村民次日早上写的「昨天」</span\r
    >\r
  </header>\r
  <div id="diary-body">\r
    <nav id="diary-nav"></nav>\r
    <main id="diary-page" class="dim">还没有日志</main>\r
  </div>\r
</div>\r
\r
<!-- 记忆页：独立读取居民摘要、主题及来源，不复用动作面板。 -->\r
<div id="memory-view" class="page-view" hidden>\r
  <header id="memory-topbar" class="page-topbar">\r
    <button id="memory-back">← 返回地图</button>\r
    <div class="memory-identity">\r
      <span id="memory-avatar" aria-hidden="true"></span>\r
      <div>\r
        <h1 id="memory-title">记忆</h1>\r
        <p id="memory-hint">经历、认识，以及它们的来处</p>\r
      </div>\r
    </div>\r
    <div id="memory-search-wrap">\r
      <label for="memory-search" class="nb-sr-only">搜索全部记忆与经历</label>\r
      <input\r
        id="memory-search"\r
        type="search"\r
        maxlength="200"\r
        placeholder="搜索记忆与经历"\r
        autocomplete="off"\r
      />\r
      <button id="memory-clear-search" aria-label="清除搜索" hidden>×</button>\r
    </div>\r
  </header>\r
  <main id="memory-page" class="dim">还没收到记忆</main>\r
</div>\r
\r
<!-- 消耗页：整页替换地图页。汇总、按人用量、最近 500 次请求台账；只读，每 2 秒刷新 -->\r
<div id="usage-view" class="page-view" hidden>\r
  <header id="usage-topbar" class="page-topbar">\r
    <button id="usage-back">← 返回地图</button>\r
    <span id="usage-title">消耗</span>\r
    <span class="dim">金额按服务商公布的价格估算，以服务商的账单为准</span>\r
    <span class="spacer"></span>\r
    <span id="usage-clock" class="dim"></span>\r
  </header>\r
  <main id="usage-page" class="dim">还没收到消耗数据</main>\r
</div>\r
\r
<!-- 书与公告：整页替换地图页。村民写的书、公告栏上的告示，玩家也能写书、贴公告；不暂停世界 -->\r
<div id="books-view" class="page-view" hidden>\r
  <header id="books-topbar" class="page-topbar">\r
    <button id="books-back">← 返回地图</button>\r
    <span id="books-title">书与公告</span>\r
    <span class="spacer"></span>\r
    <span id="books-clock" class="dim"></span>\r
  </header>\r
  <main id="books-page"></main>\r
</div>\r
\r
<!-- 村民页：整页替换地图页。名册、村民库、加入预览、人物创建；不暂停世界，人物只由服务器创建 -->\r
<div id="residents-view" class="page-view" hidden>\r
  <header id="residents-topbar" class="page-topbar">\r
    <button id="residents-back">← 返回地图</button>\r
    <span id="residents-title">村民</span>\r
    <div id="residents-tabs" class="ui-seg" role="tablist">\r
      <button class="rv-tab on" data-tab="roster" role="tab">村中居民</button>\r
      <button class="rv-tab" data-tab="library" role="tab">村民库</button>\r
    </div>\r
    <span class="spacer"></span>\r
    <span id="residents-clock" class="dim"></span>\r
  </header>\r
  <main id="residents-page"></main>\r
</div>\r
\r
<!-- 设定中心：整页替换地图页 -->\r
<div id="settings-view" class="page-view" hidden>\r
  <header id="settings-topbar" class="page-topbar">\r
    <button id="settings-back">← 返回地图</button>\r
    <span id="settings-title">设定</span>\r
    <span id="settings-paused">世界已暂停</span>\r
    <span id="settings-resume"></span>\r
  </header>\r
  <div id="settings-body">\r
    <nav id="settings-nav"></nav>\r
    <main id="settings-page"></main>\r
  </div>\r
  <footer id="settings-savebar" hidden>\r
    <span id="settings-savebar-hint">有未保存的修改</span>\r
    <button id="settings-discard">放弃</button>\r
    <button id="settings-save">保存</button>\r
  </footer>\r
</div>\r
\r
<main id="game-loading" class="entry-state" aria-live="polite">\r
  <h1 id="game-loading-title">正在进入小镇…</h1>\r
  <p id="game-loading-message">正在加载地图</p>\r
  <div class="entry-actions">\r
    <button id="game-retry" hidden>重新加载</button><a href="./">返回选择小镇</a>\r
  </div>\r
</main>\r
`;s(),t(),n(),document.body.innerHTML=c;var l=new URLSearchParams(location.search),u=l.get(`map`),d=l.get(`room`);if(!u)location.replace(new URL(`./`,location.href));else try{d&&await i(d),o(`game-loading-message`).textContent=`正在连接世界并准备画面`;let[t,{startGame:n}]=await Promise.all([e(u),a(()=>import(`./main-5VdM8zCl.js`),__vite__mapDeps([0,1,2,3,4,5,6,7]))]);o(`game-loading-message`).textContent=`正在读取地图与场景缓存`,await n(t),o(`game-loading`).hidden=!0,o(`obs-view`).hidden=!1}catch(e){o(`game-loading-title`).textContent=`小镇加载失败`,o(`game-loading-message`).textContent=e instanceof Error?r(e):`请重新加载，或返回小镇列表。`;let t=o(`game-retry`);t.hidden=!1,t.onclick=()=>location.reload()}