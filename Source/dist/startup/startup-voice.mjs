import { createAssetVoice } from './voice-asset.mjs';

export function createStartupVoice(config) {
  const player = createAssetVoice({
    baseUrl: new URL('./voice/', import.meta.url).href,
    volume: config.voiceVolume,
    cue: config.voiceCue,
  });
  if (config.voice) player.preload();

  return {
    async line(key) {
      if (!config.voice) return 0;
      try { return Math.max(0, await player.line(key)); }
      catch { return 0; }
    },
    unlock() { if (config.voice) player.unlock(); },
    setVolume: player.setVolume,
    setCue: player.setCue,
    stop: player.stop,
  };
}

export async function previewStartupVoice(config) {
  const voice = createStartupVoice({ ...config, voice: true });
  try {
    return await voice.line('welcome');
  } finally {
    voice.stop();
  }
}
