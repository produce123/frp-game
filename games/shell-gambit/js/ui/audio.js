/**
 * Shell Gambit — 音效
 *
 * 全部用 WebAudio 现场合成，不加载任何音频文件：
 *  · 零额外请求，GitHub Pages 上开箱即用
 *  · 体积极小，不会因为加载失败而报错
 *
 * 浏览器要求音频必须由用户手势触发，所以第一次点击时才创建 AudioContext。
 *
 * 【开关的值存在哪里（这里改过一次，别改回去）】
 * 以前这个文件自己存了一个 `sg.sound`，而平台设置栏里那个总开关存的是**平台那一份** ——
 * 于是两边打架：平台里关着、进游戏却还响（或者反过来），用户点名说不行。
 * 现在**唯一的一份**是 `FrpUI.prefs`（`shared/ui/ui.js`，localStorage 的 `frp.prefs`）：
 * 这里只**读**它、改的时候**写回**它，自己一个键都不存。老键 `sg.sound` 由平台在第一次
 * 读偏好时迁移（见 shared/ui/ui.js 的 LEGACY），所以老玩家的设置不会丢。
 *
 * ⚠️ `enabled` 这个语义一个字都没变（**一个音都不许发出来**时它为 false）：
 *    每个 play() 的第一行就是 `if (!this.enabled) return;`，
 *    而"必须先点一下才建 AudioContext"的解锁机制也照旧（ensure() 里那一套）。
 */
const prefs = () => (globalThis.FrpUI && globalThis.FrpUI.prefs) || null;

/** 平台那一份偏好里"音效开着吗"。拿不到偏好对象（脚本没加载）时当成开着。 */
const prefSoundOn = () => {
  const p = prefs();
  return p ? !!p.sound() : true;
};

class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    // 音效开关由玩家自己决定，值存在**平台那一份偏好**里（不是本文件自己存）
    this.enabled = prefSoundOn();
  }

  /** 开/关音效。**写回平台那一份偏好**（不再自己存 sg.sound）。 */
  setEnabled(on) {
    this.enabled = !!on;
    const p = prefs();
    if (p) p.setSound(this.enabled);
    if (on) {
      this.ensure();
      this.play('click');
    }
  }

  /**
   * 平台那边改了偏好之后，把值**同步**进来（app.js 的 `bindPrefs()` 订阅时调）。
   * ⚠️ 它**不写回** prefs（订阅回调再写回就成了转圈），也不出声。
   */
  syncPrefs(on) {
    this.enabled = !!on;
  }

  /** 延迟创建 AudioContext（必须在用户手势里调用） */
  ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        this.enabled = false;
        return null;
      }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.3;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** 一段简单的正弦/方波音 */
  tone({ freq = 440, to = null, dur = 0.12, type = 'sine', gain = 0.5, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    // 短促的淡入淡出，避免爆音
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 一段过滤后的噪声（枪声、破壳声等） */
  noise({ dur = 0.18, gain = 0.5, freq = 1200, to = 300, q = 1, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  play(name) {
    if (!this.enabled) return;
    try {
      switch (name) {
        case 'click': // 普通点击
          this.tone({ freq: 720, dur: 0.05, type: 'square', gain: 0.16 });
          break;
        case 'tap':
          this.tone({ freq: 420, dur: 0.06, type: 'triangle', gain: 0.2 });
          break;
        case 'card': // 出牌
          this.tone({ freq: 900, to: 1300, dur: 0.1, type: 'triangle', gain: 0.22 });
          this.noise({ dur: 0.06, gain: 0.1, freq: 3000, to: 1500 });
          break;
        case 'shoot': // 实弹
          this.noise({ dur: 0.3, gain: 0.7, freq: 1800, to: 120, q: 0.7 });
          this.tone({ freq: 120, to: 45, dur: 0.28, type: 'sine', gain: 0.55 });
          break;
        case 'saw': // 手锯
          this.noise({ dur: 0.32, gain: 0.24, freq: 2600, to: 900, q: 3 });
          break;
        case 'blank': // 空弹：干脆的"咔"
          this.tone({ freq: 1400, dur: 0.03, type: 'square', gain: 0.2 });
          this.tone({ freq: 300, dur: 0.05, type: 'square', gain: 0.16, delay: 0.03 });
          break;
        case 'heal': // 回血
          this.tone({ freq: 520, to: 780, dur: 0.16, type: 'sine', gain: 0.28 });
          this.tone({ freq: 780, dur: 0.12, type: 'sine', gain: 0.2, delay: 0.13 });
          break;
        case 'info': // 放大镜
          this.tone({ freq: 1000, dur: 0.09, type: 'sine', gain: 0.2 });
          this.tone({ freq: 1400, dur: 0.11, type: 'sine', gain: 0.16, delay: 0.08 });
          break;
        case 'invert': // 逆转器
          this.tone({ freq: 300, to: 900, dur: 0.2, type: 'triangle', gain: 0.24 });
          break;
        case 'cuff': // 手铐
          this.noise({ dur: 0.1, gain: 0.3, freq: 4200, to: 2000, q: 4 });
          this.tone({ freq: 180, dur: 0.09, type: 'square', gain: 0.2, delay: 0.04 });
          break;
        case 'hurt': // 掉血
          this.tone({ freq: 320, to: 110, dur: 0.24, type: 'sawtooth', gain: 0.3 });
          break;
        case 'throw': // 扔出去
          this.noise({ dur: 0.22, gain: 0.16, freq: 700, to: 2400, q: 1.2 });
          break;
        case 'splat': // 砸中
          this.noise({ dur: 0.14, gain: 0.32, freq: 900, to: 180, q: 0.8 });
          break;
        case 'boom': // 绽放
          this.tone({ freq: 1600, to: 2600, dur: 0.16, type: 'sine', gain: 0.18 });
          break;
        case 'win': // 胜利
          [523, 659, 784, 1046].forEach((f, i) =>
            this.tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.26, delay: i * 0.11 })
          );
          break;
        case 'lose':
          [400, 330, 260].forEach((f, i) =>
            this.tone({ freq: f, dur: 0.26, type: 'sine', gain: 0.24, delay: i * 0.13 })
          );
          break;
        case 'round': // 换弹
          this.tone({ freq: 240, dur: 0.08, type: 'square', gain: 0.2 });
          this.tone({ freq: 300, dur: 0.1, type: 'square', gain: 0.18, delay: 0.12 });
          break;
        default:
          this.tone({ freq: 600, dur: 0.05, type: 'sine', gain: 0.15 });
      }
    } catch {
      /* 音效失败绝不能影响游戏 */
    }
  }
}

export const sfx = new Sfx();

/** 给所有按钮加统一的点击音 */
export function bindClickSounds(root = document) {
  root.addEventListener(
    'pointerdown',
    (e) => {
      const btn = e.target.closest('button');
      if (btn && !btn.disabled) sfx.play('click');
    },
    { passive: true }
  );
}