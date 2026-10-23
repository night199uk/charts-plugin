import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'

/**
 * Plugin-wide HTTP proxy for server-side chart requests.
 *
 * The proxy is opt-in per provider (`useProxy`) and only affects requests the
 * Signal K server makes itself. A configurable JavaScript snippet can run every
 * N proxied requests to rotate/reinitialize the proxy. The snippet receives a
 * context object and may return a new proxy URL string; returning nothing keeps
 * the configured URL but still rebuilds the dispatcher.
 */

export interface ProxyConfig {
  proxyUrl?: string
  reinitEvery?: number
  reinitScript?: string
}

export type ProxyLogger = (message: string) => void

type DispatcherFactory = (url: string) => Dispatcher

// Proxied requests use undici's own fetch so the Dispatcher and fetch
// implementations always come from the same undici version. Mixing Node's
// built-in undici with an external ProxyAgent breaks across Node releases.
type ProxiedFetch = (
  url: string,
  init: RequestInit & { dispatcher: Dispatcher }
) => Promise<Response>

const defaultProxiedFetch: ProxiedFetch = (url, init) =>
  undiciFetch(url, init as never) as unknown as Promise<Response>

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

const REDACTED_PROXY = '<invalid proxy URL>'

// Never log proxy credentials. Proxy URLs commonly carry user:pass.
const redactProxyUrl = (raw: string): string => {
  try {
    const url = new URL(raw)
    if (url.username) url.username = ''
    if (url.password) url.password = ''
    return url.toString()
  } catch {
    return REDACTED_PROXY
  }
}

export class ProxyManager {
  private proxyUrl = ''
  private reinitEvery = 0
  private reinitScript = ''
  private logger: ProxyLogger = () => {}
  private onReinitialized: (() => void) | undefined
  private dispatcher: Dispatcher | undefined
  private requestCount = 0
  private reinitInFlight: Promise<void> | null = null
  private warnedNoUrl = false

  constructor(
    private readonly createDispatcher: DispatcherFactory = (url) =>
      new ProxyAgent(url),
    private readonly proxiedFetch: ProxiedFetch = defaultProxiedFetch
  ) {}

  configure(
    config: ProxyConfig,
    logger: ProxyLogger,
    onReinitialized?: () => void
  ): void {
    const url = (config.proxyUrl ?? '').trim()
    const every = Number(config.reinitEvery)
    this.proxyUrl = url
    this.reinitEvery =
      Number.isFinite(every) && every > 0 ? Math.floor(every) : 0
    this.reinitScript = (config.reinitScript ?? '').trim()
    this.logger = logger
    this.onReinitialized = onReinitialized
    this.requestCount = 0
    this.warnedNoUrl = false
    this.swapDispatcher(url)
    if (!url) {
      this.logger('global proxy disabled')
      return
    }
    this.logger(
      `global proxy enabled url=${redactProxyUrl(url)}` +
        (this.reinitEvery > 0 && this.reinitScript
          ? ` reinitEvery=${this.reinitEvery}`
          : '')
    )
  }

  shutdown(): void {
    this.proxyUrl = ''
    this.reinitEvery = 0
    this.reinitScript = ''
    this.onReinitialized = undefined
    this.requestCount = 0
    this.reinitInFlight = null
    const old = this.dispatcher
    this.dispatcher = undefined
    if (old) void old.close().catch(() => {})
  }

  async fetch(
    url: string,
    init: RequestInit = {},
    options: { useProxy?: boolean; providerId?: string } = {}
  ): Promise<Response> {
    if (options.useProxy !== true) return fetch(url, init)

    if (!this.proxyUrl) {
      if (!this.warnedNoUrl) {
        this.warnedNoUrl = true
        this.logger(
          `provider=${options.providerId ?? 'unknown'} requested the global ` +
            `proxy, but no proxy URL is configured; using a direct connection`
        )
      }
      return fetch(url, init)
    }

    this.requestCount++
    if (
      this.reinitEvery > 0 &&
      this.reinitScript &&
      this.requestCount % this.reinitEvery === 0
    ) {
      if (!this.reinitInFlight) {
        this.reinitInFlight = this.reinitialize(options.providerId).finally(
          () => {
            this.reinitInFlight = null
          }
        )
      }
      await this.reinitInFlight
    }

    if (!this.dispatcher) return fetch(url, init)
    return this.proxiedFetch(url, {
      ...init,
      dispatcher: this.dispatcher
    })
  }

  private async reinitialize(providerId?: string): Promise<void> {
    let nextUrl = this.proxyUrl
    try {
      const run = new AsyncFunction('context', this.reinitScript)
      const result = await run({
        requestCount: this.requestCount,
        proxyUrl: this.proxyUrl,
        providerId
      })
      if (typeof result === 'string' && result.trim()) {
        nextUrl = result.trim()
      } else if (result !== undefined && result !== null) {
        this.logger(
          `proxy reinit script returned ${typeof result}; expected a URL ` +
            `string or nothing`
        )
      }
    } catch (err) {
      this.logger(`proxy reinit script failed: ${(err as Error).message}`)
      return
    }
    this.logger(
      `reinitializing proxy provider=${providerId ?? 'unknown'} ` +
        `requestCount=${this.requestCount} url=${redactProxyUrl(nextUrl)}`
    )
    this.swapDispatcher(nextUrl)
    this.onReinitialized?.()
  }

  private swapDispatcher(nextUrl: string): void {
    const old = this.dispatcher
    this.dispatcher = undefined
    if (nextUrl) {
      try {
        this.dispatcher = this.createDispatcher(nextUrl)
      } catch (err) {
        this.logger(
          `invalid proxy URL ${redactProxyUrl(nextUrl)}: ` +
            `${(err as Error).message}`
        )
        return
      }
    }
    this.proxyUrl = nextUrl
    if (old) {
      // Let in-flight requests finish on the old dispatcher before closing it.
      setTimeout(() => {
        void old.close().catch(() => {})
      }, 30_000).unref()
    }
  }
}

export const proxyManager = new ProxyManager()
