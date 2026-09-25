// Baidu (百度) speech as a SpeechProvider, driving the same public
// `text2audio` endpoint the Legado "度逍遥" TTS source uses.
//
// Contract notes measured against the live endpoint:
// - It takes a form body (not SSML) and answers raw audio bytes. `aue=3` yields
//   MP3 — 21888 bytes for a short sentence — while the Legado source's `aue=6`
//   yields WAV at 84844 bytes, 4x the size for the same speech, so this asks
//   for MP3.
// - A rejected request is still HTTP 200: empty text answers with a JSON body
//   `{"err_no":501,...}` and `content-type: application/json`. The provider
//   therefore classifies on the content-type, not the status code, and treats it
//   as permanent (retrying the same sentence cannot succeed).
// - `spd` is pinned. Rate is a playout concern (see ./types) and baking it into
//   the request would make the cached audio rate-specific.
// - The service returns no word timings, so `boundaries` is empty and word
//   highlighting degrades to sentence highlighting.
// - Double URL-encoding (as written in the Legado source) is not required: raw,
//   single- and double-encoded text all return byte-identical audio.

import type { TTSVoice } from '../types';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

const BAIDU_TTS_ENDPOINT = 'https://tts.baidu.com/text2audio';
// Pinned synthesis speed; the playback rate is applied at playout.
const BAIDU_SPEED = '5';
// The service is Chinese-only; `lan` is fixed regardless of the book language.
const BAIDU_LANG = 'zh';
// Probe budget for init(): a hung endpoint must not stall TTS startup.
const BAIDU_PROBE_TIMEOUT_MS = 8000;

/**
 * The voices the endpoint exposes through its `per` parameter. Measured: each
 * value returns different audio, so the parameter really does select a voice.
 * 度逍遥 (per=3) leads so it is the default for a language with no remembered
 * choice.
 */
const BAIDU_VOICES: TTSVoice[] = [
  { id: 'baidu-per-3', name: '度逍遥', lang: 'zh-CN' },
  { id: 'baidu-per-0', name: '度小美', lang: 'zh-CN' },
  { id: 'baidu-per-1', name: '度小宇', lang: 'zh-CN' },
  { id: 'baidu-per-4', name: '度丫丫', lang: 'zh-CN' },
];

const DEFAULT_VOICE_ID = 'baidu-per-3';

/** `per` encoded in a voice id, falling back to the default voice. */
const voicePer = (voiceId: string): string => voiceId.match(/^baidu-per-(\d+)$/)?.[1] ?? '3';

export class BaiduSpeechProvider implements SpeechProvider {
  readonly id = 'baidu-tts';
  readonly label = 'Baidu TTS';
  readonly cacheable = true;
  readonly fallbackVoiceId = DEFAULT_VOICE_ID;

  async #request(text: string, voiceId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const body = new URLSearchParams({
      tex: text,
      spd: BAIDU_SPEED,
      per: voicePer(voiceId),
      cuid: 'baidu_speech_demo',
      idx: '1',
      cod: '2',
      lan: BAIDU_LANG,
      ctp: '1',
      pdt: '505',
      vol: '5',
      // 3 = MP3. 6 would be uncompressed WAV at ~4x the bytes.
      aue: '3',
      pit: '5',
      _res_tag_: 'audio',
    });

    const response = await fetch(BAIDU_TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      throw new Error(`Baidu TTS failed with status ${response.status}`);
    }
    if (!(response.headers.get('content-type') || '').startsWith('audio/')) {
      const detail = await response.text().catch(() => '');
      throw new SpeechSynthesisPermanentError(
        `Baidu TTS returned no audio: ${detail.slice(0, 200)}`,
      );
    }
    return response.arrayBuffer();
  }

  async init(): Promise<boolean> {
    try {
      const audio = await this.#request('你好', DEFAULT_VOICE_ID, AbortSignal.timeout(BAIDU_PROBE_TIMEOUT_MS));
      return audio.byteLength > 0;
    } catch {
      return false;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return BAIDU_VOICES;
  }

  async synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const audio = await this.#request(req.text, req.voice, signal);
    // No timings come back from this service.
    return { audio, boundaries: [] };
  }
}
