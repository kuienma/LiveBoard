import { describe, expect, it } from 'vitest'
import { RateLimiter } from './rateLimit.js'

const HOUR = 60 * 60 * 1000

describe('按 IP 限频', () => {
  it('额度内放行，用满后拦截', () => {
    const limiter = new RateLimiter(3)
    const now = Date.now()

    expect(limiter.check('a', now).allowed).toBe(true)
    expect(limiter.check('a', now).allowed).toBe(true)
    const third = limiter.check('a', now)
    expect(third.allowed).toBe(true)
    expect(third.used).toBe(3)

    const fourth = limiter.check('a', now)
    expect(fourth.allowed).toBe(false)
    expect(fourth.used).toBe(3)
    expect(fourth.limit).toBe(3)
  })

  it('被拦截的请求不占额度，不会越试越久', () => {
    const limiter = new RateLimiter(1)
    const now = Date.now()
    limiter.check('a', now)
    const first = limiter.check('a', now)
    const second = limiter.check('a', now)
    expect(first.used).toBe(1)
    expect(second.used).toBe(1)
  })

  it('不同 IP 互不影响', () => {
    const limiter = new RateLimiter(1)
    const now = Date.now()
    expect(limiter.check('a', now).allowed).toBe(true)
    expect(limiter.check('b', now).allowed).toBe(true)
    expect(limiter.check('a', now).allowed).toBe(false)
  })

  it('滑动窗口：一小时后旧记录过期', () => {
    const limiter = new RateLimiter(2)
    const t0 = Date.now()
    limiter.check('a', t0)
    limiter.check('a', t0)
    expect(limiter.check('a', t0).allowed).toBe(false)

    // 刚好过一小时，最早那次滑出窗口
    expect(limiter.check('a', t0 + HOUR + 1).allowed).toBe(true)
  })

  it('retryAfterSeconds 指向最早那次请求过期的时刻', () => {
    const limiter = new RateLimiter(1)
    const t0 = Date.now()
    limiter.check('a', t0)
    const blocked = limiter.check('a', t0 + 10 * 60 * 1000) // 10 分钟后
    expect(blocked.allowed).toBe(false)
    // 还剩 50 分钟
    expect(blocked.retryAfterSeconds).toBeGreaterThan(49 * 60)
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(50 * 60)
  })

  it('prune 清掉完全过期的 key', () => {
    const limiter = new RateLimiter(1)
    const t0 = Date.now()
    limiter.check('a', t0)
    limiter.prune(t0 + HOUR + 1)
    // 清理后额度回满
    expect(limiter.check('a', t0 + HOUR + 2).allowed).toBe(true)
  })
})
