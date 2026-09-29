# 足球训练图转战术板动画

把足球训练书的一页（训练图 + 文字说明）转成可播放、可微调、可导出视频的战术板动画。
手机优先，界面全中文。

需求文档：[docs/spec.md](docs/spec.md)

**当前进度：阶段一至四完成，阶段五（部署）进行中。**

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 一 | Drill JSON 契约、纯函数引擎、Canvas 播放器 | ✅ |
| 二 | 拍书页 → 大模型识别 → 校验 → 预览 | ✅ |
| 三 | 拖拽编辑器、训练库、版本历史、导入导出 | ✅ |
| 四 | 导出 MP4 / PNG，中文配音 | ✅ |
| 五 | Docker 部署、限频 | 进行中 |

## 一条命令跑起来（Docker）

```bash
cp .env.example .env     # 填入大模型和语音合成的凭据
docker compose up -d
```

打开 `http://<这台机器的IP>:8787`。手机连同一个 WiFi 就能用。

镜像里带了 **ffmpeg**（编码 MP4、混配音）和 **Noto CJK 中文字体**（没有它导出的
说明文字会变方框）。启动日志会把这些都打印出来：

```
API 已启动：http://localhost:8787
训练库：    /data/drills.db
导出目录：  /data/exports
配音：      火山引擎 seed-tts-2.0，音色 zh_female_vv_uranus_bigtts
导出字体：  Noto Sans CJK SC、Noto Serif CJK SC 等 N 种
前端：      /app/apps/web/dist
限频：      识别接口每 IP 每小时 20 次
```

### 容器里访问宿主机上的网关

如果大模型网关跑在**宿主机**上，`.env` 里的地址要改：

```diff
- AI_BASE_URL=http://127.0.0.1:38080
+ AI_BASE_URL=http://host.docker.internal:38080
```

容器里的 `127.0.0.1` 是容器自己，不是宿主机 —— 照原样填会连不上，
识别功能直接失效。`docker-compose.yml` 里已经配了 `extra_hosts`，
所以 Linux 上也认 `host.docker.internal`（Docker Desktop 自带）。

网关本来就在另一台机器上的话，填那台机器的地址即可，不受此影响。

数据（训练库、导出的视频、配音缓存）都在 `liveboard-data` 卷里的 `/data`，
删容器不丢数据。备份就是把卷里的 `drills.db` 拷出来，或在训练库页点「导出全部备份」。

### 关于 HTTPS 和「添加到主屏幕」

现阶段是局域网自用，`docker-compose.yml` 只映射 `8787` 端口，不做公网暴露。

**纯 HTTP 下 iOS 和 Android 都装不了真正的 PWA**（Service Worker 要求安全上下文），
只能存成书签。`manifest.webmanifest` 和各尺寸图标已经备好，等以后接上 HTTPS
立刻生效，不用改代码。出门要用时有两条路：

- **Tailscale**：服务不暴露公网，手机装客户端后用 `xxx.ts.net` 访问，
  Tailscale 直接签发可信证书。不需要备案。
- **域名 + 备案 + 反向代理**：国内云主机的 80/443 在 ICP 备案下来前是封的。
  备案后在前面加一层 Caddy 自动签证书即可，本服务本身不用动。

公网暴露前务必给识别接口加访问口令 —— 否则别人能拿你的模型额度跑图。

## 本地开发

```bash
pnpm install
pnpm dev:all     # 前端 5175（Vite，代理 /api）+ 后端 8787
```

终端会打印 `Network: http://192.168.x.x:5175/`，手机连同一 WiFi 用这个地址。
开发模式下前后端分端口，生产模式下前端产物由后端一起托管（同源、单端口）。

### 环境要求

- Node.js ≥ 22（开发用 26.8）
- pnpm 10.33.2（`packageManager` 字段已钉住版本；不钉的话新版 pnpm 的
  `minimumReleaseAge` 策略会拒掉刚发布的依赖，构建随机失败）
- ffmpeg（视频导出用；Docker 镜像里已带）

## 环境变量

复制 `.env.example` 为 `.env` 后填写。**`.env` 已在 `.gitignore` 里，密钥只存后端，
前端永不直连大模型**（docs/spec.md 第 7 节）。

### 大模型（照片识别）

| 变量 | 说明 |
| --- | --- |
| `AI_PROVIDER` | `anthropic`（Messages API）或 `openai`（Chat Completions），都能对接自建网关 |
| `AI_MODEL` | 模型 id，填网关实际支持的名字 |
| `AI_BASE_URL` | 接口地址；留空用官方默认 |
| `AI_API_KEY` | 凭据；留空时依次回退 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `AI_AUTH_STYLE` | `bearer` 或 `x-api-key`；留空自动判断 |
| `AI_MAX_OUTPUT_TOKENS` | 单次识别输出上限，默认 16000 |
| `AI_EFFORT` | 思考档位，只有 Claude 支持；转发其它模型的网关请留空 |
| `AI_DISABLE_STRUCTURED_OUTPUT` | 网关不支持 `output_config` / `response_format` 时置 1；留 0 也安全（首次报错会自动退化并记住） |

先跑 `pnpm probe` 探明网关支持到什么程度，再决定要不要动后两项。

### 语音合成（导出配音）

| 变量 | 说明 |
| --- | --- |
| `TTS_PROVIDER` | `volcano`（火山引擎大模型语音合成）/ `mac-say`（本机自测，仅 macOS）/ 留空不配音 |
| `VOLCANO_TTS_BASE_URL` | 端点。可给完整地址（如 `https://openspeech.bytedance.com/api/v3/tts/unidirectional`）或主机根地址 |
| `VOLCANO_TTS_TRANSPORT` | `chunked` / `sse`；留空按端点末尾自动判断 |
| `VOLCANO_TTS_API_KEY` | 新版控制台凭据 |
| `VOLCANO_TTS_APP_ID` + `VOLCANO_TTS_ACCESS_KEY` | 旧版控制台凭据（与上一项二选一） |
| `VOLCANO_TTS_RESOURCE_ID` | 决定模型版本与计费方式，默认 `seed-tts-2.0`（没有 cluster 参数） |
| `TTS_VOICE` | **音色 ID，不是控制台里的展示名**。例：Vivi 2.0 要填 `zh_female_vv_uranus_bigtts`。填展示名会报 `resource ID is mismatched with speaker related resource` |
| `TTS_CACHE_DIR` | 合成结果缓存目录，按内容哈希命中，同一训练反复导出不重复计费 |

`pnpm probe:tts "一句话"` 只合成一句验证凭据和音色，成本可忽略。

### 服务端

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 8787 |
| `WEB_DIST` | 前端产物目录。设了就由本服务一起托管（生产模式）；开发时不设 |
| `DB_PATH` | SQLite 文件位置，默认 `data/drills.db`（相对启动目录，启动日志会打印绝对路径） |
| `EXPORT_DIR` | 导出视频存放目录，文件保留 1 小时 |
| `EXPORT_CONCURRENCY` | 同时渲染几个导出任务，默认 1（1080p 逐帧是纯 CPU 活，并发只会互相拖慢） |
| `FFMPEG_PATH` | ffmpeg 可执行文件路径，默认走 PATH |
| `RECOGNIZE_RATE_LIMIT_PER_HOUR` | 识别接口每 IP 每小时次数上限，默认 20（防止 API 费用失控） |

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:all` | 前后端一起起（开发） |
| `pnpm dev` / `pnpm dev:api` | 只起前端 / 只起后端 |
| `pnpm test` | 全部单元与接口测试 |
| `pnpm typecheck` | 全仓 TypeScript 类型检查 |
| `pnpm build` | 构建前端到 `apps/web/dist` |
| `pnpm probe` | 探测大模型网关：协议 / 凭据 / 图片输入 / 结构化输出 |
| `pnpm probe:tts "文字"` | 合成一句话，验证语音凭据与音色（真实调用，计费） |
| `pnpm recognize <图片>` | 走完整识别流程并打印结果（真实调用，计费） |
| `pnpm eval` | 批量评测 `fixtures/pages/` 下所有书页，输出逐项得分（真实调用，计费） |
| `pnpm preview:export [json] [变化] [横竖屏]` | 渲染静态图和视频到 `/tmp`，肉眼检查画面 |
| `pnpm preview:voice [json] [变化]` | 用本机合成器走一遍配音链路，检查时间轴 |

## 目录结构

```
├── apps/
│   ├── web/              手机端网页：播放、上传、编辑器、训练库、导出
│   └── server/           API：识别、训练库、导出任务、静态托管
├── packages/
│   ├── drill-schema/     Drill JSON 的 Zod 定义、类型、业务校验规则
│   ├── drill-engine/     纯函数：JSON → 时间线，给定 t 返回各对象位置与朝向
│   ├── drill-render/     把某一帧画到 Canvas 2D（播放与导出共用）
│   ├── drill-ai/         大模型接入：提供商抽象、提示词、识别与重试
│   ├── drill-export/     Node 端逐帧渲染 + ffmpeg 合成 MP4 / PNG / 配音混流
│   └── drill-tts/        文字转语音：提供商抽象 + 按内容缓存
├── docs/spec.md          需求文档
├── fixtures/             测试夹具（书页素材不进仓库，见 fixtures/pages/README.md）
├── Dockerfile
└── docker-compose.yml
```

`drill-engine` 与 `drill-render` 不依赖任何 UI 框架，**前端播放和服务端逐帧导出调用
同一份代码** —— 这是「导出视频与预览画面完全一致」的技术保证，而不是靠截图。

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

## 动画细节

路径用**向心 Catmull-Rom** 平滑，曲线精确穿过每个路点 —— 路点往往就是锥桶，
「跑到锥桶再折返」如果被切角抄近道就把练法讲错了。接近掉头的折返保留尖角
（真人也是先停下再掉头），共线的点仍是直线。

连续跑动用**梯形速度曲线**：只在整段路线的头尾加减速，中间匀速。
每个阶段各自 easeInOut 会让球员在每个阶段边界减速到 0 再起步，看着一顿一顿。
