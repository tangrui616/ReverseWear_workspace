/* ==========================================================================
 * voice-asset.mjs — 开屏语音素材播放器（交互语音片段）
 * --------------------------------------------------------------------------
 * 用法：
 *   import { createAssetVoice } from './voice-asset.mjs'
 *   const VO = createAssetVoice({ baseUrl: './startup/voice/', volume: 0.9 })
 *   VO.preload()
 *   const ms = await VO.line('wake')   // ≥0：语音实际用时（到“话说完”为止，混响尾音继续响）
 *                                       //  -1：素材不可用 / 被拦截，调用方可保持静音
 * 规则：
 *   - 句子排队，从不掐断上一句（只有 stop() 会停）
 *   - Promise 在“话说完”(speechEndMs) 时 resolve，混响尾音自然延续到下一句里
 *   - 每句前可选一声 cue 提示音（提前 leadMs 响起）
 *   - 加载失败、被浏览器拦截、超时，都不会卡死：resolve -1 或按时长兜底
 * ========================================================================== */

/* 由运行目录 manifest.json 校验；欢迎语采用裁切后的 WAV。 */
export const VOICE_MANIFEST = {
  "lines": {
    "wake": {
      "file": "line-1.mp3",
      "durationMs": 1960,
      "speechEndMs": 1960,
      "text": "Access permission required."
    },
    "identity": {
      "file": "line-2.mp3",
      "durationMs": 1160,
      "speechEndMs": 1160,
      "text": "Identity verification."
    },
    "mount": {
      "file": "line-3.mp3",
      "durationMs": 1070,
      "speechEndMs": 1070,
      "text": "Access request received."
    },
    "load": {
      "file": "line-4.mp3",
      "durationMs": 1180,
      "speechEndMs": 1180,
      "text": "Beginning permission read."
    },
    "verified": {
      "file": "line-5.mp3",
      "durationMs": 1700,
      "speechEndMs": 1700,
      "text": "Read complete. Verification passed."
    },
    "welcome": {
      "file": "line-6.wav",
      "durationMs": 1470,
      "speechEndMs": 1410,
      "text": "Welcome to you."
    }
  },
  "cue": {
    "file": "cue.ogg",
    "master": "cue.wav",
    "durationMs": 420,
    "leadMs": 150
  }
}

/** 业务步骤 → 素材 id */
export const VOICE_KEYS = {
  wake: 'wake',
  identity: 'identity',
  mount: 'mount',
  load: 'load',
  verified: 'verified',
  welcome: 'welcome'
}

export function createAssetVoice({ baseUrl = './startup/voice/', volume = 0.9, cue = true, meter = null } = {}) {
  const M = VOICE_MANIFEST
  const pool = new Map()
  const live = new Set()
  let chain = Promise.resolve()
  let stopped = false

  const setMeter = on => { if (meter) meter.classList.toggle('on', !!on) }
  function audio(file) {
    let a = pool.get(file)
    if (!a) { a = new Audio(baseUrl + file); a.preload = 'auto'; pool.set(file, a) }
    return a
  }
  /** 播放一个文件；如果播放请求挂起或被拒绝，限时返回 false。 */
  function start(file, vol) {
    if (stopped) return Promise.resolve(false)
    const a = audio(file)
    try { a.pause(); a.currentTime = 0 } catch (e) {}
    a.volume = Math.max(0, Math.min(1, Number(vol) || 0))
    live.add(a)
    let timeout
    let playPromise
    try { playPromise = a.play() } catch { live.delete(a); return Promise.resolve(false) }
    const attempt = playPromise && typeof playPromise.then === 'function'
      ? playPromise.then(() => true, () => false)
      : Promise.resolve(true)
    return Promise.race([
      attempt,
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 1800) })
    ]).then(ok => {
      clearTimeout(timeout)
      if (!ok || stopped) {
        live.delete(a)
        try { a.pause(); a.currentTime = 0 } catch (e) {}
        return false
      }
      return true
    })
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

  async function playLine(id) {
    const L = M.lines[id]
    if (!L || stopped) return -1
    const t0 = performance.now()
    if (cue && M.cue) {
      const ok = await start(M.cue.file, volume * 0.8)
      if (ok) await wait(M.cue.leadMs)
    }
    if (stopped) return -1
    const ok = await start(L.file, volume)
    if (!ok) return -1                                  // 素材无法开始播放时，跳过这一句
    setMeter(true)
    const a = audio(L.file)
    /* 到“话说完”就放行；音频元素卡住时按清单时长兜底 */
    const outcome = await new Promise(resolve => {
      let settled = false
      const settle = result => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        a.removeEventListener('ended', onEnded)
        a.removeEventListener('error', onError)
        resolve(result)
      }
      const onEnded = () => settle('ended')
      const onError = () => settle('error')
      const timer = setTimeout(() => settle('speech-end'), L.speechEndMs)
      a.addEventListener('ended', onEnded, { once: true })
      a.addEventListener('error', onError, { once: true })
    })
    setMeter(false)
    live.delete(a)
    return stopped || outcome === 'error' ? -1 : Math.round(performance.now() - t0)
  }

  return {
    manifest: M,
    /** 预加载全部素材（开屏一挂载就调用） */
    preload() { Object.values(M.lines).forEach(l => audio(l.file).load()); if (M.cue) audio(M.cue.file).load() },
    /** 念一句（key 用 VOICE_KEYS 的键名，或直接用素材 id）；排队执行，不打断上一句 */
    line(key) {
      const id = VOICE_KEYS[key] || key
      const run = chain.then(() => playLine(id))
      chain = run.catch(() => -1)
      return run
    },
    /** 第一次用户手势后调用一次：预热（Electron 打开 autoplayPolicy 时可以不调） */
    unlock() {
      const file = M.cue ? M.cue.file : Object.values(M.lines)[0].file
      const warmup = new Audio(baseUrl + file)
      warmup.volume = 0
      const release = () => {
        try { warmup.pause(); warmup.removeAttribute('src'); warmup.load() } catch (e) {}
      }
      try {
        const playback = warmup.play()
        if (playback && typeof playback.then === 'function') playback.then(release, release)
        else release()
      } catch { release() }
    },
    setVolume(v) { volume = v },
    setCue(on) { cue = !!on },
    /** 只有「跳过」和「揭幕结束」调用 */
    stop() {
      stopped = true
      const players = new Set([...pool.values(), ...live])
      players.forEach(a => {
        try { a.pause(); a.removeAttribute('src'); a.load() } catch (e) {}
      })
      live.clear()
      pool.clear()
      setMeter(false)
    }
  }
}
