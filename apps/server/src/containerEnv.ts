import { existsSync } from 'node:fs'

/**
 * 容器里把指向回环地址的服务地址改写成 host.docker.internal。
 *
 * 为什么需要：`.env` 里写 `AI_BASE_URL=http://127.0.0.1:38080` 指的是
 * 「网关跑在我这台机器上」。但容器里的 127.0.0.1 是容器自己，照原样用就连不上，
 * 识别功能直接失效，而且报错看起来像是网关挂了。
 *
 * 为什么不在 Dockerfile 里写死：Docker 的优先级是 env_file / environment
 * 覆盖镜像的 ENV，镜像里设了也会被 .env 盖掉，方向正好相反。
 * 为什么不在 compose 的 environment 里写死：那样地址被钉死，换网关要改 compose。
 *
 * 改写是有边界的：只在容器内、且主机名确实是回环地址时才动，
 * 端口和路径原样保留，并且一定在启动日志里说明改了什么。
 * 不想要这个行为就设 `DISABLE_LOOPBACK_REWRITE=1`。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '[::1]'])

/** 容器内宿主机的名字。compose 里配了 extra_hosts，Linux 上也解析得到。 */
const HOST_ALIAS = 'host.docker.internal'

export interface Rewrite {
  key: string
  from: string
  to: string
}

/**
 * 是不是跑在容器里。
 *
 * 优先看镜像里显式设的 IN_CONTAINER：/.dockerenv 是 Docker 特有的，
 * podman 之类不一定有，不能只靠它。
 */
export function isInContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['IN_CONTAINER'] === '1') return true
  return existsSync('/.dockerenv')
}

/**
 * 把给定的几个环境变量里的回环地址改写掉。
 *
 * 返回新的 env 副本和改写清单（清单交给调用方打日志——静默改写配置
 * 会让人对着一个「明明写对了」的地址查半天）。
 */
export function rewriteLoopbackForContainer(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): { env: NodeJS.ProcessEnv; rewrites: Rewrite[] } {
  const rewrites: Rewrite[] = []
  if (!isInContainer(env) || env['DISABLE_LOOPBACK_REWRITE'] === '1') {
    return { env, rewrites }
  }

  const next: NodeJS.ProcessEnv = { ...env }
  for (const key of keys) {
    const value = env[key]
    if (value === undefined || value.trim() === '') continue

    const replaced = replaceLoopbackHost(value)
    if (replaced !== undefined) {
      next[key] = replaced
      rewrites.push({ key, from: value, to: replaced })
    }
  }
  return { env: next, rewrites }
}

/** 地址是回环地址时返回改写后的值，否则返回 undefined。 */
function replaceLoopbackHost(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // 不是完整 URL 就不碰——猜不出该改哪一段
    return undefined
  }

  if (!LOOPBACK_HOSTS.has(url.hostname) && !LOOPBACK_HOSTS.has(`[${url.hostname}]`)) {
    return undefined
  }

  url.hostname = HOST_ALIAS
  // URL 会补上默认端口之外的结构差异，这里只改主机名，其余原样
  return url.toString().replace(/\/$/, value.endsWith('/') ? '/' : '')
}
