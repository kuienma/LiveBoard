# 书页素材目录

批量评测（`pnpm eval`）会把这个目录下的每张照片跑一遍识别，并和同名的
`<名字>.expect.json` 对照打分。

**这个目录里的图片和文字不进仓库。** 内容来自出版物，`docs/spec.md` 第 7 节
的要求是「默认不长期保存原始书页照片、不对外展示书中原文」，所以 `.gitignore`
里只放行了本文件。

## 怎么用

把书页照片放进来，按需要配一个期望文件：

```
fixtures/pages/
  某个练法.png            # 书页照片（jpg / jpeg / png / webp）
  某个练法.expect.json    # 可选：机器可判定的期望
  某个练法.expected.md    # 可选：人工对照用的笔记
```

`.expect.json` 支持的字段见 `packages/drill-ai/scripts/evaluate.ts` 里的
`Expectation` 接口，例如：

```json
{
  "titleContains": "…",
  "category": "dribbling",
  "variants": 3,
  "objects": 4,
  "alternating": [false, false, true]
}
```

`alternating` 必须逐个练法指定，不能只写「至少有一个交替」——后者会放过
「把基本练法也做成逐轮交替」这种错误。

目录为空时 `pnpm eval` 会直接提示，不会报错。
