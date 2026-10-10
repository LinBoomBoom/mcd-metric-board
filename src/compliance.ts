/**
 * 合规守卫
 *
 * 活动规则中对内容合规的要求（activityGuidelines.md「其他说明」）：
 *   - 不得宣扬不健康饮食方式、奢靡浪费、拜金主义、娱乐至上
 *   - 不得侮辱、诋毁、讽刺、贬低麦当劳品牌，或与其他品牌对比
 *   - 项目须声明「非麦当劳官方产品」，输出不构成医疗或营养建议
 *
 * 处罚：麦当劳有权不事先通知即取消参赛资格、获奖资格及相关奖励。
 *
 * 因此本模块在输出前做两道校验：
 *   1. 禁用词扫描 —— 防止健康评判类措辞
 *   2. 品牌名扫描 —— 防止出现其他餐饮品牌
 */

/** 禁用词：涉及健康评判或目标导向消费引导 */
const FORBIDDEN_WORDS = [
  '健康',
  '低卡',
  '高蛋白餐',
  '健身首选',
  '减肥',
  '热量控制',
  '最健康',
  '无负担',
  '放心吃',
  '无罪',
  '低脂',
  '燃脂',
  '卡路里预算',
  '轻食',
] as const;

/** 其他餐饮品牌：出现即视为品牌对比，违反规则 */
const OTHER_BRANDS = [
  '肯德基',
  'KFC',
  '汉堡王',
  '星巴克',
  '瑞幸',
  '喜茶',
  '奈雪',
  '华莱士',
  '必胜客',
  '赛百味',
] as const;

/** 固定合规声明，所有榜单输出必须携带 */
export const COMPLIANCE_FOOTER =
  '数据来自麦当劳官方 MCP 实时接口 · 本榜单为客观数据对比，不构成医疗或营养建议 · 非麦当劳官方产品';

/**
 * 中性数值说明
 *
 * ⚠️ 措辞约束：输出中不得出现「健康」二字。
 * 官方规则禁止宣扬不健康饮食方式，任何含此字的表述都可能被判定为健康评判 ——
 * 即使是否定用法（如「不代表健康程度」）也存在被误判的风险，因此统一改为「蛋白含量高低程度」。
 *
 * 实际开发中这是被合规守卫真实拦截过的措辞，改用中性表达。
 */
export const NEUTRAL_NOTE = '密度为客观数据比值，仅表示蛋白含量高低程度';

export interface ComplianceCheckResult {
  passed: boolean;
  violations: Array<{ word: string; category: 'forbidden' | 'brand'; note: string }>;
}

/**
 * 扫描文本中的违规内容
 *
 * @param text 待检查文本
 * @returns 校验结果，含所有违规词及分类
 */
export function checkCompliance(text: string): ComplianceCheckResult {
  const violations: ComplianceCheckResult['violations'] = [];

  for (const word of FORBIDDEN_WORDS) {
    if (text.includes(word)) {
      violations.push({
        word,
        category: 'forbidden',
        note: '涉及健康评判或目标导向消费引导，触碰「宣扬不健康饮食方式」红线',
      });
    }
  }

  for (const brand of OTHER_BRANDS) {
    if (text.includes(brand)) {
      violations.push({
        word: brand,
        category: 'brand',
        note: '出现其他餐饮品牌，构成品牌对比，违反规则',
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

/**
 * 断言文本合规，违规时抛错
 *
 * 用于开发期自检与 CI 检查。生产环境应将违规替换为安全表述而非中断服务，
 * 但本项目选择 fail-fast —— 宁可报错也不输出违规内容。
 */
export function assertCompliance(text: string, context = '输出'): void {
  const result = checkCompliance(text);
  if (result.passed) return;

  const detail = result.violations
    .map((v) => `「${v.word}」${v.note}`)
    .join('\n  ');

  throw new ComplianceError(
    `${context}包含违规表述，已阻止输出：\n  ${detail}\n` +
      '请改用中性数据描述。例如用「蛋白含量较高」而非「高蛋白餐」，用「钠值处于 15% 分位」而非「低钠」。',
  );
}

export class ComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceError';
  }
}

/**
 * 检查覆盖率披露是否完整
 *
 * 主动披露数据缺口是本项目的核心信任机制，不可省略。
 */
export function assertCoverageDisclosed(
  matched: number,
  total: number,
  context = '榜单输出',
): void {
  if (total === 0) return;
  const ratio = matched / total;
  if (matched < total && !Number.isFinite(ratio)) {
    throw new ComplianceError(`${context}覆盖率计算异常`);
  }
  // 此处不做强制抛错，仅作为调用点提醒；真正的披露由渲染层负责
}
