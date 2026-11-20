import { createStartupSfx } from './startup-sfx.mjs'
import { createStartupVoice, previewStartupVoice } from './startup-voice.mjs'

const STARTUP_DAY_KEY = 'stilltime.startup:day'
const TIMEOUT = Symbol('startup timeout')
const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0))
const wait = duration => new Promise(resolve => setTimeout(resolve, duration))

function isReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function localDay() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function callSafely(operation) {
  try {
    return Promise.resolve(typeof operation === 'function' ? operation() : operation)
  } catch (error) {
    return Promise.reject(error)
  }
}

function bounded(promise, timeoutMs = 15000) {
  let timeout
  return Promise.race([
    promise,
    new Promise(resolve => { timeout = setTimeout(() => resolve(TIMEOUT), timeoutMs) })
  ]).finally(() => clearTimeout(timeout))
}

function durationOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export { previewStartupVoice }

export function createStartupController({
  root,
  config,
  probe,
  loadState,
  identity,
  preview = false,
  onSkip = () => {},
  onComplete = () => {},
  onPhase = () => {}
}) {
  if (!(root instanceof Element)) throw new TypeError('Startup root element is required')

  const status = root.querySelector('#hud .st-status')
  const subtitle = root.querySelector('#hud .st-sub')
  const canvas = root.querySelector('canvas#c')
  const skipButton = root.querySelector('#st-skip')
  if (!status || !subtitle || !canvas || !skipButton) {
    throw new Error('Startup DOM is missing its subtitle HUD or canvas')
  }

  const settings = { ...config }
  const voice = createStartupVoice(settings)
  const sfx = createStartupSfx(settings, { night: () => root.classList.contains('night') })
  let stage = null
  let phase = 'idle'
  let waiting = null
  let finished = false
  let resolveCompletion
  const completion = new Promise(resolve => { resolveCompletion = resolve })
  let probePromise = Promise.resolve({ ok: false })
  let workspacePromise = Promise.resolve(undefined)
  let flightWatchdog = 0
  const unlockOnGesture = event => {
    if (finished || (event && skipButton.contains(event.target))) return
    voice.unlock()
    sfx.resume()
  }
  const onAudioSettingsChange = event => {
    const updated = event.detail || {}
    if (Number.isFinite(Number(updated.voiceVolume))) voice.setVolume(updated.voiceVolume)
    if (typeof updated.voiceCue === 'boolean') voice.setCue(updated.voiceCue)
  }

  function handleEarlyKey(event) {
    const activateSkip = event.target === skipButton && (event.key === 'Enter' || event.key === ' ')
    if ((event.key === 'Escape' || activateSkip) && !finished) {
      event.preventDefault()
      event.stopPropagation()
      skip()
    }
  }

  function setPhase(value) {
    phase = value
    root.dataset.phase = value
    onPhase(value)
  }

  function alive() {
    return !finished && !['leaving', 'done'].includes(phase)
  }

  function typeLine(element, value, delay, caret = false) {
    element.classList.remove('in')
    element.replaceChildren()
    const characters = [...value]
    element.style.setProperty('--st-character-count', Math.max(1, characters.length))
    for (const [index, character] of characters.entries()) {
      const span = document.createElement('span')
      span.className = 'ch'
      span.textContent = character === ' ' ? '\u00a0' : character
      span.style.transitionDelay = `${index * delay / clamp(settings.speed, 0.35, 3)}ms`
      element.append(span)
    }
    if (caret) {
      const cursor = document.createElement('i')
      cursor.className = 'st-caret'
      element.append(cursor)
    }
    void element.offsetWidth
    requestAnimationFrame(() => element.classList.add('in'))
  }

  function setStatus(chinese, english, caret = false) {
    typeLine(status, chinese, 80)
    typeLine(subtitle, english, 26, caret)
  }

  function clearStatus() {
    status.classList.remove('in')
    subtitle.classList.remove('in')
  }

  function applyGlass() {
    const dark = root.classList.contains('night')
    const glass = !!settings.glass
    root.style.setProperty('--a', glass ? clamp(settings.glassOpacity, 0.15, 0.95) : 1)
    root.style.setProperty('--gb', `${glass ? Math.min(clamp(settings.glassBlur, 0, 60), dark ? 36 : 60) : 0}px`)
    root.style.setProperty('--bb', `${glass ? Math.min(clamp(settings.backdropBlur, 0, 80), dark ? 40 : 80) : 0}px`)
    root.style.setProperty('--gs', `${clamp(settings.glassSaturate, 100, 200)}%`)
  }

  function onNightChanged() {
    applyGlass()
  }

  function sleepScaled(duration) {
    return wait(duration / clamp(settings.speed, 0.35, 3))
  }

  function waitForConfirmation() {
    if (!settings.requireConfirm) return sleepScaled(1800)
    root.classList.add('await')
    return new Promise(resolve => {
      waiting = () => {
        waiting = null
        root.classList.remove('await')
        sfx.confirm()
        resolve()
      }
    })
  }

  async function speak(key) {
    return bounded(voice.line(key), 15000)
  }

  function resolveIdentity(state) {
    return callSafely(identity || state?.startupIdentity).then(value => ({
      identity: [...String(value?.identity || '反穿衣')].slice(0, 24).join(''),
      identityId: String(value?.identityId || 'RW-0001'),
      accessLevel: String(value?.accessLevel || '研究员 · 3')
    }), () => ({ identity: '反穿衣', identityId: 'RW-0001', accessLevel: '研究员 · 3' }))
  }

  async function dissolve(duration) {
    const start = performance.now()
    const computed = getComputedStyle(root)
    const opacity = parseFloat(computed.getPropertyValue('--a')) || 1
    const glassBlur = parseFloat(computed.getPropertyValue('--gb')) || 0
    const backgroundBlur = parseFloat(computed.getPropertyValue('--bb')) || 0
    await Promise.race([new Promise(resolve => {
      function frame(now) {
        const progress = Math.min(1, (now - start) / duration)
        const eased = 1 - progress * progress * (3 - 2 * progress)
        root.style.setProperty('--a', (opacity * eased).toFixed(3))
        root.style.setProperty('--gb', `${(glassBlur * eased).toFixed(1)}px`)
        root.style.setProperty('--bb', `${(backgroundBlur * eased).toFixed(1)}px`)
        if (progress < 1) requestAnimationFrame(frame)
        else resolve()
      }
      requestAnimationFrame(frame)
    }), wait(duration + 250)])
  }

  async function finish(reason) {
    if (finished) return completion
    finished = true
    clearTimeout(flightWatchdog)
    setPhase('done')
    waiting = null
    voice.stop()
    sfx.dispose()
    stage?.dispose()
    window.removeEventListener('stilltime-startup-audio-settings-change', onAudioSettingsChange)
    document.removeEventListener('pointerdown', unlockOnGesture, true)
    skipButton.removeEventListener('click', skip)
    window.removeEventListener('keydown', handleEarlyKey, true)
    root.classList.remove('await', 'leaving')
    document.documentElement.classList.remove('startup-active')
    if (root.isConnected) root.remove()
    if (!preview && settings.mode === 'daily' && (reason === 'completed' || reason === 'skipped')) {
      try { localStorage.setItem(STARTUP_DAY_KEY, localDay()) } catch {}
    }
    try { onComplete(reason) } finally { resolveCompletion(reason) }
    return completion
  }

  async function welcome() {
    if (!alive()) return
    setPhase('leaving')
    const savedIdentity = await resolveIdentity(await workspacePromise)
    if (finished) return
    const identityName = savedIdentity.identity
    setStatus(`核验通过 · 欢迎 ${identityName}`, `VERIFIED · WELCOME, ${identityName.toUpperCase()}`)
    sfx.close()
    stage?.pulse()
    const closingVoice = speak('verified').then(() => finished || root.classList.contains('leaving') ? 0 : speak('welcome'))
    await sleepScaled(900)
    if (finished || root.classList.contains('leaving')) return
    if (finished) return
    status.classList.remove('st-glitch')
    void status.offsetWidth
    status.classList.add('st-glitch')
    await sleepScaled(700)
    if (finished || root.classList.contains('leaving')) return
    if (finished) return
    stage?.setCamRate(1.9)
    stage?.setCam({ radT: 6, polT: 1.56, azT: (stage.S?.az || 0) * 0.3 })
    await sleepScaled(1100)
    await closingVoice
    if (finished || root.classList.contains('leaving')) return
    if (finished) return
    root.classList.add('leaving')
    canvas.style.opacity = '0'
    await sleepScaled(950)
    if (finished) return
    if (finished) return
    await dissolve(900 / clamp(settings.speed, 0.35, 3))
    await finish('completed')
  }

  async function loadWorkspace() {
    setPhase('mount')
    setStatus('挂载数据根', 'MOUNTING DATA ROOT')
    sfx.step()
    const probeVoice = speak('mount')
    const [probeResult] = await Promise.all([
      probePromise, sleepScaled(1300), probeVoice.then(duration => wait(durationOrZero(duration) ? 240 : 0)),
    ])
    if (probeResult === TIMEOUT) return finish('timeout')
    if (!alive()) return

    setPhase('load')
    setStatus('载入工作区状态', 'LOADING WORKSPACE STATE')
    sfx.step()
    const stateVoice = speak('load')
    const [workspaceState] = await Promise.all([
      workspacePromise, sleepScaled(1400), stateVoice.then(duration => wait(durationOrZero(duration) ? 240 : 0)),
    ])
    if (workspaceState === TIMEOUT) return finish('timeout')
    if (alive()) await welcome()
  }

  async function onFormed() {
    if (phase !== 'fly') return
    clearTimeout(flightWatchdog)
    setPhase('formed')
    sfx.close()
    await sleepScaled(1700)
    if (!alive()) return
    setPhase('confirm')
    setStatus('身份与镜像确认', 'IDENTITY · MIRROR CHECK', true)
    sfx.step()
    const confirmationVoice = speak('identity')
    await Promise.all([confirmationVoice, settings.requireConfirm ? waitForConfirmation() : sleepScaled(1600)])
    if (!alive()) return
    stage?.pulse()
    await loadWorkspace()
  }

  async function runIntro() {
    await sleepScaled(700)
    if (!alive()) return
    setPhase('intro')
    setStatus('', 'STILLTIME · REVERSEWEAR')
    sfx.rise()
    await sleepScaled(2400)
    if (!alive()) return
    clearStatus()
    await sleepScaled(420)
    if (!alive()) return
    setPhase('wake')
    setStatus('需要唤醒许可', 'WAKE PERMISSION REQUIRED', true)
    sfx.step()
    const wakeVoice = speak('wake')
    await Promise.all([wakeVoice, settings.requireConfirm ? waitForConfirmation() : sleepScaled(1800)])
    if (alive()) startFlight()
  }

  function startFlight() {
    if (phase !== 'wake') return
    setPhase('fly')
    waiting = null
    root.classList.remove('await')
    voice.unlock()
    sfx.resume()
    sfx.sweep()
    setTimeout(() => { if (alive()) sfx.rise() }, 120)
    if (stage?.CH) {
      stage.CH.T = isReducedMotion() ? 4 : clamp(settings.flyIn, 4, 14)
      stage.CH.onForm = onFormed
      stage.startFly(clamp(settings.speed, 0.35, 3))
      const expectedFlightMs = stage.CH.T / clamp(settings.speed, 0.35, 3) * 1000
      flightWatchdog = setTimeout(() => {
        if (phase === 'fly' && !finished) void finish('timeout')
      }, expectedFlightMs + 15000)
    } else {
      void finish('error')
    }
  }

  function handleTap() {
    if (!waiting) return false
    waiting()
    return true
  }

  function skip() {
    if (!settings.allowSkip || finished || (phase === 'leaving' && root.classList.contains('leaving'))) return false
    root.dataset.skipRequestedAtMs = String(Math.round(performance.now()))
    performance.mark('reversewear:skip-requested')
    onSkip()
    setPhase('leaving')
    waiting = null
    voice.stop()
    skipButton.disabled = true
    root.classList.add('leaving')
    if (!stage) {
      void finish('skipped')
      return true
    }
    canvas.style.transition = 'opacity 280ms'
    canvas.style.opacity = '0'
    setTimeout(() => {
      if (finished) return
      void dissolve(320).then(() => finish('skipped'))
    }, 300)
    return true
  }

  function handleKey(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.target === skipButton) {
        event.preventDefault()
        return skip()
      }
      unlockOnGesture()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      return skip()
    }
    if ((event.key === 'Enter' || event.key === ' ') && waiting) {
      event.preventDefault()
      return handleTap()
    }
    return phase === 'leaving' || phase === 'done'
  }

  function attachStage(instance) {
    stage = instance
    if (!stage?.CH || !stage?.startFly || !stage?.dispose) throw new TypeError('Ouroboros startup stage is incomplete')
    stage.CH.onForm = onFormed
    applyGlass()
  }

  function startShell() {
    document.documentElement.classList.add('startup-active')
    window.addEventListener('keydown', handleEarlyKey, true)
  }

  async function start() {
    if (finished) return completion
    if (!preview && (!settings.enabled || settings.mode === 'off')) return finish('disabled')
    if (!preview && settings.mode === 'daily') {
      try {
        if (localStorage.getItem(STARTUP_DAY_KEY) === localDay()) return finish('disabled')
      } catch {}
    }
    if (!stage) throw new Error('Startup stage must be attached before start')
    document.documentElement.classList.add('startup-active')
    probePromise = bounded(callSafely(probe).catch(() => ({ ok: false })))
    workspacePromise = bounded(callSafely(loadState).catch(() => undefined))
    setPhase('intro')
    void runIntro().catch(() => finish('error'))
    return completion
  }

  function dispose() {
    if (finished) return completion
    return finish('skipped')
  }

  skipButton.hidden = !settings.allowSkip
  skipButton.addEventListener('click', skip)
  document.addEventListener('pointerdown', unlockOnGesture, { once: true, capture: true })
  window.addEventListener('stilltime-startup-audio-settings-change', onAudioSettingsChange)

  return {
    attachStage,
    startShell,
    start,
    skip,
    handleTap,
    handleKey,
    onNight: onNightChanged,
    previewVoice: () => previewStartupVoice(settings),
    dispose,
    get phase() { return phase },
    get completion() { return completion }
  }
}
