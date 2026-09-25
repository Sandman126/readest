import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BaiduSpeechProvider } from '@/services/tts/providers/baidu';
import { SpeechSynthesisPermanentError } from '@/services/tts/providers/types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const signal = () => new AbortController().signal;

const audioResponse = (bytes = 2048) => ({
  ok: true,
  status: 200,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'audio/mp3' : null) },
  arrayBuffer: async () => new ArrayBuffer(bytes),
});

// The endpoint answers HTTP 200 with a JSON body when it rejects the request.
const jsonErrorResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
  text: async () => JSON.stringify(body),
});

const sentBody = () => new URLSearchParams(String(mockFetch.mock.calls[0]![1].body));

describe('BaiduSpeechProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('requests MP3 with the speed pinned, not the WAV the Legado source asks for', async () => {
    mockFetch.mockResolvedValue(audioResponse());
    const provider = new BaiduSpeechProvider();

    await provider.synthesize(
      { lang: 'zh-CN', text: '你好，世界', voice: 'baidu-per-3', pitch: 1 },
      signal(),
    );

    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://tts.baidu.com/text2audio');
    expect(mockFetch.mock.calls[0]![1].method).toBe('POST');
    const body = sentBody();
    // 6 would be uncompressed WAV: 84844 bytes where MP3 needs 21888.
    expect(body.get('aue')).toBe('3');
    expect(body.get('tex')).toBe('你好，世界');
    expect(body.get('per')).toBe('3');
    expect(body.get('lan')).toBe('zh');
    // Rate is applied at playout, so synthesis stays rate-independent and the
    // audio stays cacheable.
    expect(body.get('spd')).toBe('5');
  });

  it('maps each voice id to its `per` value, defaulting to 度逍遥', async () => {
    const provider = new BaiduSpeechProvider();
    const cases: [string, string][] = [
      ['baidu-per-0', '0'],
      ['baidu-per-1', '1'],
      ['baidu-per-4', '4'],
      ['unknown-voice', '3'],
    ];
    for (const [voice, per] of cases) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValue(audioResponse());
      await provider.synthesize({ lang: 'zh-CN', text: '你好', voice, pitch: 1 }, signal());
      expect(sentBody().get('per')).toBe(per);
    }
  });

  it('returns the audio with no boundaries, since the service reports no timings', async () => {
    mockFetch.mockResolvedValue(audioResponse(4096));
    const provider = new BaiduSpeechProvider();

    const result = await provider.synthesize(
      { lang: 'zh-CN', text: '你好', voice: 'baidu-per-3', pitch: 1 },
      signal(),
    );

    expect(result.audio.byteLength).toBe(4096);
    expect(result.boundaries).toEqual([]);
  });

  it('classifies an HTTP 200 JSON error as permanent so the sentence is skipped, not retried', async () => {
    mockFetch.mockResolvedValue(jsonErrorResponse({ err_no: 501, err_msg: 'parameter error.' }));
    const provider = new BaiduSpeechProvider();

    await expect(
      provider.synthesize({ lang: 'zh-CN', text: '', voice: 'baidu-per-3', pitch: 1 }, signal()),
    ).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
  });

  it('fails init when the endpoint answers without audio', async () => {
    const provider = new BaiduSpeechProvider();

    mockFetch.mockResolvedValue(jsonErrorResponse({ err_no: 501 }));
    await expect(provider.init()).resolves.toBe(false);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(audioResponse());
    await expect(provider.init()).resolves.toBe(true);
  });

  it('offers the Baidu voices as Chinese, led by 度逍遥', async () => {
    const voices = await new BaiduSpeechProvider().getAllVoices();

    expect(voices[0]).toMatchObject({ id: 'baidu-per-3', name: '度逍遥', lang: 'zh-CN' });
    expect(voices.every((v) => v.lang === 'zh-CN')).toBe(true);
  });
});
