/*
 * 音效 —— WebAudio 现场合成，不带任何音频文件（平台约定，见 docs/GAME-SPEC.md 第 2 节）。
 *
 * 【enabled 这个开关是必须的】
 * 平台硬指标要求每个游戏都有"音效 / 特效"两个开关，值存在**平台那一份**偏好里
 * （`FrpUI.prefs`，见 docs/GAME-SPEC.md §7）。开关一关，**一个音都不许发出来** ——
 * 所以每个 playXxx() 的第一行都是 `if (!this.enabled) return;`。
 * 别把开关只做在界面上：按钮变色而声音照旧，是最招人烦的一种假开关。
 *
 * ⚠️ 开关的值由 js/ui/app.js 的 applyPrefs() 写进来（值来自 `FrpUI.prefs`，
 * 本作自己不再存 `cg.sound`），而且同一个值还会交给平台层：
 * FrpReact.setSound(on)（扔鸡蛋/鲜花的声音也归它管）。
 */
const AudioManager = {
  ctx: null,
  /** 音效开关。false 时所有 playXxx() 直接返回（不建 AudioContext、不出声）。 */
  enabled: true,

  init() {
    if (!this.enabled) return;
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  },

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  },

  /**
   * 走子（落子）音 —— **回放那一步**响。
   * 由 js/ui/app.js 的 playStepSound() 在演每一手时调（不吃子就是它）。
   */
  playMove() {
    if (!this.enabled) return;
    this.init();
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.08);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    osc.start(now);
    osc.stop(now + 0.1);
  },

  /**
   * 吃子音 —— **只有真吃到子那一步**响（大炮隔着恰好一个空格跳吃）。
   *
   * 由 js/ui/app.js 的 playStepSound() 调：那一步的 `capturedPiece` 不为空才响，
   * 空走一步响的是 playMove()，所以绝不会"走一步也轰一声"。
   * 两个振荡器叠出来的下坠闷响（锯齿 300→100Hz + 方波 150→50Hz），共 0.4 秒。
   * ⚠️ 这段合成音曾经在改成"逐步演出"时被漏接（用户反馈"就是没有吃子的声音了"）——
   * 别再把调用点删掉了。
   */
  playCapture() {
    if (!this.enabled) return;
    this.init();
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(300, now);
    osc1.frequency.exponentialRampToValueAtTime(100, now + 0.3);
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc1.start(now);
    osc1.stop(now + 0.3);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(150, now + 0.05);
    osc2.frequency.exponentialRampToValueAtTime(50, now + 0.4);
    gain2.gain.setValueAtTime(0.15, now + 0.05);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
    osc2.start(now + 0.05);
    osc2.stop(now + 0.4);
  },

  playSelect() {
    if (!this.enabled) return;
    this.init();
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(500, now);
    osc.frequency.exponentialRampToValueAtTime(700, now + 0.06);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

    osc.start(now);
    osc.stop(now + 0.08);
  },

  playWin() {
    if (!this.enabled) return;
    this.init();
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.15);
      gain.gain.setValueAtTime(0.25, now + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.15 + 0.3);
      osc.start(now + i * 0.15);
      osc.stop(now + i * 0.15 + 0.3);
    });
  },

  playLose() {
    if (!this.enabled) return;
    this.init();
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const notes = [400, 350, 300, 200];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.2);
      gain.gain.setValueAtTime(0.2, now + i * 0.2);
      gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.2 + 0.35);
      osc.start(now + i * 0.2);
      osc.stop(now + i * 0.2 + 0.35);
    });
  },

  playClick() {
    if (!this.enabled) return;
    this.init();
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1000, now);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);
    osc.start(now);
    osc.stop(now + 0.04);
  }
};

/*
 * 第一次用户手势时把 AudioContext 建起来（浏览器的自动播放策略要求）。
 * ⚠️ 音效关着的时候**不要**建：省一个常驻的音频线程，也让"关了就是关了"更实在。
 * 之后用户把开关打开，第一次 playXxx() 会在这条路之外自己 lazy init。
 */
document.addEventListener('click', () => AudioManager.init(), { once: true });
