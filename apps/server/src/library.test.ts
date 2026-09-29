import type { Drill } from '@drill/schema'
import { beforeEach, describe, expect, it } from 'vitest'
import sideAttack from '../../../fixtures/side-attack.json'
import passingSquare from '../../../fixtures/passing-square.json'
import { openDb, MAX_VERSIONS_PER_DRILL, type Db } from './db/index.js'
import {
  createDrill,
  deleteDrill,
  duplicateDrill,
  exportDrills,
  getDrill,
  importDrills,
  LibraryError,
  listDrills,
  listVersions,
  restoreVersion,
  updateDrill,
  EXPORT_FORMAT,
} from './library.js'

let db: Db

beforeEach(() => {
  db = openDb(':memory:')
})

const clone = (): any => structuredClone(sideAttack)

const create = (drill: unknown = sideAttack, now?: number) =>
  createDrill(db, { drill, origin: 'recognition' }, now)

describe('新建与读取', () => {
  it('保存后能读回来，并冗余出标题和类别用于列表', () => {
    const created = create()
    expect(created.title).toBe('从侧边进攻')
    expect(created.category).toBe('dribbling')
    expect(created.source).toBe('第3章 运球')
    expect(created.variantCount).toBe(3)

    const fetched = getDrill(db, created.id)
    expect(fetched.drill).toEqual(created.drill)
  })

  it('新建即记一条版本', () => {
    const created = create()
    const versions = listVersions(db, created.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]!.origin).toBe('recognition')
  })

  it('不合法的数据被拒绝，且不会落库', () => {
    const broken = clone()
    broken.objects[0].pos = [99, 99]
    expect(() => create(broken)).toThrow(LibraryError)
    expect(listDrills(db)).toHaveLength(0)
  })

  it('拒绝时带上可读的校验错误', () => {
    const broken = clone()
    broken.objects[0].pos = [99, 99]
    try {
      create(broken)
      throw new Error('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryError)
      const e = error as LibraryError
      expect(e.status).toBe(400)
      expect(e.message).toContain('超出场地范围')
      expect(e.issues).not.toHaveLength(0)
    }
  })

  it('读不存在的 id 报 404', () => {
    try {
      getDrill(db, 'nope')
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as LibraryError).status).toBe(404)
    }
  })
})

describe('列表筛选与搜索', () => {
  beforeEach(() => {
    create(sideAttack, 1000)
    create(passingSquare, 2000)
  })

  it('默认按更新时间倒序', () => {
    expect(listDrills(db).map((d) => d.title)).toEqual(['四角传球', '从侧边进攻'])
  })

  it('按类别筛选', () => {
    expect(listDrills(db, { category: 'passing' }).map((d) => d.title)).toEqual(['四角传球'])
    expect(listDrills(db, { category: 'shooting' })).toHaveLength(0)
  })

  it('按标题搜索（中文子串）', () => {
    expect(listDrills(db, { q: '传球' }).map((d) => d.title)).toEqual(['四角传球'])
    expect(listDrills(db, { q: '侧边' }).map((d) => d.title)).toEqual(['从侧边进攻'])
  })

  it('搜索与筛选可叠加', () => {
    expect(listDrills(db, { q: '传球', category: 'dribbling' })).toHaveLength(0)
  })

  it('空搜索词不当作条件', () => {
    expect(listDrills(db, { q: '   ' })).toHaveLength(2)
  })
})

describe('更新', () => {
  it('改标题后列表跟着变，并记新版本', () => {
    const created = create(sideAttack, 1000)
    const edited = clone()
    edited.meta.title = '从侧边进攻（改）'

    const updated = updateDrill(db, created.id, { drill: edited, origin: 'manual' }, 2000)
    expect(updated.title).toBe('从侧边进攻（改）')
    expect(updated.updatedAt).toBe(2000)
    expect(updated.createdAt).toBe(1000) // 创建时间不动

    const versions = listVersions(db, created.id)
    expect(versions.map((v) => v.origin)).toEqual(['manual', 'recognition'])
  })

  it('改坏了会被拒绝，库里还是旧数据', () => {
    const created = create()
    const broken = clone()
    broken.variants = []

    expect(() => updateDrill(db, created.id, { drill: broken, origin: 'manual' })).toThrow(
      LibraryError,
    )
    expect(getDrill(db, created.id).drill.variants).toHaveLength(3)
    expect(listVersions(db, created.id)).toHaveLength(1)
  })

  it('不传缩略图时保留原来的', () => {
    const thumb = 'data:image/png;base64,AAAA'
    const created = createDrill(db, { drill: sideAttack, origin: 'manual', thumbnail: thumb })
    const updated = updateDrill(db, created.id, { drill: sideAttack, origin: 'manual' })
    expect(updated.thumbnail).toBe(thumb)
  })

  it('更新不存在的 id 报 404', () => {
    try {
      updateDrill(db, 'nope', { drill: sideAttack, origin: 'manual' })
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as LibraryError).status).toBe(404)
    }
  })
})

describe('缩略图', () => {
  it('不是 data URL 的被拒绝', () => {
    expect(() =>
      createDrill(db, { drill: sideAttack, origin: 'manual', thumbnail: 'https://x/y.png' }),
    ).toThrow('data URL')
  })

  it('过大的被拒绝', () => {
    const huge = `data:image/png;base64,${'A'.repeat(300 * 1024)}`
    expect(() =>
      createDrill(db, { drill: sideAttack, origin: 'manual', thumbnail: huge }),
    ).toThrow('KB')
  })
})

describe('删除', () => {
  it('删掉训练连版本一起删', () => {
    const created = create()
    updateDrill(db, created.id, { drill: sideAttack, origin: 'manual' })
    deleteDrill(db, created.id)

    expect(listDrills(db)).toHaveLength(0)
    expect(() => listVersions(db, created.id)).toThrow()
  })

  it('删不存在的报 404', () => {
    expect(() => deleteDrill(db, 'nope')).toThrow(LibraryError)
  })
})

describe('复制为新训练', () => {
  it('副本是独立的，改副本不影响原训练', () => {
    const original = create()
    const copy = duplicateDrill(db, original.id)

    expect(copy.id).not.toBe(original.id)
    expect(copy.title).toBe('从侧边进攻 副本')

    const edited = structuredClone(copy.drill) as Drill
    edited.meta.title = '副本改过了'
    edited.field.width = 30
    updateDrill(db, copy.id, { drill: edited, origin: 'manual' })

    const originalAfter = getDrill(db, original.id)
    expect(originalAfter.title).toBe('从侧边进攻')
    expect(originalAfter.drill.field.width).toBe(20)
  })

  it('副本有自己的版本历史', () => {
    const original = create()
    const copy = duplicateDrill(db, original.id)
    expect(listVersions(db, copy.id)).toHaveLength(1)
    expect(listVersions(db, original.id)).toHaveLength(1)
  })
})

describe('版本记录', () => {
  it('每次保存生成一个版本，最新的在前', () => {
    const created = create(sideAttack, 1000)
    updateDrill(db, created.id, { drill: sideAttack, origin: 'manual' }, 2000)
    updateDrill(db, created.id, { drill: sideAttack, origin: 'ai-revise' }, 3000)

    const versions = listVersions(db, created.id)
    expect(versions.map((v) => v.origin)).toEqual(['ai-revise', 'manual', 'recognition'])
    expect(versions[0]!.createdAt).toBe(3000)
  })

  it(`超过 ${MAX_VERSIONS_PER_DRILL} 个只保留最近的`, () => {
    const created = create(sideAttack, 1)
    for (let i = 2; i <= 25; i++) {
      const edited = clone()
      edited.meta.title = `第 ${i} 版`
      updateDrill(db, created.id, { drill: edited, origin: 'manual' }, i)
    }

    const versions = listVersions(db, created.id)
    expect(versions).toHaveLength(MAX_VERSIONS_PER_DRILL)
    // 保留的是最近的，最早那几版被裁掉
    expect(versions[0]!.createdAt).toBe(25)
    expect(Math.min(...versions.map((v) => v.createdAt))).toBe(25 - MAX_VERSIONS_PER_DRILL + 1)
  })

  it('恢复到旧版本：数据回退，历史不删，并多出一条 restore 记录', () => {
    const created = create(sideAttack, 1000)
    const v1 = listVersions(db, created.id)[0]!

    const edited = clone()
    edited.meta.title = '改过的标题'
    updateDrill(db, created.id, { drill: edited, origin: 'manual' }, 2000)
    expect(getDrill(db, created.id).title).toBe('改过的标题')

    const restored = restoreVersion(db, created.id, v1.id, 3000)
    expect(restored.title).toBe('从侧边进攻')

    const versions = listVersions(db, created.id)
    expect(versions).toHaveLength(3) // 原始 + 修改 + 恢复
    expect(versions[0]!.origin).toBe('restore')
    expect(versions[0]!.restoredFrom).toBe(v1.id)
  })

  it('不能恢复别的训练的版本', () => {
    const a = create(sideAttack)
    const b = create(passingSquare)
    const bVersion = listVersions(db, b.id)[0]!

    try {
      restoreVersion(db, a.id, bVersion.id)
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as LibraryError).status).toBe(404)
    }
  })
})

describe('导出与导入', () => {
  it('导出整个库带 format 与 version', () => {
    create(sideAttack)
    create(passingSquare)

    const file = exportDrills(db)
    expect(file.format).toBe(EXPORT_FORMAT)
    expect(file.version).toBe(1)
    expect(file.drills).toHaveLength(2)
    expect(file.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('可以只导出指定的训练', () => {
    const a = create(sideAttack)
    create(passingSquare)
    const file = exportDrills(db, [a.id])
    expect(file.drills.map((d) => d.title)).toEqual(['从侧边进攻'])
  })

  it('导出再导入，播放数据完全一致', () => {
    const original = create(sideAttack)
    const file = exportDrills(db, [original.id])

    const fresh = openDb(':memory:')
    const result = importDrills(fresh, file)

    expect(result.rejected).toHaveLength(0)
    expect(result.imported).toHaveLength(1)
    // 逐字节一致才算「播放效果完全一致」
    expect(getDrill(fresh, result.imported[0]!.id).drill).toEqual(original.drill)
  })

  it('导入分配新 id，不覆盖已有训练', () => {
    const original = create(sideAttack)
    const file = exportDrills(db, [original.id])
    const result = importDrills(db, file)

    expect(result.imported[0]!.id).not.toBe(original.id)
    expect(listDrills(db)).toHaveLength(2)
  })

  it('导入的训练算一条 import 版本', () => {
    const file = exportDrills(db, [create(sideAttack).id])
    const fresh = openDb(':memory:')
    const result = importDrills(fresh, file)
    expect(listVersions(fresh, result.imported[0]!.id)[0]!.origin).toBe('import')
  })

  it('不是本应用的文件被拒绝并说明原因', () => {
    expect(() => importDrills(db, { hello: 'world' })).toThrow('format')
  })

  it('缺 version 字段被拒绝', () => {
    expect(() => importDrills(db, { format: EXPORT_FORMAT, drills: [] })).toThrow('version')
  })

  it('来自更新版本的文件被拒绝，并提示升级应用', () => {
    expect(() =>
      importDrills(db, { format: EXPORT_FORMAT, version: 99, drills: [] }),
    ).toThrow('升级应用')
  })

  it('不是 JSON 对象被拒绝', () => {
    expect(() => importDrills(db, 'just a string')).toThrow('JSON 对象')
  })

  it('一条坏数据不影响其他条导入', () => {
    const broken = clone()
    broken.variants[0].phases[1].actions[0].awayFrom = 'C'

    const result = importDrills(db, {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      drills: [
        { title: '好的', createdAt: 1, drill: sideAttack },
        { title: '坏的', createdAt: 2, drill: broken },
        { title: '也是好的', createdAt: 3, drill: passingSquare },
      ],
    })

    expect(result.imported.map((d) => d.title)).toEqual(['从侧边进攻', '四角传球'])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]!.title).toBe('坏的')
    expect(result.rejected[0]!.reason).toContain('不存在的 id「C」')
  })
})
