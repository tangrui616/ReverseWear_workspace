const MAX_DURATION = 999 * 3600000 + 59 * 60000 + 59000;
export class Countdown {
  constructor(saved = {}, now = () => Date.now()) {
    if (!saved || typeof saved !== 'object') saved = {};
    this.now = now;
    this.mode = saved.mode === 'deadline' ? 'deadline' : 'duration';
    this.total = Number.isFinite(saved.total) && saved.total > 0 && saved.total <= MAX_DURATION ? saved.total : 1500000;
    this.remaining = Number.isFinite(saved.remaining) ? Math.max(0, Math.min(saved.remaining, this.total)) : this.total;
    this.deadline = Number.isFinite(saved.deadline) ? saved.deadline : 0;
    this.endAt = Number.isFinite(saved.endAt) ? saved.endAt : 0;
    this.running = saved.running === true && this.endAt > 0;
    this.completed = saved.completed === true;
    this.tick();
  }
  setDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > MAX_DURATION) throw new Error('请设置大于 0 的时长，最长 999 小时 59 分 59 秒。');
    Object.assign(this, { mode: 'duration', total: milliseconds, remaining: milliseconds, running: false, completed: false, endAt: 0, deadline: 0 });
  }
  setDeadline(timestamp) {
    const duration = timestamp - this.now();
    if (!Number.isFinite(timestamp) || duration <= 0 || duration > MAX_DURATION) throw new Error('请选择未来的截止时间，距离现在不超过 999 小时。');
    Object.assign(this, { mode: 'deadline', total: duration, remaining: duration, running: true, completed: false, endAt: timestamp, deadline: timestamp });
  }
  toggle() {
    this.tick();
    if (this.running) { this.running = false; return; }
    if (this.completed || this.remaining <= 0) this.reset();
    if (this.mode === 'deadline' && this.deadline <= this.now()) throw new Error('截止时间已到，请重新选择时间。');
    this.endAt = this.mode === 'deadline' ? this.deadline : this.now() + this.remaining;
    this.running = true;
    this.completed = false;
    this.tick();
  }
  reset() {
    this.running = false; this.completed = false; this.endAt = 0;
    this.remaining = this.mode === 'deadline' ? Math.max(0, this.deadline - this.now()) : this.total;
  }
  tick() {
    if (!this.running) return false;
    this.remaining = Math.max(0, this.endAt - this.now());
    if (this.remaining === 0) { this.running = false; this.completed = true; return true; }
    return false;
  }
  serialize() { return { mode: this.mode, total: this.total, remaining: this.remaining, deadline: this.deadline, endAt: this.endAt, running: this.running, completed: this.completed }; }
}
export function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const last = String(seconds % 60).padStart(2, '0');
  return hours ? [String(hours).padStart(2, '0'), String(minutes).padStart(2, '0'), last] : [String(minutes).padStart(2, '0'), last];
}
