import { AppService } from '@/types/system';
import { BufferedTTSClient } from './BufferedTTSClient';
import { BaiduSpeechProvider } from './providers/baidu';
import { BookTTSCacheStore, getTTSCacheConfig } from './providers/bookCacheStore';
import { CachingProvider } from './providers/cache';
import { SpeechProvider } from './providers/types';
import { TTSCapabilities } from './TTSClient';
import { TTSController } from './TTSController';

// Everything engine-independent (scheduler, playout, preload, gap policy) lives
// in BufferedTTSClient; this subclass only wires the Baidu provider — plus the
// same optional per-book cache Edge uses — and corrects one capability the base
// class cannot know about.
export class BaiduTTSClient extends BufferedTTSClient {
  constructor(controller?: TTSController, appService?: AppService | null) {
    const provider = new BaiduSpeechProvider();
    let wrapped: SpeechProvider = provider;
    const cacheConfig = getTTSCacheConfig();
    if (appService && cacheConfig.enabled) {
      const store = new BookTTSCacheStore(
        appService,
        () => controller?.bookKey?.split('-')[0] || null,
        cacheConfig.budgetMB * 1024 * 1024,
      );
      wrapped = new CachingProvider(provider, store);
    }
    super(wrapped, controller, appService);
  }

  // This service returns audio without word timings, so the controller must fall
  // back to sentence highlighting instead of waiting for boundaries that never
  // arrive. The base class reports wordBoundaries: true for the buffered engines
  // that do provide them, hence the override.
  override getCapabilities(): TTSCapabilities {
    return { ...super.getCapabilities(), wordBoundaries: false };
  }
}
