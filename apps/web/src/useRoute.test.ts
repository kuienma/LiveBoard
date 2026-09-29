import { describe, expect, it } from 'vitest'
import { hashFor, parseHash, type Route } from './useRoute.js'

describe('解析 hash', () => {
  it('空 hash 是训练库', () => {
    expect(parseHash('')).toEqual({ name: 'library' })
    expect(parseHash('#')).toEqual({ name: 'library' })
    expect(parseHash('#/')).toEqual({ name: 'library' })
  })

  it('上传页', () => {
    expect(parseHash('#/upload')).toEqual({ name: 'upload' })
  })

  it('训练详情带 id', () => {
    expect(parseHash('#/drill/abc-123')).toEqual({ name: 'drill', id: 'abc-123' })
  })

  it('id 会被 URL 解码', () => {
    expect(parseHash('#/drill/a%2Fb')).toEqual({ name: 'drill', id: 'a/b' })
  })

  it('认不出的路径退回训练库，不白屏', () => {
    expect(parseHash('#/nowhere')).toEqual({ name: 'library' })
    expect(parseHash('#/drill/')).toEqual({ name: 'library' })
  })
})

describe('生成 hash', () => {
  it('各路由都能生成', () => {
    expect(hashFor({ name: 'library' })).toBe('#/')
    expect(hashFor({ name: 'upload' })).toBe('#/upload')
    expect(hashFor({ name: 'drill', id: 'abc' })).toBe('#/drill/abc')
  })

  it('id 里的特殊字符会被编码', () => {
    expect(hashFor({ name: 'drill', id: 'a/b' })).toBe('#/drill/a%2Fb')
  })

  it('生成再解析能回到原样（刷新页面靠这条）', () => {
    const routes: Route[] = [
      { name: 'library' },
      { name: 'upload' },
      { name: 'drill', id: '0c8f2b1e-9a4d-4c7e-8f31-2b6d5a7c9e10' },
      { name: 'drill', id: 'a/b c' },
    ]
    for (const route of routes) {
      expect(parseHash(hashFor(route))).toEqual(route)
    }
  })
})
