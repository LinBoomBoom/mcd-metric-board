/**
 * 麦当劳 MCP 数据结构定义
 *
 * 所有类型均依据 MCP Server v1.0.9 实测响应推导，非文档抄录。
 * 实测样本：上海静安寺店 storeCode=1450002（24h 营业），2026-10-09 23:32
 */

// ============ 原始响应 ============

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: T;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/** 接口统一返回信封 */
export interface ApiEnvelope<T> {
  success: boolean;
  code: number;
  message: string;
  datetime: string;
  traceId: string;
  data: T;
}

// ============ 门店 ============

export interface Store {
  storeCode: string;
  storeName: string;
  address: string;
  distance: number;
  businessStatus: boolean;
  businessStartTime: string;
  businessEndTime: string;
  longitude: number;
  latitude: number;
  reservation: boolean;
  reservationTimeOptions?: Array<{
    date: string;
    today: boolean;
    reservationOptionText: string;
  }>;
}

// ============ 菜单 ============

export interface MealItem {
  name: string;
  image?: string;
  /** 实付价（字符串型数字）。注意：已是实付价，不是原价 */
  currentPrice: string;
  originalPrice?: string;
  canWithOrder?: boolean;
}

/** data.categories[].meals[] 只有编码；名称价格统一在 data.meals */
export interface MenuCategory {
  name: string;
  meals: Array<{ code: string; tags?: string[] }>;
}

export interface MenuData {
  categories: MenuCategory[];
  /** 以餐品编码为键 */
  meals: Record<string, MealItem>;
}

// ============ 营养表 ============

export interface NutritionItem {
  productName: string;
  energyKj: number;
  energyKcal: number;
  protein: number;
  fat: number;
  carbohydrate: number;
  sodium: number;
  calcium: number;
}

// ============ 时间 ============

export interface TimeData {
  date: string;
  datetime: string;
  day: number;
  dayOfWeek: string;
  formatted: string;
}

// ============ 积分账户 ============

export interface AccountData {
  accountId: string;
  accumulativePoint: string;
  availablePoint: string;
  currency: string;
  /** 本月将过期积分 —— 「我的常点榜」过期提醒的数据来源 */
  currentMouthExpirePoint?: string;
}

// ============ 领域模型 ============

export interface RankedItem {
  code: string;
  name: string;
  price: number;
  protein?: number;
  sodium?: number;
  kcal?: number;
  /** 每百元蛋白质克数；仅在有营养数据时存在 */
  density?: number;
  /** 密度条宽度基准（0-100），榜单内相对比例 */
  densityRatio?: number;
  /** 匹配方式，用于 README 说明与调试 */
  matchType?: 'exact' | 'normalized' | 'contains';
  /** 归一化匹配时命中的营养表名称 */
  matchedNutritionName?: string;
  image?: string;
}

export interface Coverage {
  total: number;
  matched: number;
  ratio: number;
}

export interface UnmatchedItem {
  code: string;
  name: string;
  price: number;
}

export interface RankResult {
  storeCode: string;
  storeName: string;
  ranked: RankedItem[];
  unmatched: UnmatchedItem[];
  coverage: Coverage;
  medianDensity: number;
  computedAt: string;
}

/** 时段定义，直接采用官方口径 */
export type MealPeriod = 'breakfast' | 'lunch' | 'tea' | 'dinner' | 'closed';

export interface StoreAvailability {
  storeCode: string;
  storeName: string;
  distance: number;
  startTime: string;
  endTime: string;
  isOpenNow: boolean;
  /** 距打烊分钟数；已打烊为 null */
  minutesToClose: number | null;
  /** 打烊倒计时的自然表述，如「45 分钟后打烊」。避免出现「0 小时后打烊」 */
  closingSoonText?: string;
  onSaleCount: number | null;
  status: 'open' | 'closing' | 'closed' | 'unavailable';
}

export class McdApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly context?: string,
  ) {
    super(message);
    this.name = 'McdApiError';
  }
}

/** 打烊错误码（实测 600057） */
export const STORE_CLOSED_CODE = 600057;

/** 商品未匹配（实测 60001，通常是入参字段名写错） */
export const MEAL_NOT_FOUND_CODE = 60001;

// ============ 套餐详情（组合可选清单）============

/**
 * 套餐内可增删的配料
 *
 * 实测来源：query-meal-detail → data.rounds[].choices[].modification.items[].values[]
 * 这是「配料定制器」的数据基础，属口味偏好而非营养建议。
 */
export interface ModifyValue {
  code: string;
  name: string;
  price: number;
  maxQuantity: number;
  minQuantity: number;
  selectedQuantity: number;
}

export interface ModifyGroup {
  minValues: number;
  maxValues: number;
  values: ModifyValue[];
}

/** 套餐中一个「区」内的一个可选项 */
export interface ComboChoice {
  code: string;
  name: string;
  quantity: number;
  maxQuantity: number;
  isDefault: number;
  /** 形如 "+ ¥0" / "- ¥1" / "+ ¥2.5" */
  diffPrice: string;
  supportModify: boolean;
  modification?: { items: ModifyGroup[] };
}

/** 套餐中的一个选择区，如「蓝区」「主食任意选」 */
export interface ComboRound {
  id: number;
  name: string;
  quantity: number;
  maxQuantity: number;
  minQuantity: number;
  choices: ComboChoice[];
}

/** 套餐详情：组合可选清单 */
export interface ComboDetail {
  code: string;
  name: string;
  image?: string;
  supportModify: boolean;
  rounds: ComboRound[];
}

// ============ 求解结果 ============

/** 一个候选组合（每个选择区取一项） */
export interface ComboPick {
  items: Array<{
    roundName: string;
    name: string;
    /** 相对套餐基础价的加价，可为负 */
    diffPrice: number;
    /** 该单品的单点价；未知为 null */
    singlePrice: number | null;
    protein: number | null;
  }>;
  /** 套餐实付总价 = 基础价 + 各选项加价 */
  totalPrice: number;
  /** 各单品单点价之和；有未知项则为 null */
  singleSum: number | null;
  /** 相对单点省下多少 = singleSum - totalPrice；未知为 null */
  saved: number | null;
  /** 相对单点省的百分比 */
  savedRatio: number | null;
  /** 蛋白质合计；有未知项则为 null */
  protein: number | null;
  /** 每百元蛋白密度 */
  density: number | null;
  /** 是否所有选项都拿到了单点价 */
  fullyComparable: boolean;
}

export interface SolveResult {
  comboName: string;
  basePrice: number;
  originalPrice: number | null;
  /** 理论组合总数（各选择区选项数之积） */
  totalCombos: number;
  /** 可完整比价的组合数 */
  comparableCombos: number;
  /** 拿到营养数据的组合数 */
  nutritionCombos: number;
  /** 按不同目标排出的最优组合 */
  bestByDensity: ComboPick | null;
  bestBySaving: ComboPick | null;
  bestByProtein: ComboPick | null;
  /** 不加价的最优（totalPrice === basePrice） */
  bestNoSurcharge: ComboPick | null;
  /** 各档位代表组合，用于列表展示 */
  top: ComboPick[];
  roundsSummary: Array<{
    name: string;
    choiceCount: number;
    pricedCount: number;
    nutritionCount: number;
  }>;
}

/** 套餐拆解：单个可选项的价值对比 */
export interface BreakdownItem {
  roundName: string;
  name: string;
  diffPrice: number;
  singlePrice: number | null;
  /** 单点价 − 套餐内加价；即选这项比单点省多少 */
  value: number | null;
  protein: number | null;
}

export interface BreakdownResult {
  comboName: string;
  basePrice: number;
  originalPrice: number | null;
  officialSaved: number | null;
  items: BreakdownItem[];
  pricedCount: number;
  totalCount: number;
}

/** 场景：一组客观筛选条件 */
export interface Scenario {
  id: string;
  title: string;
  desc: string;
  criteria: string;
}

export interface ScenarioHit {
  name: string;
  price: number;
  protein: number | null;
  sodium: number | null;
  density: number | null;
  matchedBy: string;
}

export interface ScenarioResult {
  scenario: Scenario;
  hits: ScenarioHit[];
  totalMatched: number;
}
