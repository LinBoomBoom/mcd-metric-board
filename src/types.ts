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
