/**
 * 按 IP 的滑动窗口限频。
 *
 * 识别一次要花真金白银（实测约 8900+2600 tokens），docs/spec.md 第 7 节要求
 * 按用户/IP 限频防止费用失控。第一版不做账号，所以只能按 IP。
 * 进程内存实现：单实例够用；将来多实例部署要换成 Redis。
 */
export interface RateLimitResult {
  allowed: boolean
  /** 当前窗口内已用次数。 */
  used: number
  limit: number
  /** 还要等多少秒才会有额度（allowed 为 true 时是 0）。 */
  retryAfterSeconds: number
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  /** 记录一次请求并返回是否放行。注意：只有放行时才计入。 */
  check(key: string, now = Date.now()): RateLimitResult {
    const cutoff = now - this.windowMs
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff)

    if (recent.length >= this.limit) {
      const oldest = recent[0]!
      this.hits.set(key, recent)
      return {
        allowed: false,
        used: recent.length,
        limit: this.limit,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      }
    }

    recent.push(now)
    this.hits.set(key, recent)
    return { allowed: true, used: recent.length, limit: this.limit, retryAfterSeconds: 0 }
  }

  /** 定期清掉早已过期的 key，避免内存无上限增长。 */
  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs
    for (const [key, times] of this.hits) {
      const recent = times.filter((at) => at > cutoff)
      if (recent.length === 0) {
        this.hits.delete(key)
      } else {
        this.hits.set(key, recent)
      }
    }
  }
}
