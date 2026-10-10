import type {
  ComboDetail,
  ComboPick,
  BreakdownItem,
  BreakdownResult,
  MenuData,
  NutritionItem,
  ScenarioHit,
  ScenarioResult,
} from './types.js';
import { buildNutritionIndex, lookupNutrition, normalizeName } from './matcher.js';

/**
 * 组合求解 · 套餐拆解 · 场景匹配
 *
 * ## 设计原则
 *
 * 三个功能都建立在同一批 MCP 原始数据上，不做任何推测：
 *   - 组合可选项来自 query-meal-detail 的 rounds[].choices[]
 *   - 单点价来自 query-meals 的 meals[][]（当前门店实付价）
 *   - 营养数据来自 list-nutrition-foods
 *
 * ## 覆盖率必须诚实
 *
 * 实测：套餐内可选项常有 37 项，但门店菜单中仅 15 项可单独定价
 * （多数小食/饮品不单卖）。因此：
 *   - 「可完整比价」的组合数远小于理论组合总数
 *   - 无法定价的项一律标 null，绝不按同类项价格估算
 *   - 覆盖率由渲染层显式披露，与营养覆盖率同等对待
 */

/** 枚举上限，防止选择区过多导致组合爆炸 */
const MAX_ENUMERATION = 60_000;

/** 解析 "+ ¥0" / "- ¥1" / "+ ¥2.5" 形式的加价 */
export function parseDiffPrice(text: string | undefined): number {
  if (!text) return 0;
  const m = text.match(/([+-])\s*¥?\s*([0-9.]+)/);
  if (!m) return 0;
  const value = Number.parseFloat(m[2] ?? '0');
  if (!Number.isFinite(value)) return 0;
  return m[1] === '-' ? -value : value;
}

/**
 * 单点价格索引
 *
 * 门店菜单用**通用名**列价（「薯条」¥14.5、「可乐」¥9.5），
 * 而套餐选项用**规格名**（「中薯条」「可乐中杯」）。因此需要归一化映射。
 *
 * ⚠️ 只允许「中份 → 标准份」的映射：
 *   菜单列出的通用名对应的是标准（中）份价格。
 *   「大薯条」「小薯条」与「薯条」价格不同，绝不可映射 —— 否则会虚增省钱金额。
 */
export type PriceIndex = Map<string, number>;

export function buildPriceIndex(menu: MenuData): PriceIndex {
  const index: PriceIndex = new Map();
  for (const item of Object.values(menu.meals)) {
    const price = Number.parseFloat(item.currentPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    const key = normalizeName(item.name);
    if (!index.has(key)) index.set(key, price);
  }
  return index;
}

/** 可选：规格名前缀/后缀，剥离后等于标准份 */
const STANDARD_SUFFIXES = ['中杯', '中'] as const;
const STANDARD_PREFIXES = ['中', '中杯'] as const;

export function resolveSinglePrice(name: string, index: PriceIndex): number | null {
  const key = normalizeName(name);
  const direct = index.get(key);
  if (direct !== undefined) return direct;

  // 「可乐中杯」→「可乐」
  for (const suffix of STANDARD_SUFFIXES) {
    if (key.endsWith(suffix)) {
      const trimmed = key.slice(0, -suffix.length);
      const hit = index.get(trimmed);
      if (hit !== undefined) return hit;
    }
  }
  // 「中薯条」→「薯条」
  for (const prefix of STANDARD_PREFIXES) {
    if (key.startsWith(prefix)) {
      const trimmed = key.slice(prefix.length);
      const hit = index.get(trimmed);
      if (hit !== undefined) return hit;
    }
  }
  return null;
}

/** 笛卡尔积枚举：每个选择区取 1 项 */
function enumerateCombos(
  detail: ComboDetail,
): Array<Array<{ roundName: string; choice: ComboDetail['rounds'][number]['choices'][number] }>> {
  const rounds = detail.rounds.filter((r) => r.choices.length > 0);
  if (rounds.length === 0) return [];

  let total = 1;
  for (const r of rounds) {
    total *= r.choices.length;
    if (total > MAX_ENUMERATION) return [];
  }

  let acc: Array<Array<{ roundName: string; choice: (typeof rounds)[number]['choices'][number] }>> = [
    [],
  ];
  for (const round of rounds) {
    const next: typeof acc = [];
    for (const prefix of acc) {
      for (const choice of round.choices) {
        next.push([...prefix, { roundName: round.name, choice }]);
      }
    }
    acc = next;
  }
  return acc;
}

/** 统计理论组合总数 */
export function countCombos(detail: ComboDetail): number {
  const rounds = detail.rounds.filter((r) => r.choices.length > 0);
  if (rounds.length === 0) return 0;
  let total = 1;
  for (const r of rounds) {
    total *= r.choices.length;
    if (total > MAX_ENUMERATION) return total;
  }
  return total;
}

/**
 * 求解套餐最优组合
 *
 * 对每种组合计算套餐实付价、单点总价、蛋白质合计，并按三个目标各取最优：
 *   - 蛋白密度最高：营养数据完整时的性价比最优
 *   - 省得最多：相对单点价省下金额最大
 *   - 总蛋白最高：绝对蛋白量最大
 */
export function solveCombo(
  detail: ComboDetail,
  basePrice: number,
  originalPrice: number | null,
  menu: MenuData,
  nutrition: NutritionItem[],
  officialName: string,
): SolveResultLite {
  const priceIndex = buildPriceIndex(menu);
  const nutriIndex = buildNutritionIndex(nutrition);
  const combos = enumerateCombos(detail);

  const picks: ComboPick[] = [];

  for (const combo of combos) {
    const items: ComboPick['items'] = [];
    let totalPrice = basePrice;
    let singleSum: number | null = 0;
    let protein: number | null = 0;

    for (const { roundName, choice } of combo) {
      const diffPrice = parseDiffPrice(choice.diffPrice);
      totalPrice += diffPrice;

      const singlePrice = resolveSinglePrice(choice.name, priceIndex);
      if (singlePrice === null) singleSum = null;
      else if (singleSum !== null) singleSum += singlePrice;

      const n = lookupNutrition(choice.name, nutriIndex);
      if (!n) protein = null;
      else if (protein !== null) protein += n.protein;

      items.push({ roundName, name: choice.name, diffPrice, singlePrice, protein: n?.protein ?? null });
    }

    const saved = singleSum === null ? null : singleSum - totalPrice;
    const density = protein === null || totalPrice <= 0 ? null : (protein / totalPrice) * 100;

    picks.push({
      items,
      totalPrice,
      singleSum,
      saved,
      savedRatio: saved === null || singleSum === null || singleSum <= 0 ? null : saved / singleSum,
      protein,
      density,
      fullyComparable: singleSum !== null,
    });
  }

  const byDensity = picks
    .filter((p) => p.density !== null)
    .sort((a, b) => (b.density ?? 0) - (a.density ?? 0));
  const bySaving = picks
    .filter((p) => p.saved !== null)
    .sort((a, b) => (b.saved ?? 0) - (a.saved ?? 0));
  const byProtein = picks
    .filter((p) => p.protein !== null)
    .sort((a, b) => (b.protein ?? 0) - (a.protein ?? 0));
  const noSurcharge = picks
    .filter((p) => Math.abs(p.totalPrice - basePrice) < 1e-9)
    .sort((a, b) => (b.density ?? 0) - (a.density ?? 0));

  return {
    comboName: officialName,
    basePrice,
    originalPrice,
    totalCombos: countCombos(detail),
    comparableCombos: bySaving.length,
    nutritionCombos: byDensity.length,
    bestByDensity: byDensity[0] ?? null,
    bestBySaving: bySaving[0] ?? null,
    bestByProtein: byProtein[0] ?? null,
    bestNoSurcharge: noSurcharge[0] ?? null,
    top: byDensity.slice(0, 12),
    roundsSummary: detail.rounds.map((r) => ({
      name: r.name,
      choiceCount: r.choices.length,
      pricedCount: r.choices.filter((c) => resolveSinglePrice(c.name, priceIndex) !== null).length,
      nutritionCount: r.choices.filter((c) => lookupNutrition(c.name, nutriIndex) !== undefined)
        .length,
    })),
  };
}

/** solveCombo 的返回类型（与 types.ts 的 SolveResult 对应） */
export type SolveResultLite = import('./types.js').SolveResult;

/**
 * 套餐拆解：逐项对比「套餐内加价」与「单点价」
 *
 * 回答的问题是：这套餐里每一项，单点要多少钱、套餐里加多少钱拿到。
 */
export function breakdownCombo(
  detail: ComboDetail,
  basePrice: number,
  originalPrice: number | null,
  menu: MenuData,
  nutrition: NutritionItem[],
  officialName: string,
): BreakdownResult {
  const priceIndex = buildPriceIndex(menu);
  const nutriIndex = buildNutritionIndex(nutrition);

  const items: BreakdownItem[] = [];
  for (const round of detail.rounds) {
    for (const choice of round.choices) {
      const diffPrice = parseDiffPrice(choice.diffPrice);
      const singlePrice = resolveSinglePrice(choice.name, priceIndex);
      const n = lookupNutrition(choice.name, nutriIndex);
      items.push({
        roundName: round.name,
        name: choice.name,
        diffPrice,
        singlePrice,
        value: singlePrice === null ? null : singlePrice - diffPrice,
        protein: n?.protein ?? null,
      });
    }
  }

  items.sort((a, b) => {
    // 有单点价的排前，按「单点价 − 加价」降序
    if (a.value === null && b.value === null) return a.name.localeCompare(b.name, 'zh');
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return b.value - a.value;
  });

  return {
    comboName: officialName,
    basePrice,
    originalPrice,
    officialSaved: originalPrice === null ? null : originalPrice - basePrice,
    items,
    pricedCount: items.filter((i) => i.singlePrice !== null).length,
    totalCount: items.length,
  };
}

/**
 * 非餐品过滤
 *
 * 实测问题：菜单里混有酱料、周边、卡券等非餐品（如「日式鲜磨山葵酱」¥3、
 * 「麦当劳素龙限定饼干」¥2），它们价格极低，会占据「预算内」场景的榜首，
 * 使结果失去决策意义。
 *
 * 因此场景匹配一律先过滤非餐品。这是**品类过滤**，不涉及任何健康判断。
 */
const NON_MEAL_PATTERN =
  /酱|周边|毛绒|玩具|徽章|贴纸|餐具|礼盒|钥匙扣|杯垫|捶|痒痒挠|卡$|麦金卡|口袋|挂件|摆件|杯套|纸袋|餐垫|饼干/;

export function isNonMeal(name: string): boolean {
  return NON_MEAL_PATTERN.test(name);
}

/** 场景匹配时使用的餐品视图 */
export interface MealView {
  name: string;
  price: number;
  protein: number | null;
  sodium: number | null;
}

/**
 * 场景匹配
 *
 * ## 为什么用「场景」而不是「人群」
 *
 * 活动规则禁止宣扬不健康饮食方式，参赛声明要求不构成营养专业建议。
 * 因此不做「健身人群」「减脂人群」这类人群标签 —— 那是健康宣称。
 *
 * 改用**客观约束**定义场景：价格上限、份量形态、供餐形态。
 * 用户自己会把场景投射到自己的身份上，但项目只陈述事实。
 *
 * ## 为什么按价格升序是错的
 *
 * 初版「预算 20 元以内」按价格升序排，实测首位全是 ¥2 饼干、¥3 酱料、¥7.5 纯水 ——
 * 因为最便宜的必然是非正餐。这把「预算内选什么」变成了「最便宜的是什么」，
 * 结果毫无决策价值。
 *
 * 修正：预算类场景在预算范围内**按蛋白密度排序**，并限定为有营养数据的完整餐品。
 * 这才是「在这个预算里，什么最值」。
 */
export function buildScenarios(): Array<{
  id: string;
  title: string;
  desc: string;
  criteria: string;
  match: (item: MealView) => boolean;
  sort: 'price-asc' | 'protein-desc' | 'density-desc';
}> {
  return [
    {
      id: 'budget',
      title: '¥20 以内',
      desc: '预算内按蛋白密度排序，只列有营养数据的完整餐品',
      criteria: '实付价 ≤ ¥20 且蛋白质 > 0，按蛋白密度降序',
      match: (item) => item.price <= 20 && (item.protein ?? 0) > 0,
      sort: 'density-desc',
    },
    {
      id: 'budget-30',
      title: '¥30 以内',
      desc: '预算内按蛋白密度排序，只列有营养数据的完整餐品',
      criteria: '实付价 ≤ ¥30 且蛋白质 > 0，按蛋白密度降序',
      match: (item) => item.price <= 30 && (item.protein ?? 0) > 0,
      sort: 'density-desc',
    },
    {
      id: 'protein-first',
      title: '蛋白质优先',
      desc: '按单份蛋白质克数从高到低，只列有营养数据的完整餐品',
      criteria: '蛋白质 > 0，按蛋白质克数降序',
      match: (item) => (item.protein ?? 0) > 0,
      sort: 'protein-desc',
    },
    {
      id: 'sharing',
      title: '多人分享',
      desc: '双人餐、拼盘、多人餐等适合分食的选项',
      criteria: '名称含 双人 / 分享 / 拼盘 / 多人 / 宫格 / 桶',
      match: (item) => /双人|分享|拼盘|多人|派对|宫格|桶|亲子/.test(item.name),
      sort: 'density-desc',
    },
    {
      id: 'solo-solid',
      title: '一份管饱',
      desc: '汉堡、卷类等独立成餐的选项，按蛋白密度排序',
      criteria: '汉堡 / 卷 / 堡类，按蛋白密度降序',
      match: (item) => /汉堡|堡|卷/.test(item.name) && (item.protein ?? 0) > 0,
      sort: 'density-desc',
    },
  ];
}

/** 在菜单上执行场景匹配 */
export function runScenario(
  scenario: ReturnType<typeof buildScenarios>[number],
  menu: MenuData,
  nutrition: NutritionItem[],
  limit = 10,
): ScenarioResult {
  const nutriIndex = buildNutritionIndex(nutrition);
  const hits: ScenarioHit[] = [];

  for (const item of Object.values(menu.meals)) {
    const price = Number.parseFloat(item.currentPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    // 先过滤非餐品（酱料、周边、卡券、饼干），否则低价配件会占据预算类场景榜首
    if (isNonMeal(item.name)) continue;

    const n = lookupNutrition(item.name, nutriIndex);
    const view: MealView = {
      name: item.name,
      price,
      protein: n?.protein ?? null,
      sodium: n?.sodium ?? null,
    };
    if (!scenario.match(view)) continue;

    hits.push({
      name: item.name,
      price,
      protein: view.protein,
      sodium: view.sodium,
      density: n && price > 0 ? (n.protein / price) * 100 : null,
      matchedBy: scenario.criteria,
    });
  }

  hits.sort((a, b) => {
    switch (scenario.sort) {
      case 'price-asc':
        return a.price - b.price;
      case 'protein-desc':
        return (b.protein ?? -1) - (a.protein ?? -1);
      case 'density-desc':
      default: {
        const d = (b.density ?? -1) - (a.density ?? -1);
        return Math.abs(d) > 1e-9 ? d : a.price - b.price;
      }
    }
  });

  return {
    scenario: {
      id: scenario.id,
      title: scenario.title,
      desc: scenario.desc,
      criteria: scenario.criteria,
    },
    hits: hits.slice(0, limit),
    totalMatched: hits.length,
  };
}
