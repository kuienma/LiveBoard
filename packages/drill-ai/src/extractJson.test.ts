import { describe, expect, it } from 'vitest'
import { extractJson } from './extractJson.js'

describe('从模型回复里抽 JSON', () => {
  it('本来就是纯 JSON', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}')
  })

  it('包在 ```json 围栏里', () => {
    const text = '```json\n{"a": 1, "b": [2, 3]}\n```'
    expect(JSON.parse(extractJson(text))).toEqual({ a: 1, b: [2, 3] })
  })

  it('包在无语言标记的围栏里', () => {
    expect(JSON.parse(extractJson('```\n{"a":1}\n```'))).toEqual({ a: 1 })
  })

  it('前后多说了话', () => {
    const text = '好的，这是识别结果：\n{"drill": {"version": 1}}\n希望对你有帮助！'
    expect(JSON.parse(extractJson(text))).toEqual({ drill: { version: 1 } })
  })

  it('字符串里含大括号也能正确配对', () => {
    const text = '{"note": "这里有个 } 和 { 符号", "n": 1}'
    expect(JSON.parse(extractJson(text))).toEqual({ note: '这里有个 } 和 { 符号', n: 1 })
  })

  it('字符串里含转义引号', () => {
    const text = '{"note": "他说\\"好\\"", "n": 2}'
    expect(JSON.parse(extractJson(text))).toEqual({ note: '他说"好"', n: 2 })
  })

  it('嵌套对象取完整的最外层', () => {
    const text = 'text {"a": {"b": {"c": 1}}} tail'
    expect(JSON.parse(extractJson(text))).toEqual({ a: { b: { c: 1 } } })
  })

  it('空回复直接报错', () => {
    expect(() => extractJson('   ')).toThrow('没有返回任何内容')
  })

  it('完全没有 JSON 时报错并带上开头内容便于排查', () => {
    expect(() => extractJson('我看不清这张图片')).toThrow('我看不清这张图片')
  })

  it('括号没闭合（被截断）时报错，而不是返回半个 JSON', () => {
    expect(() => extractJson('{"a": 1, "b": [2,')).toThrow('找不到完整的 JSON')
  })
})
