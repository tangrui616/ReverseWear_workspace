const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0))

export function createStartupSfx(config, { night = () => false } = {}) {
  let context = null
  let master = null

  function getContext() {
    if (!context) {
      try {
        context = new (window.AudioContext || window.webkitAudioContext)()
        master = context.createGain()
        master.connect(context.destination)
      } catch {
        return null
      }
    }
    master.gain.value = clamp(config.sfxVolume, 0, 1) * 0.6
    return context
  }

  function tone(frequency, duration, type = 'sine', gain = 0.2, delay = 0, endFrequency = 0) {
    const audio = getContext()
    if (!audio || !config.sfx || audio.state !== 'running') return
    const start = audio.currentTime + delay
    const oscillator = audio.createOscillator()
    const volume = audio.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, start)
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration)
    volume.gain.setValueAtTime(0, start)
    volume.gain.linearRampToValueAtTime(gain, start + 0.012)
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    oscillator.connect(volume)
    volume.connect(master)
    oscillator.start(start)
    oscillator.stop(start + duration + 0.05)
  }

  function noise(duration, gain = 0.12, delay = 0, low = 400, high = 4000) {
    const audio = getContext()
    if (!audio || !config.sfx || audio.state !== 'running') return
    const start = audio.currentTime + delay
    const length = Math.ceil(audio.sampleRate * duration)
    const buffer = audio.createBuffer(1, length, audio.sampleRate)
    const samples = buffer.getChannelData(0)
    for (let index = 0; index < length; index += 1) samples[index] = Math.random() * 2 - 1
    const source = audio.createBufferSource()
    const filter = audio.createBiquadFilter()
    const volume = audio.createGain()
    source.buffer = buffer
    filter.type = 'bandpass'
    filter.Q.value = 1.2
    filter.frequency.setValueAtTime(low, start)
    filter.frequency.exponentialRampToValueAtTime(high, start + duration)
    volume.gain.setValueAtTime(0, start)
    volume.gain.linearRampToValueAtTime(gain, start + duration * 0.6)
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    source.connect(filter)
    filter.connect(volume)
    volume.connect(master)
    source.start(start)
  }

  return {
    resume() {
      const audio = getContext()
      if (audio && audio.state !== 'running') audio.resume().catch(() => {})
    },
    rise() {
      if (night()) {
        tone(110, 1.6, 'sine', 0.22, 0, 220)
        tone(165, 1.6, 'sine', 0.1, 0.05, 330)
      } else {
        tone(220, 1.4, 'sine', 0.18, 0, 440)
        tone(660, 1.2, 'triangle', 0.05, 0.2)
      }
    },
    sweep() { noise(0.55, 0.14, 0, night() ? 300 : 800, night() ? 1800 : 6000) },
    step() { tone(night() ? 392 : 784, 0.45, 'sine', 0.12) },
    confirm() {
      const base = night() ? 440 : 880
      tone(base, 0.35, 'sine', 0.14)
      tone(base * 1.5, 0.5, 'sine', 0.1, 0.08)
    },
    close() {
      const base = night() ? 220 : 523.25
      ;[1, 1.25, 1.5, 2].forEach((multiplier, index) => tone(base * multiplier, 1.6, 'sine', 0.1, index * 0.07))
      noise(0.9, 0.06, 0.05, 2000, 300)
    },
    dispose() {
      if (context && context.state !== 'closed') context.close().catch(() => {})
      context = null
      master = null
    }
  }
}
