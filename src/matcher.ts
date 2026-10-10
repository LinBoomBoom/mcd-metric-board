import type { MenuData, NutritionItem, RankedItem, UnmatchedItem } from './types.js';

/**
 * 餐名匹配引擎
 *
 * ## 设计原则：宁可少算，不可错算
 *
 * 官方营养表（158 项）与门店实时菜单（122 项）存在版本差。
 * 匹配不上的餐品一律标注「暂无营养数据」，绝不猜测映射。
 *
 * ## 三级降级策略（逐级放宽，但不放宽准确性）
 *
 * 1. 完全相等      —— 巨无霸、麦香鸡、板烧鸡腿堡
 * 2. 去括号后相等  —— 那么大鸡排（椒盐风味）→ 那么大鸡排
 * 3. 一方包含另一方 —— 四件套类（需 ≥3 字符防误匹配）
 *
 * 实测命中率：63 / 122 = 51.6%
 */

/** 去除括号及其内容，用于归一化 */
export function normalizeName(name: string): string {
  return name
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 包含匹配的最小字符数，低于此值不启用包含匹配以防误配 */
const MIN_CONTAINS_LENGTH = 3;

/**
 * 营养表索引
 *
 * 供 matcher 与 solver 共用，避免重复实现三级匹配。
 */
export interface NutritionIndex {
  exact: Map<string, NutritionItem>;
  normalized: Map<string, NutritionItem>;
}

export function buildNutritionIndex(nutrition: NutritionItem[]): NutritionIndex {
  const exact = new Map<string, NutritionItem>();
  const normalized = new Map<string, NutritionItem>();
  for (const item of nutrition) {
    exact.set(item.productName, item);
    const norm = normalizeName(item.productName);
    if (!normalized.has(norm)) normalized.set(norm, item);
  }
  return { exact, normalized };
}

/**
 * 三级降级查询单个名称对应的营养项
 *
 * 与 matchAndRank 使用完全相同的策略，保证两处结果一致。
 * 查不到返回 undefined —— 调用方必须显式处理「暂无营养数据」，不得猜测。
 */
export function lookupNutrition(
  name: string,
  index: NutritionIndex,
): NutritionItem | undefined {
  const exact = index.exact.get(name);
  if (exact) return exact;

  const norm = normalizeName(name);
  const normHit = index.normalized.get(norm);
  if (normHit) return normHit;

  if (norm.length < MIN_CONTAINS_LENGTH) return undefined;

  const candidates: Array<{ item: NutritionItem; len: number }> = [];
  for (const [key, item] of index.normalized) {
    if (key.length < MIN_CONTAINS_LENGTH) continue;
    if (key.includes(norm) || norm.includes(key)) {
      candidates.push({ item, len: key.length });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.len - b.len);
  return candidates[0]!.item;
}

export interface MatchResult {
  matched: RankedItem[];
  unmatched: UnmatchedItem[];
  matchedCount: number;
  totalCount: number;
}

/**
 * 将菜单与营养表匹配，并计算蛋白密度
 *
 * @param menu      门店实时菜单
 * @param nutrition 官方营养成分表
 */
export function matchAndRank(menu: MenuData, nutrition: NutritionItem[]): MatchResult {
  // 营养表索引：精确名 + 归一化名
  const exactIndex = new Map<string, NutritionItem>();
  const normalizedIndex = new Map<string, NutritionItem>();

  for (const item of nutrition) {
    exactIndex.set(item.productName, item);
    const norm = normalizeName(item.productName);
    // setIfAbsent 语义：归一化索引不覆盖已存在的精确映射
    if (!normalizedIndex.has(norm)) {
      normalizedIndex.set(norm, item);
    }
  }

  const matched: RankedItem[] = [];
  const unmatched: UnmatchedItem[] = [];

  for (const [code, meal] of Object.entries(menu.meals)) {
    const name = meal.name;
    const price = Number.parseFloat(meal.currentPrice);

    if (!Number.isFinite(price)) {
      unmatched.push({ code, name, price: 0 });
      continue;
    }

    // 逐级匹配
    let nutritionItem: NutritionItem | undefined;
    let matchType: RankedItem['matchType'];
    let matchedName: string | undefined;

    // 一级：完全相等
    const exact = exactIndex.get(name);
    if (exact) {
      nutritionItem = exact;
      matchType = 'exact';
      matchedName = name;
    }

    // 二级：归一化后相等
    if (!nutritionItem) {
      const norm = normalizeName(name);
      const normHit = normalizedIndex.get(norm);
      if (normHit) {
        nutritionItem = normHit;
        matchType = 'normalized';
        matchedName = normHit.productName;
      }
    }

    // 三级：一方包含另一方
    if (!nutritionItem) {
      const norm = normalizeName(name);
      if (norm.length >= MIN_CONTAINS_LENGTH) {
        const candidates: Array<{ key: string; item: NutritionItem; len: number }> = [];
        for (const [key, item] of normalizedIndex) {
          if (key.length < MIN_CONTAINS_LENGTH) continue;
          if (key.includes(norm) || norm.includes(key)) {
            candidates.push({ key, item, len: key.length });
          }
        }
        if (candidates.length > 0) {
          // 取最短的匹配项：避免「麦辣鸡腿汉堡」误配到「麦辣鸡腿汉堡三件套」
          candidates.sort((a, b) => a.len - b.len);
          const best = candidates[0]!;
          nutritionItem = best.item;
          matchType = 'contains';
          matchedName = best.item.productName;
        }
      }
    }

    if (!nutritionItem) {
      unmatched.push({ code, name, price });
      continue;
    }

    matched.push({
      code,
      name,
      price,
      protein: nutritionItem.protein,
      sodium: nutritionItem.sodium,
      kcal: nutritionItem.energyKcal,
      // 核心指标：每百元蛋白质克数
      density: price > 0 ? (nutritionItem.protein / price) * 100 : 0,
      matchType,
      matchedNutritionName: matchedName,
      image: meal.image,
    });
  }

  // 按密度降序；密度相同则按价格升序
  matched.sort((a, b) => {
    const d = (b.density ?? 0) - (a.density ?? 0);
    if (Math.abs(d) > 1e-9) return d;
    return a.price - b.price;
  });

  // 计算相对比例与中位数
  const maxDensity = matched[0]?.density ?? 0;
  for (const item of matched) {
    item.densityRatio = maxDensity > 0 ? ((item.density ?? 0) / maxDensity) * 100 : 0;
  }

  const densities = matched.map((i) => i.density ?? 0).sort((a, b) => a - b);
  const median = densities.length > 0 ? densities[Math.floor(densities.length / 2)] ?? 0 : 0;

  return {
    matched,
    unmatched,
    matchedCount: matched.length,
    totalCount: matched.length + unmatched.length,
  };
}

/**
 * 钠值分布计算
 *
 * 与蛋白密度不同，钠值榜基于全量营养表而非门店菜单，
 * 因为用户想知道「菜单上有什么」的钠值分布，而不是「你现在能买到的」。
 */
export interface SodiumRankItem {
  productName: string;
  sodium: number;
  kcal: number;
  /** 全菜单百分位 0-100 */
  percentile: number;
}

export interface SodiumResult {
  items: SodiumRankItem[];
  min: number;
  max: number;
}

export function rankBySodium(nutrition: NutritionItem[]): SodiumResult {
  const withSodium = nutrition
    .filter((n) => Number.isFinite(n.sodium))
    .map((n) => ({ productName: n.productName, sodium: n.sodium, kcal: n.energyKcal }));

  if (withSodium.length === 0) {
    return { items: [], min: 0, max: 0 };
  }

  const values = withSodium.map((v) => v.sodium).sort((a, b) => a - b);
  const min = values[0] ?? 0;
  const max = values[values.length - 1] ?? 0;
  const span = max - min || 1;

  const items = withSodium
    .map((v) => ({
      ...v,
      percentile: ((v.sodium - min) / span) * 100,
    }))
    .sort((a, b) => a.sodium - b.sodium);

  return { items, min, max };
}
