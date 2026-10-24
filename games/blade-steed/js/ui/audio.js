/**
 * BladeSteed — 音效（WebAudio 现场合成）
 *
 * 一个音频文件都不加载：全部用振荡器 + 噪声现场合成。
 * 好处是零请求、零体积、离线也能响，坏处是音色朴素 —— 但这是个聚会小游戏，
 * 清晰、短促、不刺耳比音色重要。
 *
 * AudioContext 必须等用户第一次点击才能创建（浏览器自动播放策略），
 * 所以这里是懒初始化，没点过之前 play() 直接返回。
 */

export class AudioKit {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
  }

  /** 第一次用户手势时调用一次即可 */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.28;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  /** 一个短音：频率、时长、波形、音量 */
  tone({ freq = 440, to = null, dur = 0.12, type = 'sine', gain = 0.5, delay = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 噪声脉冲：撞击、碎裂、鼓掌之类 */
  noise({ dur = 0.14, gain = 0.4, lp = 2600, hp = 200, delay = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const lowpass = this.ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = lp;
    const highpass = this.ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = hp;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(highpass).connect(lowpass).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /**
   * 播放一个音效。
   * @param {'click'|'pick'|'reveal'|'win'|'lose'|'buy'|'slash'|'kick'|'hurt'|'down'|'tick'|'turn'} name
   */
  play(name) {
    if (!this.enabled) return;
    if (!this.ctx) this.unlock();
    if (!this.ctx) return;
    switch (name) {
      case 'click':
        this.tone({ freq: 620, to: 420, dur: 0.06, type: 'triangle', gain: 0.28 });
        break;
      case 'pick':
        this.tone({ freq: 880, to: 1180, dur: 0.09, type: 'triangle', gain: 0.3 });
        break;
      case 'reveal':
        this.tone({ freq: 520, dur: 0.1, type: 'square', gain: 0.16 });
        this.tone({ freq: 780, dur: 0.12, type: 'square', gain: 0.14, delay: 0.09 });
        break;
      case 'win':
        [523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.3, delay: i * 0.1 }));
        break;
      case 'lose':
        [392, 330, 262].forEach((f, i) => this.tone({ freq: f, dur: 0.3, type: 'sine', gain: 0.3, delay: i * 0.13 }));
        break;
      case 'buy':
        this.tone({ freq: 1046, to: 1568, dur: 0.1, type: 'triangle', gain: 0.3 });
        this.tone({ freq: 1568, dur: 0.12, type: 'sine', gain: 0.2, delay: 0.08 });
        break;
      case 'slash':
        this.noise({ dur: 0.1, gain: 0.42, lp: 7000, hp: 1400 });
        this.tone({ freq: 1600, to: 500, dur: 0.09, type: 'sawtooth', gain: 0.16 });
        break;
      case 'kick':
        this.noise({ dur: 0.18, gain: 0.5, lp: 900, hp: 60 });
        this.tone({ freq: 180, to: 60, dur: 0.2, type: 'sine', gain: 0.45 });
        break;
      case 'hurt':
        this.tone({ freq: 300, to: 150, dur: 0.16, type: 'square', gain: 0.24 });
        break;
      case 'down':
        this.noise({ dur: 0.3, gain: 0.42, lp: 1200, hp: 80 });
        this.tone({ freq: 240, to: 70, dur: 0.42, type: 'sawtooth', gain: 0.28 });
        break;
      case 'tick':
        this.tone({ freq: 1200, dur: 0.03, type: 'square', gain: 0.12 });
        break;
      case 'turn':
        this.tone({ freq: 660, to: 990, dur: 0.1, type: 'triangle', gain: 0.22 });
        break;
      default:
        break;
    }
  }
}