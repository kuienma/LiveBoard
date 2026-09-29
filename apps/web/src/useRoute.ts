import { useEffect, useState } from 'react'

/**
 * 极简 hash 路由。
 *
 * 用 hash 而不是 history API：不需要服务端配合任何 rewrite，
 * 也不需要引入 router 依赖。更重要的是刷新页面能回到同一个训练
 * （阶段三验收项「保存后刷新页面数据仍在」）。
 */
export type Route =
  | { name: 'library' }
  | { name: 'upload' }
  | { name: 'drill'; id: string }
  | { name: 'edit'; id: string }

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')
  if (path === 'upload') return { name: 'upload' }

  const edit = /^edit\/(.+)$/.exec(path)
  if (edit?.[1] !== undefined) return { name: 'edit', id: decodeURIComponent(edit[1]) }

  const drill = /^drill\/(.+)$/.exec(path)
  if (drill?.[1] !== undefined) return { name: 'drill', id: decodeURIComponent(drill[1]) }

  return { name: 'library' }
}

export function hashFor(route: Route): string {
  switch (route.name) {
    case 'library':
      return '#/'
    case 'upload':
      return '#/upload'
    case 'drill':
      return `#/drill/${encodeURIComponent(route.id)}`
    case 'edit':
      return `#/edit/${encodeURIComponent(route.id)}`
  }
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof window === 'undefined' ? '' : window.location.hash),
  )

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    onChange()
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  // 改 hash 会触发 hashchange，状态由上面的监听统一更新
  const navigate = (next: Route) => {
    window.location.hash = hashFor(next)
  }

  return [route, navigate]
}
