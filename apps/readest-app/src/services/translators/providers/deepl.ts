import { stubTranslation as _ } from '@/utils/misc';
import { TranslationProvider } from '../types';
import { normalizeToShortLang } from '@/utils/lang';

/**
 * Fork-local: this provider talks to a self-hosted DeepLX-Pro instance
 * (https://github.com/xiaozhou26/deeplx-pro) instead of Readest's hosted
 * `/deepl/translate` proxy. Contract differences measured against that endpoint:
 *
 *   - auth is an `X-API-Key` header, not the Readest account token, so the
 *     provider needs no login (`authRequired: false`) and spends none of the
 *     account's translation quota;
 *   - `text` must be a single *string* — an array is rejected with 422;
 *   - a blank `text` is rejected with 400, so blank lines are answered locally;
 *   - the reply is `{ code, data }`, not `{ translations: [...] }`.
 *
 * The endpoint answers the preflight with `access-control-allow-origin: *` (and
 * `allow-headers/methods: *`), and the app's CSP already permits `https://*:*`,
 * so the webview's own `fetch` is used here rather than the Tauri HTTP plugin —
 * one code path on desktop, Android and web.
 */
const DEEPLX_API_ENDPOINT = 'https://translate.126413.xyz:4433/translate';
const DEEPLX_API_KEY = 'gFKJA0npY29Nfq';

/**
 * One request per line now, so cap the fan-out: without this a whole-chapter
 * batch would open a socket per paragraph against a single self-hosted instance.
 */
const MAX_CONCURRENT_REQUESTS = 4;

/**
 * DeepL language codes are upper-case, but the service answers 500 when the
 * *script* subtag is upper-cased too. Measured against the live endpoint:
 * `ZH-HANT` and `ZH-TW` both fail (this DeepLX-Pro answers `400 unsupported
 * target language: ZH-TW`), while `ZH-Hant` answers 200 with real Traditional
 * Chinese — and the same holds for `source_lang`. Upper-casing the whole code
 * therefore turned every zh-TW/zh-HK/zh-MO translation into a hard failure.
 * `normalizeToShortLang` already returns the canonical `zh-Hans` / `zh-Hant`,
 * so only the primary subtag is upper-cased and the script subtag keeps the
 * casing it came with. Languages without a script subtag ('en' -> 'EN', and
 * 'AUTO' -> 'AUTO') are unaffected.
 */
const toDeepLLang = (lang: string): string => {
  const [primary, ...rest] = normalizeToShortLang(lang).split('-');
  return [primary!.toUpperCase(), ...rest].join('-');
};

/** Runs `task` over `items` with at most `limit` in flight, preserving order. */
const mapWithLimit = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

export const deeplProvider: TranslationProvider = {
  name: 'deepl',
  label: _('DeepL'),
  authRequired: false,
  // No quota of our own to exceed — the endpoint is self-hosted.
  quotaExceeded: false,
  // `preservesMarkup` stays unset: inline markup survives only when the caller
  // asks for tag handling, and this provider sends plain text.
  translate: async (
    text: string[],
    sourceLang: string,
    targetLang: string,
    _token?: string | null,
    _useCache: boolean = false,
    signal?: AbortSignal,
  ): Promise<string[]> => {
    const normalizedSourceLang = toDeepLLang(sourceLang);
    const normalizedTargetLang = toDeepLLang(targetLang);

    return mapWithLimit(text, MAX_CONCURRENT_REQUESTS, async (line) => {
      // The endpoint rejects blank text with 400; a blank line is already its
      // own translation.
      if (!line?.trim().length) {
        return line;
      }

      const body = JSON.stringify({
        text: line,
        ...(normalizedSourceLang !== 'AUTO' ? { source_lang: normalizedSourceLang } : {}),
        target_lang: normalizedTargetLang,
      });

      const response = await fetch(DEEPLX_API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': DEEPLX_API_KEY,
        },
        body,
        ...(signal ? { signal } : {}),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.code !== 200) {
        throw new Error(data?.message || `Translation failed with status ${response.status}`);
      }
      if (typeof data.data !== 'string') {
        throw new Error('Invalid response from translation service');
      }
      return data.data || line;
    });
  },
};
