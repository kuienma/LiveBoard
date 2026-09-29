import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 提示词从 prompts/ 与 fixtures/ 读文件拼出来，不写死在代码里——
 * 阶段二的主要工作就是调提示词，改文本不该动代码、不该重新构建。
 *
 * 注意 ESM 里没有 __dirname，必须从 import.meta.url 推。
 */
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

const read = (relativePath: string): string =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8')

/**
 * few-shot 示例：一个带转身和 swap，一个带传球，覆盖两类典型训练。
 *
 * 注意：这里**不能**放验收用例「从侧边进攻」。它一度是示例一，结果模型识别那一页时
 * 直接照抄示例的坐标和时长（连书上写明的「梯形」布局都没读），测出来的是记忆不是识别。
 * 示例必须和待测页面是不同的训练。
 */
const EXAMPLE_FILES = [
  { title: '示例一：《突破》「转身后向边路突破」——含 turn / awayFrom / toward+stopShort / swap', file: 'fixtures/wing-breakthrough.json' },
  { title: '示例二：《传球》「四角传球」——含 pass / rotate 多人轮转', file: 'fixtures/passing-square.json' },
] as const

let cached: string | undefined

/**
 * 拼出识别用的 system 提示词：格式说明 + 坐标约定 + 动作类型 + 两个完整 few-shot 示例
 * （docs/spec.md 第 4.1 节的要求）。结果缓存，进程内只读一次盘。
 */
export function buildSystemPrompt(): string {
  if (cached !== undefined) return cached

  const sections = [read('prompts/recognize-system.md').trimEnd()]

  for (const example of EXAMPLE_FILES) {
    // 压掉缩进省 token，示例本身的字段用法不受影响
    const compact = JSON.stringify(JSON.parse(read(example.file)))
    sections.push(
      '',
      `### ${example.title}`,
      '',
      JSON.stringify(
        {
          drill: JSON.parse(compact),
          understanding: EXAMPLE_UNDERSTANDING[example.file],
          uncertainties: EXAMPLE_UNCERTAINTIES[example.file],
        },
        null,
        0,
      ),
    )
  }

  cached = sections.join('\n')
  return cached
}

/** 示例的「我的理解」，示范这段话该写到什么详细程度。 */
const EXAMPLE_UNDERSTANDING: Record<string, string> = {
  'fixtures/wing-breakthrough.json':
    '场地约 24×18 米。下方中间是出发锥桶，往前 8 米是一个高的红色锥桶作为转身点，' +
    '上方左右各有一个黄色锥桶当作出球门。进攻者 A 持球从出发锥桶出发，防守者 D 从右边的门压上。' +
    '基本练法：A 带球推进到高锥桶前，同时 D 从右门斜插过来逼球，在距高锥桶 2.5 米处到位；' +
    'A 在高锥桶前做 90 度转身，背向 D 转，转身后朝左侧的门加速带球出去；D 则退回自己的门。' +
    '共做 3 轮，每轮结束后左右两个门的引用互换，所以下一轮 D 从另一侧压上、A 从另一侧出球。',
  'fixtures/passing-square.json':
    '场地约 20×20 米，四个锥桶摆成边长 10 米的正方形，四名球员各站一个锥桶外侧，教练在场地下方观察。' +
    '基本练法：球从 A 开始沿正方形顺时针传递，A 传 B、B 传 C、C 传 D、D 传回 A，每脚传球约 1.1 秒，共传 3 圈。' +
    '变化一：传完一圈后四人同时轮转到下一个锥桶（A 去 c2、B 去 c3、C 去 c4、D 去 c1），' +
    '如此循环 4 轮，每人正好绕回原位；用 rotate 表达这种四人轮换。',
}

/** 示例的不确定点，示范「该承认哪些是猜的」。 */
const EXAMPLE_UNCERTAINTIES: Record<string, string[]> = {
  'fixtures/wing-breakthrough.json': [
    '场地尺寸书上没标，按图中锥桶间距估为 24×18 米',
    '转身角度书上写「转身」没给度数，按图中方向估为 90 度',
    '防守者退回门的具体路线书上没画，按直线返回处理',
  ],
  'fixtures/passing-square.json': [
    '正方形边长书上没标，按 10 米估',
    '每脚传球的节奏书上没写，按 1.1 秒估',
    '变化一里轮转的方向（顺时针还是逆时针）书上没画箭头，按顺时针处理',
  ],
}

/** 每次识别随图片一起发的用户指令。 */
export function buildUserInstruction(pageCount: number): string {
  const pages =
    pageCount > 1
      ? `这是同一个训练的 ${pageCount} 页照片，请合起来看。`
      : '这是一页训练书的照片。'

  return [
    pages,
    '请按 system 里的格式输出一个 JSON 对象，包含 drill、understanding、uncertainties 三个字段。',
    '再次强调：读文字说明理解训练规则，识别出所有「变化」并各生成一个 variant，只输出 JSON。',
  ].join('\n')
}
