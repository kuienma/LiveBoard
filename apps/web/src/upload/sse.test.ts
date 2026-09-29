import { describe, expect, it } from 'vitest'
import { createSseParser } from './sse.js'
import { fit, MAX_EDGE } from './compressPage.js'

describe('SSE 解析', () => {
  it('解析出 event 与 data', () => {
    const parser = createSseParser()
    const events = parser.feed('event: progress\ndata: {"phase":"requesting"}\n\n')
    expect(events).toEqual([{ event: 'progress', data: '{"phase":"requesting"}' }])
  })

  it('一次喂入多个事件', () => {
    const parser = createSseParser()
    const events = parser.feed('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')
    expect(events.map((e) => e.event)).toEqual(['a', 'b'])
  })

  it('事件被拆成多个 chunk 也能拼回来（流式的常态）', () => {
    const parser = createSseParser()
    expect(parser.feed('event: prog')).toEqual([])
    expect(parser.feed('ress\ndata: {"a":')).toEqual([])
    expect(parser.feed('1}\n\n')).toEqual([{ event: 'progress', data: '{"a":1}' }])
  })

  it('兼容 \\r\\n 换行（有些代理会改写）', () => {
    const parser = createSseParser()
    const events = parser.feed('event: x\r\ndata: 1\r\n\r\n')
    expect(events).toEqual([{ event: 'x', data: '1' }])
  })

  it('多行 data 拼成一条', () => {
    const parser = createSseParser()
    const events = parser.feed('event: x\ndata: 第一行\ndata: 第二行\n\n')
    expect(events[0]!.data).toBe('第一行\n第二行')
  })

  it('忽略注释行和心跳', () => {
    const parser = createSseParser()
    expect(parser.feed(': keep-alive\n\n')).toEqual([])
    expect(parser.feed('event: x\ndata: 1\n\n')).toHaveLength(1)
  })

  it('没有 event 字段时默认 message', () => {
    const parser = createSseParser()
    expect(parser.feed('data: hi\n\n')).toEqual([{ event: 'message', data: 'hi' }])
  })

  it('flush 取出末尾没有空行收尾的最后一块', () => {
    const parser = createSseParser()
    expect(parser.feed('event: x\ndata: 1')).toEqual([])
    expect(parser.flush()).toEqual([{ event: 'x', data: '1' }])
  })

  it('flush 后不会重复吐出', () => {
    const parser = createSseParser()
    parser.feed('event: x\ndata: 1\n\n')
    expect(parser.flush()).toEqual([])
  })
})

describe('上传前的等比缩放', () => {
  it('横图按宽度压到长边上限', () => {
    expect(fit(4032, 3024)).toEqual({ width: MAX_EDGE, height: 1500 })
  })

  it('竖图按高度压', () => {
    expect(fit(3024, 4032)).toEqual({ width: 1500, height: MAX_EDGE })
  })

  it('本来就小的不放大', () => {
    expect(fit(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('正好等于上限时不动', () => {
    expect(fit(MAX_EDGE, 1000)).toEqual({ width: MAX_EDGE, height: 1000 })
  })
})
