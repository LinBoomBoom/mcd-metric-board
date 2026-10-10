import type {
  AccountData,
  ApiEnvelope,
  JsonRpcResponse,
  MenuData,
  NutritionItem,
  Store,
  TimeData,
} from './types.js';
import { McdApiError, STORE_CLOSED_CODE } from './types.js';

/**
 * 麦当劳 MCP Server 客户端
 *
 * Server: https://mcp.mcd.cn （Streamable HTTP）
 * 限流: 600 次/分钟，超限返回 429
 * 错误码: 401 Token 无效 / 429 限流 / 600057 门店已打烊
 *
 * ⚠️ 响应解析策略（实测踩坑记录）：
 * MCP 的响应是 JSON-RPC 包裹的文本，存在三层嵌套：
 *   result.content[0].text → "## Original Response" 标记的 JSON → data 可能是字符串化的 JSON/CSV
 * 优先读 result.structuredContent，比解析文本可靠；仅在缺失时回退到文本解析。
 */
export class McdClient {
  private requestId = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {
    if (!url || !token) {
      throw new Error('MCP Server 地址与 Token 不能为空');
    }
  }

  /** 从环境变量读取配置 */
  static fromEnv(): McdClient {
    const token = process.env.MCP_TOKEN ?? '';
    const url = process.env.MCP_URL ?? 'https://mcp.mcd.cn';
    if (!token) {
      throw new Error(
        '未找到 MCP Token。请设置环境变量 MCP_TOKEN，参考 mcp-config.example.json。' +
          '切勿将真实 Token 写入代码或提交到仓库。',
      );
    }
    return new McdClient(url, token);
  }

  /**
   * 调用 MCP Tool
   *
   * @throws {McdApiError} 接口返回 success=false 时抛出，code 600057 表示门店已打烊
   */
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    this.requestId += 1;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: this.requestId,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let payload: JsonRpcResponse<T>;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body,
        signal: controller.signal,
      });

      if (res.status === 401) {
        throw new McdApiError(401, 'MCP Token 无效或已过期，请重新申请', name);
      }
      if (res.status === 429) {
        throw new McdApiError(429, '触发限流（超过 600 次/分钟），请降低调用频率', name);
      }
      if (!res.ok) {
        throw new McdApiError(res.status, `MCP Server 返回 HTTP ${res.status}`, name);
      }

      payload = (await res.json()) as JsonRpcResponse<T>;
    } catch (err) {
      if (err instanceof McdApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new McdApiError(0, `调用 ${name} 超时（${this.timeoutMs}ms）`, name);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (payload.error) {
      throw new McdApiError(payload.error.code, payload.error.message, name);
    }

    const result = payload.result;
    if (!result) {
      throw new McdApiError(0, `调用 ${name} 无 result 返回`, name);
    }

    const envelope = this.extractEnvelope<T>(result.structuredContent, result.content?.[0]?.text);
    if (!envelope) {
      throw new McdApiError(0, `无法解析 ${name} 的响应结构`, name);
    }
    if (!envelope.success) {
      throw new McdApiError(envelope.code, envelope.message, name);
    }
    return envelope.data;
  }

  /** 三层嵌套提取：优先 structuredContent，回退到解析文本 */
  private extractEnvelope<T>(
    structured: unknown,
    text: string | undefined,
  ): ApiEnvelope<T> | null {
    // 第一优先：结构化响应
    if (structured && typeof structured === 'object') {
      const s = structured as Partial<ApiEnvelope<T>>;
      if (typeof s.success === 'boolean' && 'data' in s) {
        return s as ApiEnvelope<T>;
      }
    }

    // 回退：从文本里找 "## Original Response" 后的 JSON
    if (!text) return null;
    const marker = text.indexOf('## Original Response');
    const slice = marker >= 0 ? text.slice(marker + '## Original Response'.length) : text;
    const start = slice.indexOf('{');
    if (start < 0) return null;

    // 文本里可能有多段 JSON（文档模板会污染），逐个尝试
    for (let i = start; i < slice.length; i += 1) {
      if (slice[i] !== '{') continue;
      try {
        const parsed = JSON.parse(slice.slice(i)) as ApiEnvelope<T>;
        if (typeof parsed.success === 'boolean') return parsed;
      } catch {
        // 继续向后尝试下一个 '{'
      }
    }
    return null;
  }

  // ============ 业务方法 ============

  /** 获取当前完整时间 */
  async now(): Promise<TimeData> {
    return this.call<TimeData>('now-time-info');
  }

  /**
   * 查询附近门店
   *
   * ⚠️ 实测踩坑：searchType=1（收藏）时收藏列表为空，必须走 searchType=2 + 城市 + 关键词 + 经纬度
   */
  async nearbyStores(params: {
    beType?: 1 | 5;
    city?: string;
    keyword?: string;
    searchType?: 1 | 2;
    longitude?: number;
    latitude?: number;
  }): Promise<Store[]> {
    const args: Record<string, unknown> = { beType: params.beType ?? 1 };
    if (params.searchType !== undefined) args.searchType = params.searchType;
    if (params.city) args.city = params.city;
    if (params.keyword) args.keyword = params.keyword;
    if (params.longitude !== undefined) args.longitude = params.longitude;
    if (params.latitude !== undefined) args.latitude = params.latitude;
    return this.call<Store[]>('query-nearby-stores', args);
  }

  /**
   * 查询门店菜单
   *
   * ⚠️ 实测踩坑（三个都踩过，务必保留注释）：
   *   1. orderType 必传，漏了报 400
   *   2. beType 必传，漏了报 400「beType1-到店取餐…」
   *   3. beType=2/5/6 时还必须传 beCode（业务编码），仅 code 600048
   *      —— 得来速与外送场景需要 storeCode + beCode 配对
   *
   * 默认走 beType=1（到店取餐），这是唯一无需 beCode 的通用场景。
   */
  async menu(
    storeCode: string,
    opts: { beType?: 1 | 2 | 5 | 6; orderType?: 1 | 2; beCode?: string } = {},
  ): Promise<MenuData> {
    const beType = opts.beType ?? 1;
    const args: Record<string, unknown> = {
      storeCode,
      orderType: opts.orderType ?? (beType === 1 ? 1 : 2),
      beType,
    };
    if (opts.beCode) args.beCode = opts.beCode;
    return this.call<MenuData>('query-meals', args);
  }

  /**
   * 查询营养成分表
   *
   * 实测返回 160 行 CSV，字段顺序：
   * productName, nutritionDescription, energyKj, energyKcal,
   * protein, fat, carbohydrate, sodium, calcium
   *
   * 注意 nutritionDescription 全部为 null，不可用。
   */
  async nutrition(): Promise<NutritionItem[]> {
    const raw = await this.call<string>('list-nutrition-foods');
    return parseNutritionCsv(raw);
  }

  /** 查询积分账户（含 currentMouthExpirePoint） */
  async account(): Promise<AccountData> {
    return this.call<AccountData>('query-my-account');
  }
}

/**
 * 解析营养表 CSV
 *
 * 格式：[160]{字段列表}:
 *   餐品名,null,能量kJ,能量kcal,蛋白,脂肪,碳水,钠,钙
 */
export function parseNutritionCsv(raw: string): NutritionItem[] {
  const items: NutritionItem[] = [];
  if (!raw) return items;

  for (const line of raw.split('\n')) {
    const row = line.trim();
    if (!row) continue;

    const parts = row.split(',');
    // 有效数据行：9 个字段，且首字段非空
    if (parts.length < 9) continue;

    const productName = parts[0]?.trim();
    if (!productName) continue;

    const num = (idx: number): number => {
      const v = Number(parts[idx]);
      return Number.isFinite(v) ? v : 0;
    };

    items.push({
      productName,
      energyKj: num(2),
      energyKcal: num(3),
      protein: num(4),
      fat: num(5),
      carbohydrate: num(6),
      sodium: num(7),
      calcium: num(8),
    });
  }
  return items;
}

export { STORE_CLOSED_CODE };
