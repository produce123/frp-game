/*
 * 不让 IDM / 迅雷这类下载器把游戏音频抓走。
 *
 * 现象：页面用 `new Audio('.../1m.mp3')` 或 `fetch('.../bg.ogg')` 播声音时，
 * IDM 的浏览器插件会把 URL 里的 `.mp3/.ogg/.wav` 当成"可下载媒体"，
 * 每次打开游戏都往"下载"文件夹塞几十个音效文件（用户实测 2000+ 个）。
 *
 * 做法：把**同源、路径以音频扩展名结尾**的 URL 去掉扩展名再请求
 * （`/mahjong/audio/1m.mp3` → `/mahjong/audio/1m`）；服务器会把无扩展名路径
 * 映射回真实文件，并按真实扩展名发 `audio/*`。URL 里没有媒体扩展名，
 * 下载器就不再认领这些请求。
 *
 * 覆盖：fetch / XMLHttpRequest / `new Audio()` / `HTMLMediaElement.src` /
 * `setAttribute('src', ...)`。只动音频扩展名，图片、脚本、页面都不碰。
 * 以后的新游戏只要入口页引一下这个脚本（或由 server/http.mjs 注入）就自动生效。
 */
(function () {
  'use strict';

  var MEDIA_RE = /\.(mp3|ogg|wav|m4a|aac|flac)$/i;

  /** 同源 + 音频扩展名 → 去掉扩展名；其它原样返回。 */
  function fix(value) {
    if (typeof value !== 'string' || !value) return value;
    var url;
    try {
      url = new URL(value, window.location.href);
    } catch {
      return value;
    }
    if (url.origin !== window.location.origin) return value;
    if (!MEDIA_RE.test(url.pathname)) return value;
    url.pathname = url.pathname.replace(MEDIA_RE, '');
    return url.href;
  }

  // fetch
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      if (typeof input === 'string' || input instanceof URL) {
        input = fix(String(input));
      } else if (typeof Request !== 'undefined' && input instanceof Request) {
        var fixed = fix(input.url);
        if (fixed !== input.url) {
          try {
            input = new Request(fixed, input);
          } catch {
            /* body 已被读过的 Request 无法重建，保持原样 */
          }
        }
      }
      return nativeFetch.call(this, input, init);
    };
  }

  // XMLHttpRequest（有些老游戏用它取音频）
  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype.open) {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = fix(url);
      return nativeOpen.apply(this, args);
    };
  }

  // new Audio(src)
  var NativeAudio = window.Audio;
  if (typeof NativeAudio === 'function') {
    class FrpAudio extends NativeAudio {
      constructor(src) {
        super(src === undefined ? undefined : fix(src));
      }
    }
    window.Audio = FrpAudio;
  }

  // audio.src = '...'（含 cloneNode 之后设置 src 的写法）
  if (typeof HTMLMediaElement !== 'undefined') {
    var srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (srcDesc && srcDesc.set && srcDesc.configurable) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: srcDesc.enumerable,
        get: srcDesc.get,
        set: function (value) {
          srcDesc.set.call(this, fix(value));
        },
      });
    }
    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (String(name).toLowerCase() === 'src') value = fix(value);
      return nativeSetAttribute.call(this, name, value);
    };
  }

  window.FrpNoIdm = { fix: fix };
})();