# 足球训练图转战术板动画

把足球训练书的一页（训练图 + 文字说明）转成可播放、可微调、可导出视频的战术板动画。

需求文档：[docs/spec.md](docs/spec.md)

**当前进度：阶段二进行中（AI 识别）**。阶段一（数据格式 + 引擎 + 播放器）已完成，
播放页使用内置示例数据 [fixtures/side-attack.json](fixtures/side-attack.json)。

## 大模型接入

不绑定任何一家：协议、模型、地址、凭据全在 `.env` 里（复制 `.env.example`）。
`AI_PROVIDER=anthropic` 走 Messages API，`openai` 走 Chat Completions，
两者都能对接本地网关。先跑 `pnpm probe` 探明网关支持到什么程度，
不支持结构化输出会自动退化成「提示词约束 + 自行抽取 JSON」。

## 环境

- Node.js ≥ 20（开发用 26.8）
- pnpm ≥ 10

## 运行

```bash
pnpm install
pnpm dev        # 启动播放页，默认监听所有网卡
```

终端会打印两个地址：

```
➜  Local:   http://localhost:5173/
➜  Network: http://192.168.x.x:5173/     ← 手机连同一个 WiFi，用这个
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动播放页（手机可通过 Network 地址访问） |
| `pnpm test` | 跑全部单元测试 |
| `pnpm test:watch` | 监视模式 |
| `pnpm typecheck` | 全仓 TypeScript 类型检查 |
| `pnpm build` | 构建播放页到 `apps/web/dist` |
| `pnpm probe` | 探测大模型网关：协议 / 凭据 / 图片输入 / 结构化输出是否可用 |
| `pnpm recognize <图片>` | 走完整识别流程并打印结果（⚠️ 真实调用模型、产生费用） |

## 目录结构

```
├── apps/
│   └── web/              手机端网页：播放器（后续加上传、编辑器、训练库）
├── packages/
│   ├── drill-schema/     Drill JSON 的 Zod 定义、类型、业务校验规则
│   ├── drill-engine/     纯函数：JSON → 时间线，给定 t 返回各对象位置与朝向
│   └── drill-render/     把某一帧画到 Canvas 2D（播放与视频导出共用）
├── docs/spec.md          需求文档
└── fixtures/             测试数据（阶段二起放书页照片与期望 JSON）
```

`drill-engine` 与 `drill-render` 不依赖任何 UI 框架，前端播放和服务端逐帧导出调用同一份代码，
这是「导出视频与预览画面完全一致」的技术保证。

## Drill JSON 数据契约

AI 与播放器之间唯一的接口，定义见 `packages/drill-schema/src/schema.ts`，
字段含义见 [docs/spec.md 第 3 节](docs/spec.md)。文档未写明、开发时定下的语义：

| 项 | 约定 |
| --- | --- |
| `setup` | 只在练法开头应用一次，后续各轮从上一轮结束状态接续 |
| `repeat.times` | 总轮数（不是「额外重复次数」） |
| `repeat.swap` | 逐轮切换：奇数轮用原始引用，偶数轮互换；只改 id 引用，器材本身不移动 |
| `repeat.rotate` | 逐轮把列出的 id 循环后移一位，表达三人以上轮换；`swap` 即两元素的 `rotate`，二者互斥。只重映射 id，不旋转 offset |
| `slowMotion` | 不改变时间轴长度，只作为渲染提示（减速已由作者给的时长表达） |
| 角度 | 度数，0° 指向 +x（画面右），顺时针为正（因 y 轴向下） |
| `actors[].facing` | 可选初始朝向；缺省由第一次移动方向推断，全程不动则朝下 |
| `turn` 方向 | 由 `awayFrom` 决定：背向对手转，球从远离对手的一侧绕过；对手在正前/正后方时兜底逆时针 |
| `turn` 判定时刻 | 用转身阶段**开始时**对手的位置 |
| 同一阶段 | 内部动作同时发生，都以该阶段开始时的状态解析位置 |
| `toward` + `stopShort` | 从出发点朝目标的连线上，在距目标指定米数处停下 |
| `pass.to` | 接球人的 id（不是位置） |
| `run` | 无球跑动；持球者用 `run` 则球留在原地、归属释放 |
| id 命名空间 | `objects` / `actors` / `balls` 共用，必须全局唯一 |

校验分两层：Zod（结构、未知字段、缺省值）→ 业务规则（id 引用、坐标在场内、球权连续性）。
错误信息是中文并带字段路径，例如：

```
- variants[0].phases[1].actions[0].awayFrom：引用了不存在的 id「C」
- objects[0].pos：坐标 [25, 3] 超出场地范围（0..20 × 0..15）
- variants[0].phases[0].actions[0]：第 1 轮时球员「A」并未持球，不能 dribble
```
