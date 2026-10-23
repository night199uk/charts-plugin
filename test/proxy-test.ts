import { expect } from 'chai'
import type { Dispatcher } from 'undici'
import { ProxyManager } from '../src/proxy'

type ProxiedFetch = (
  url: string,
  init: RequestInit & { dispatcher: Dispatcher }
) => Promise<Response>

const makeDispatcher = (url: string, urls: string[]): Dispatcher => {
  urls.push(url)
  return {
    dispatch: () => {
      throw new Error('test dispatcher is never used directly')
    },
    close: async () => {},
    destroy: async () => {}
  } as unknown as Dispatcher
}

const makeProxiedFetchMock = () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fn: ProxiedFetch = async (url, init) => {
    calls.push({ url, init })
    return new Response('ok', { status: 200 })
  }
  return { calls, fn }
}

const installFetchMock = () => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      init
    })
    return new Response('ok', { status: 200 })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    }
  }
}

describe('ProxyManager', () => {
  it('leaves non-proxy requests untouched', async () => {
    const urls: string[] = []
    const fetchMock = installFetchMock()
    const manager = new ProxyManager((url) => makeDispatcher(url, urls))
    try {
      manager.configure({ proxyUrl: 'http://proxy:8080' }, () => {})
      await manager.fetch(
        'https://example.com/tile.png',
        {},
        { useProxy: false }
      )
      expect(fetchMock.calls).to.have.length(1)
      expect(
        (fetchMock.calls[0]!.init as RequestInit & { dispatcher?: unknown })
          .dispatcher
      ).to.equal(undefined)
      expect(urls).to.deep.equal(['http://proxy:8080'])
    } finally {
      fetchMock.restore()
      manager.shutdown()
    }
  })

  it('uses the proxy dispatcher for opted-in requests', async () => {
    const urls: string[] = []
    const proxied = makeProxiedFetchMock()
    const manager = new ProxyManager(
      (url) => makeDispatcher(url, urls),
      proxied.fn
    )
    try {
      manager.configure({ proxyUrl: 'http://proxy:8080' }, () => {})
      await manager.fetch(
        'https://example.com/tile.png',
        {},
        { useProxy: true }
      )
      expect(proxied.calls).to.have.length(1)
      expect(proxied.calls[0]!.init.dispatcher).to.not.equal(undefined)
    } finally {
      manager.shutdown()
    }
  })

  it('runs the reinit script every N proxied requests', async () => {
    const urls: string[] = []
    const proxied = makeProxiedFetchMock()
    const manager = new ProxyManager(
      (url) => makeDispatcher(url, urls),
      proxied.fn
    )
    try {
      manager.configure(
        {
          proxyUrl: 'http://proxy-a:8080',
          reinitEvery: 2,
          reinitScript: "return await Promise.resolve('http://proxy-b:8080')"
        },
        () => {}
      )
      await manager.fetch('https://example.com/1', {}, { useProxy: true })
      expect(urls).to.deep.equal(['http://proxy-a:8080'])
      await manager.fetch('https://example.com/2', {}, { useProxy: true })
      expect(urls).to.deep.equal(['http://proxy-a:8080', 'http://proxy-b:8080'])
      await manager.fetch('https://example.com/3', {}, { useProxy: true })
      expect(urls).to.deep.equal(['http://proxy-a:8080', 'http://proxy-b:8080'])
    } finally {
      manager.shutdown()
    }
  })

  it('calls the reinitialized callback after rebuilding the proxy', async () => {
    const urls: string[] = []
    const proxied = makeProxiedFetchMock()
    const manager = new ProxyManager(
      (url) => makeDispatcher(url, urls),
      proxied.fn
    )
    let callbacks = 0
    try {
      manager.configure(
        {
          proxyUrl: 'http://proxy-a:8080',
          reinitEvery: 1,
          reinitScript: "return 'http://proxy-b:8080'"
        },
        () => {},
        () => {
          callbacks++
        }
      )
      await manager.fetch('https://example.com/1', {}, { useProxy: true })
      expect(callbacks).to.equal(1)
    } finally {
      manager.shutdown()
    }
  })

  it('keeps the current proxy when the reinit script fails', async () => {
    const urls: string[] = []
    const logs: string[] = []
    const proxied = makeProxiedFetchMock()
    const manager = new ProxyManager(
      (url) => makeDispatcher(url, urls),
      proxied.fn
    )
    try {
      manager.configure(
        {
          proxyUrl: 'http://proxy-a:8080',
          reinitEvery: 1,
          reinitScript: "throw new Error('offline')"
        },
        (message) => logs.push(message)
      )
      await manager.fetch('https://example.com/1', {}, { useProxy: true })
      expect(urls).to.deep.equal(['http://proxy-a:8080'])
      expect(logs.some((line) => line.includes('proxy reinit script failed')))
        .to.be.true
    } finally {
      manager.shutdown()
    }
  })

  it('logs once and falls back to direct requests when no proxy URL is set', async () => {
    const logs: string[] = []
    const fetchMock = installFetchMock()
    const manager = new ProxyManager()
    try {
      manager.configure({}, (message) => logs.push(message))
      await manager.fetch('https://example.com/1', {}, { useProxy: true })
      await manager.fetch('https://example.com/2', {}, { useProxy: true })
      expect(
        logs.filter((line) => line.includes('no proxy URL'))
      ).to.have.length(1)
    } finally {
      fetchMock.restore()
      manager.shutdown()
    }
  })
})
