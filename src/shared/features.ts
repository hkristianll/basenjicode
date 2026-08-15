/**
 * Feature flags.
 *
 * VOICE: the experimental voice mode (push-to-talk + "Hey Jarvis" wake word + Kokoro TTS,
 * backed by the local voice-sidecar). Disabled for now — it's resource-heavy (a Whisper model
 * + an always-listening mic) and competes with LM Studio / ComfyUI for the GPU. ALL the code
 * is still here (src/renderer/voice/*, components/VoiceOrb, src/main/voice.ts, voice-sidecar/).
 * Flip this to `true` and rebuild to bring it back; nothing was deleted.
 */
export const VOICE_FEATURE_ENABLED = false
