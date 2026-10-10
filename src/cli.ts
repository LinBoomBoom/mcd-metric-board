import { McdClient } from './mcp-client.js';
import { matchAndRank, rankBySodium } from './matcher.js';
import { assertCompliance, ComplianceError } from './compliance.js';
import { breakdownCombo, buildScenarios, runScenario, solveCombo } from './solver.js';
import {
  renderBreakdownBoard,
  renderCombineBoard,
  renderDocument,
  renderMyBoard,
  renderNowBoard,
  renderOverviewBoard,
  renderProteinBoard,
  renderReportDocument,
  renderScenarioBoard,
  renderSodiumBoard,
  renderStyles,
  wrapBoard,
  type MyBoardData,
  type ReportSection,
} from './render.js';
import type { MenuData, RankResult, Store, StoreAvailability } from './types.js';
import { STORE_CLOSED_CODE } from './types.js';

/** 默认门店：上海静安寺店（24h 营业，实测可稳定调用） */
const DEFAULT_STORE: { code: string; name: string } = {
  code: process.env.MCD_STORE_CODE ?? '1450002',
  name: process.env.MCD_STORE_NAME ?? '上海静安寺餐厅',
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** 判定门店状态：营业中 / 将打烊 / 已打烊 */
function judgeStore(
  store: Store,
  onSaleCount: number | null,
): StoreAvailability {
  const start = toMinutes(store.businessStartTime);
  const end = toMinutes(store.businessEndTime);
  const now = nowMinutes();

  // 跨零点营业（如 00:00-23:59 或 18:00-02:00）
  const overnight = end <= start;
  const isOpen = overnight
    ? now >= start || now <= end
    : now >= start && now <= end;

  let minutesToClose: number | null = null;
  if (isOpen) {
    minutesToClose = overnight
      ? now <= end
        ? end - now
        : 24 * 60 - now + end
      : end - now;
  }

  let status: StoreAvailability['status'];
  if (!isOpen) {
    status = 'closed';
  } else if (minutesToClose !== null && minutesToClose <= 60) {
    status = 'closing';
  } else {
    status = 'open';
  }

  // 距打烊不足 1 分钟时，「0 小时后打烊」是无意义的表述。
  // 改用分钟级描述，避免用户看到 0 小时却不知是否还来得及。
  let closingSoonText: string | undefined;
  if (status === 'closing' && minutesToClose !== null) {
    closingSoonText =
      minutesToClose < 60
        ? `${Math.max(1, Math.round(minutesToClose))} 分钟后打烊`
        : `${Math.round(minutesToClose / 60)} 小时后打烊`;
  }

  return {
    storeCode: store.storeCode,
    storeName: store.storeName,
    distance: store.distance,
    startTime: store.businessStartTime,
    endTime: store.businessEndTime,
    isOpenNow: isOpen,
    minutesToClose,
    closingSoonText,
    onSaleCount,
    status,
  };
}

/** 解析官方时段文本，如「早餐(06:14至10:15)，午餐(...)」 */
function parseOfficialPeriod(text: string): { period: string; time: string } | null {
  const m = text.match(/([^，,()]+)\(([^)]+)\)/);
  if (!m?.[1] || !m[2]) return null;
  return { period: m[1], time: m[2] };
}

async function cmdProtein(client: McdClient): Promise<void> {
  const storeCode = process.env.MCD_STORE_CODE ?? DEFAULT_STORE.code;
  const storeName = process.env.MCD_STORE_NAME ?? DEFAULT_STORE.name;

  console.error('拉取菜单与营养表…');
  const [menu, nutrition] = await Promise.all([client.menu(storeCode), client.nutrition()]);
  const { matched, unmatched, matchedCount, totalCount } = matchAndRank(menu, nutrition);

  const maxDensity = matched[0]?.density ?? 0;
  const result: RankResult = {
    storeCode,
    storeName,
    ranked: matched,
    unmatched,
    coverage: { total: totalCount, matched: matchedCount, ratio: totalCount ? matchedCount / totalCount : 0 },
    medianDensity: 0,
    computedAt: new Date().toISOString(),
  };
  const densities = matched.map((m) => m.density ?? 0).sort((a, b) => a - b);
  result.medianDensity = densities[Math.floor(densities.length / 2)] ?? 0;

  console.error(`匹配 ${matchedCount}/${totalCount}，榜首密度 ${maxDensity.toFixed(1)}g/百元`);

  emit('麦麦参考榜 · 每百元蛋白密度', renderProteinBoard(result));
}

async function cmdNow(client: McdClient): Promise<void> {
  const city = process.env.MCD_CITY ?? '上海';
  const keyword = process.env.MCD_KEYWORD ?? '静安寺';
  const longitude = Number(process.env.MCD_LON ?? 121.4457);
  const latitude = Number(process.env.MCD_LAT ?? 31.2233);

  console.error('查询附近门店…');
  const stores = await client.nearbyStores({
    beType: 1,
    searchType: 2,
    city,
    keyword,
    longitude,
    latitude,
  });

  // 逐店查询菜单，受限流限制串行执行
  const availables: StoreAvailability[] = [];
  for (const s of stores) {
    let onSale: number | null = null;
    try {
      const menu = await client.menu(s.storeCode);
      onSale = Object.keys(menu.meals).length;
    } catch (err) {
      // 打烊等错误降级：不打断整体流程
      if (err instanceof Error && 'code' in err) {
        const code = (err as { code: number }).code;
        if (code === STORE_CLOSED_CODE) onSale = null;
        else console.error(`  ${s.storeName} 查询失败: ${(err as Error).message}`);
      }
    }
    availables.push(judgeStore(s, onSale));
  }

  const official = stores[0]?.reservationTimeOptions?.[0]?.reservationOptionText;
  const period = official ? parseOfficialPeriod(official) : null;
  const periodText = period
    ? `官方时段 · ${period.period} ${period.time}`
    : '按营业时间判定';

  emit('麦麦参考榜 · 此刻可点', renderNowBoard(availables, periodText));
}

async function cmdSodium(client: McdClient): Promise<void> {
  console.error('拉取营养表…');
  const nutrition = await client.nutrition();
  const { items, min, max } = rankBySodium(nutrition);

  emit('麦麦参考榜 · 钠值分布', renderSodiumBoard({ items, min, max }));
}

async function cmdMine(client: McdClient): Promise<void> {
  console.error('查询账户与历史订单…');
  const data: MyBoardData = { topItems: [] };

  try {
    const account = await client.account();
    const expiring = Number.parseInt(account.currentMouthExpirePoint ?? '0', 10);
    if (Number.isFinite(expiring) && expiring > 0) {
      data.expiringPoints = expiring;
      data.pointsExpireNote = '本月将过期 · 可换麦麦商城商品';
    }
  } catch (err) {
    console.error(`积分账户查询失败: ${(err as Error).message}`);
  }

  // 历史订单与优惠券为个人数据，仅运行时使用，不落盘
  emit('麦麦参考榜 · 我的常点', renderMyBoard(data));
}

/** 按名称正则查找餐品编码 */
function findByPattern(menu: MenuData, pattern: RegExp): { code: string; name: string } | null {
  for (const [code, item] of Object.entries(menu.meals)) {
    if (pattern.test(item.name)) return { code, name: item.name };
  }
  return null;
}

/** 从菜单解析套餐基础价与原价 */
function resolvePrices(
  menu: MenuData,
  code: string,
): { basePrice: number; originalPrice: number | null } {
  const meal = menu.meals[code];
  if (!meal) throw new Error(`菜单中不存在编码 ${code}`);
  const basePrice = Number.parseFloat(meal.currentPrice);
  if (!Number.isFinite(basePrice)) throw new Error(`编码 ${code} 无有效价格`);
  const original = meal.originalPrice ? Number.parseFloat(meal.originalPrice) : Number.NaN;
  return { basePrice, originalPrice: Number.isFinite(original) ? original : null };
}

/**
 * 组合配置方案（随心配求解器）
 *
 * 枚举套餐各选择区的全部组合，交叉营养与价格数据，按不同目标求最优。
 */
async function cmdCombine(client: McdClient): Promise<void> {
  const storeCode = process.env.MCD_STORE_CODE ?? DEFAULT_STORE.code;

  console.error('拉取菜单与营养表…');
  const [menu, nutrition] = await Promise.all([client.menu(storeCode), client.nutrition()]);

  const explicitCode = process.env.MCD_COMBO_CODE;
  const pattern = process.env.MCD_COMBO_PATTERN
    ? new RegExp(process.env.MCD_COMBO_PATTERN)
    : /随心配/;

  const target = explicitCode
    ? { code: explicitCode, name: menu.meals[explicitCode]?.name ?? explicitCode }
    : findByPattern(menu, pattern);

  if (!target) {
    throw new Error(
      '菜单中未找到可组合配置的套餐。可用 MCD_COMBO_CODE 指定餐品编码，或用 MCD_COMBO_PATTERN 指定名称正则。',
    );
  }

  const { basePrice, originalPrice } = resolvePrices(menu, target.code);
  const detail = await client.mealDetail(target.code, storeCode);

  console.error(`求解「${detail.name}」基础价 ¥${basePrice}…`);
  const result = solveCombo(detail, basePrice, originalPrice, menu, nutrition, detail.name);
  console.error(
    `组合 ${result.totalCombos} 种 · 可完整比价 ${result.comparableCombos} · 有营养数据 ${result.nutritionCombos}`,
  );

  emit('麦麦参考榜 · 组合配置方案', renderCombineBoard(result));
}

/**
 * 套餐逐项拆解（盈亏平衡）
 */
async function cmdBreakdown(client: McdClient): Promise<void> {
  const storeCode = process.env.MCD_STORE_CODE ?? DEFAULT_STORE.code;

  console.error('拉取菜单与营养表…');
  const [menu, nutrition] = await Promise.all([client.menu(storeCode), client.nutrition()]);

  const explicitCode = process.env.MCD_BREAKDOWN_CODE;
  const pattern = process.env.MCD_BREAKDOWN_PATTERN
    ? new RegExp(process.env.MCD_BREAKDOWN_PATTERN)
    : /三件套|四件套/;

  const target = explicitCode
    ? { code: explicitCode, name: menu.meals[explicitCode]?.name ?? explicitCode }
    : findByPattern(menu, pattern);

  if (!target) {
    throw new Error(
      '菜单中未找到套餐。可用 MCD_BREAKDOWN_CODE 指定编码，或用 MCD_BREAKDOWN_PATTERN 指定名称正则。',
    );
  }

  const { basePrice, originalPrice } = resolvePrices(menu, target.code);
  const detail = await client.mealDetail(target.code, storeCode);

  console.error(`拆解「${detail.name}」基础价 ¥${basePrice}…`);
  const result = breakdownCombo(detail, basePrice, originalPrice, menu, nutrition, detail.name);
  console.error(`可定价 ${result.pricedCount} / ${result.totalCount} 项`);

  emit('麦麦参考榜 · 套餐逐项拆解', renderBreakdownBoard(result));
}

/**
 * 场景方案
 *
 * 场景由客观筛选条件定义，不含人群标签与健康宣称。
 */
async function cmdScenario(client: McdClient): Promise<void> {
  const storeCode = process.env.MCD_STORE_CODE ?? DEFAULT_STORE.code;

  console.error('拉取菜单与营养表…');
  const [menu, nutrition] = await Promise.all([client.menu(storeCode), client.nutrition()]);

  const scenarios = buildScenarios();
  const results = scenarios.map((s) => runScenario(s, menu, nutrition, 10));
  console.error(`场景 ${results.length} 个：${results.map((r) => `${r.scenario.title}(${r.totalMatched})`).join(' · ')}`);

  emit('麦麦参考榜 · 场景方案', renderScenarioBoard(results));
}

/**
 * 完整报告
 *
 * 一次拉取数据，渲染全部榜单到同一文档。
 * 必须由单次渲染流程组装 —— Tab 的 radio id 依赖全局自增序号，
 * 若各榜独立渲染再拼接会产生 id 冲突，导致切换失效。
 */
async function cmdAll(client: McdClient): Promise<void> {
  const storeCode = process.env.MCD_STORE_CODE ?? DEFAULT_STORE.code;
  const storeName = process.env.MCD_STORE_NAME ?? DEFAULT_STORE.name;
  const sections: ReportSection[] = [];

  console.error('拉取菜单与营养表…');
  const [menu, nutrition] = await Promise.all([client.menu(storeCode), client.nutrition()]);

  // ① 蛋白密度
  const { matched, unmatched, matchedCount, totalCount } = matchAndRank(menu, nutrition);
  const densities = matched.map((m) => m.density ?? 0).sort((a, b) => a - b);
  const proteinResult: RankResult = {
    storeCode,
    storeName,
    ranked: matched,
    unmatched,
    coverage: {
      total: totalCount,
      matched: matchedCount,
      ratio: totalCount > 0 ? matchedCount / totalCount : 0,
    },
    medianDensity: densities[Math.floor(densities.length / 2)] ?? 0,
    computedAt: new Date().toISOString(),
  };
  sections.push({
    title: '每百元蛋白密度',
    tag: `跨菜单价格与营养表联合计算 · ${matchedCount}/${totalCount}`,
    board: renderProteinBoard(proteinResult),
  });

  // ② 组合配置方案
  try {
    const target = findByPattern(menu, /随心配/);
    if (target) {
      const { basePrice, originalPrice } = resolvePrices(menu, target.code);
      const detail = await client.mealDetail(target.code, storeCode);
      const solve = solveCombo(detail, basePrice, originalPrice, menu, nutrition, detail.name);
      console.error(`组合榜：${detail.name} · ${solve.totalCombos} 种组合`);
      sections.push({
        title: '组合配置方案',
        tag: `${solve.totalCombos} 种组合逐一求解`,
        board: renderCombineBoard(solve),
      });
    }
  } catch (err) {
    console.error(`组合榜跳过：${(err as Error).message}`);
  }

  // ③ 套餐逐项拆解
  try {
    const target = findByPattern(menu, /三件套|四件套/);
    if (target) {
      const { basePrice, originalPrice } = resolvePrices(menu, target.code);
      const detail = await client.mealDetail(target.code, storeCode);
      const bd = breakdownCombo(detail, basePrice, originalPrice, menu, nutrition, detail.name);
      console.error(`拆解榜：${detail.name} · 可定价 ${bd.pricedCount}/${bd.totalCount}`);
      sections.push({
        title: '套餐逐项拆解',
        tag: `可定价 ${bd.pricedCount}/${bd.totalCount} 项`,
        board: renderBreakdownBoard(bd),
      });
    }
  } catch (err) {
    console.error(`拆解榜跳过：${(err as Error).message}`);
  }

  // ④ 场景方案
  const scenarios = buildScenarios().map((s) => runScenario(s, menu, nutrition, 10));
  sections.push({
    title: '场景方案',
    tag: `${scenarios.length} 个客观筛选场景`,
    board: renderScenarioBoard(scenarios),
  });

  // ⑤ 钠值分布
  const sodium = rankBySodium(nutrition);
  sections.push({
    title: '钠值分布',
    tag: `全菜单 ${sodium.items.length} 项`,
    board: renderSodiumBoard({ items: sodium.items, min: sodium.min, max: sodium.max }),
  });

  // ⑥ 此刻可点
  try {
    const stores = await client.nearbyStores({
      beType: 1,
      searchType: 2,
      city: process.env.MCD_CITY ?? '上海',
      keyword: process.env.MCD_KEYWORD ?? '静安寺',
      longitude: Number(process.env.MCD_LON ?? 121.4457),
      latitude: Number(process.env.MCD_LAT ?? 31.2233),
    });
    const availables: StoreAvailability[] = [];
    for (const s of stores) {
      let onSale: number | null = null;
      try {
        const m = await client.menu(s.storeCode);
        onSale = Object.keys(m.meals).length;
      } catch {
        onSale = null;
      }
      availables.push(judgeStore(s, onSale));
    }
    const official = stores[0]?.reservationTimeOptions?.[0]?.reservationOptionText;
    const period = official ? parseOfficialPeriod(official) : null;
    sections.push({
      title: '此刻可点',
      tag: `${availables.filter((a) => a.status !== 'closed').length}/${availables.length} 店营业中`,
      board: renderNowBoard(
        availables,
        period ? `官方时段 · ${period.period} ${period.time}` : '按营业时间判定',
      ),
    });
  } catch (err) {
    console.error(`此刻可点跳过：${(err as Error).message}`);
  }

  // ⑦ 我的常点（个人数据仅运行时使用）
  const mine: MyBoardData = { topItems: [] };
  try {
    const account = await client.account();
    const expiring = Number.parseInt(account.currentMouthExpirePoint ?? '0', 10);
    if (Number.isFinite(expiring) && expiring > 0) {
      mine.expiringPoints = expiring;
      mine.pointsExpireNote = '本月将过期 · 可换麦麦商城商品';
    }
  } catch {
    // 无账户数据时走空状态
  }
  sections.push({
    title: '我的常点',
    tag: '仅本机运行时计算 · 不存储不上传',
    board: renderMyBoard(mine),
  });

  const html = FRAGMENT_MODE
    ? renderStyles() + sections.map((s) => `<div class="stack__item">${s.board}</div>`).join('')
    : renderReportDocument('麦麦参考榜 · 完整报告', sections, {
        heading: '麦麦参考榜',
        sub: '基于麦当劳官方 MCP 的客观指标决策榜单。数据全部实时拉取，未匹配项不做推测映射，个人数据仅在本机运行时计算。非麦当劳官方产品。',
      });

  assertCompliance(stripTags(html), '完整报告');
  console.log(html);
}

/**
 * 总览榜（主界面）
 *
 * 门店查询失败时降级为静态总览，不中断输出 ——
 * 总览的价值是导航，不应因单次接口异常而不可用。
 */
async function cmdBoard(client: McdClient): Promise<void> {
  const city = process.env.MCD_CITY ?? '上海';
  const keyword = process.env.MCD_KEYWORD ?? '静安寺';
  const longitude = Number(process.env.MCD_LON ?? 121.4457);
  const latitude = Number(process.env.MCD_LAT ?? 31.2233);

  console.error('渲染总览榜…');

  let openStoreCount = 0;
  let periodText = '按营业时间判定';

  try {
    const stores = await client.nearbyStores({
      beType: 1,
      searchType: 2,
      city,
      keyword,
      longitude,
      latitude,
    });
    openStoreCount = stores.filter((s) => judgeStore(s, null).isOpenNow).length;

    const official = stores[0]?.reservationTimeOptions?.[0]?.reservationOptionText;
    const period = official ? parseOfficialPeriod(official) : null;
    if (period) periodText = `官方时段 · ${period.period} ${period.time}`;
  } catch (err) {
    console.error(`门店查询失败，降级为静态总览: ${(err as Error).message}`);
  }

  emit(
    '麦麦参考榜 · 榜单总览',
    renderOverviewBoard({
      periodText,
      openStoreCount,
      storeName: process.env.MCD_STORE_NAME ?? DEFAULT_STORE.name,
    }),
    true,
  );
}

function stripTags(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
}

/**
 * 输出模式
 *
 * Skill 的宿主容器宽度不可预知 —— 对话流可能只有 400px，产物面板可能有 1200px。
 * 因此不针对「端」做分支，统一输出带 viewport 与响应式壳的完整文档：
 *   窄容器 → 卡片吃满宽度
 *   宽容器 → 卡片居中定宽
 * 同一份代码在所有宿主里都成立。
 *
 * --fragment 用于宿主自行包裹片段的场景（仅输出样式 + 榜单，不含 html/head/body）。
 */
const FRAGMENT_MODE = process.argv.includes('--fragment');

function emit(title: string, inner: string, wide = false): void {
  const board = wrapBoard(inner, wide);
  const html = FRAGMENT_MODE ? renderStyles() + board : renderDocument(title, board);
  assertCompliance(stripTags(html), title);
  console.log(html);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'protein';

  const help = `麦麦参考榜 · 客观指标决策榜单

用法：
  npm run board     总览榜（导航）
  npm run protein   每百元蛋白密度榜
  npm run combine   组合配置方案（随心配求解器）
  npm run breakdown 套餐逐项拆解（盈亏平衡）
  npm run scenario  场景方案
  npm run now       此刻可点榜
  npm run sodium    钠值分布榜
  npm run mine      我的常点榜
  npm run probe     验证 MCP 连通性

输出模式：
  默认输出完整 HTML 文档（含 viewport 与响应式壳），可直接打开
  追加 --fragment 只输出样式与榜单片段，供宿主自行包裹

容器适配：
  不针对「端」做分支。窄容器卡片吃满宽度，宽容器居中定宽，
  同一份代码在 MCP Client 对话流、产物面板、浏览器中均成立。

环境变量：
  MCP_TOKEN             必填。麦当劳 MCP Token
  MCD_STORE_CODE        门店编码，默认 1450002（上海静安寺）
  MCD_STORE_NAME        门店名称，默认 上海静安寺餐厅
  MCD_CITY              城市，默认 上海
  MCD_KEYWORD           关键词，默认 静安寺
  MCD_LON / MCD_LAT     经纬度，默认静安寺坐标
  MCD_COMBO_CODE        组合榜指定餐品编码（默认按名称匹配「随心配」）
  MCD_COMBO_PATTERN     组合榜名称正则
  MCD_BREAKDOWN_CODE    拆解榜指定餐品编码（默认匹配「三件套|四件套」）
  MCD_BREAKDOWN_PATTERN 拆解榜名称正则

合规提示：本项目输出全部为客观数据对比，不构成医疗或营养建议，
         且非麦当劳官方产品。真实 Token 切勿写入代码或提交仓库。`;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(help);
    return;
  }

  let client: McdClient;
  try {
    client = McdClient.fromEnv();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  try {
    switch (cmd) {
      case 'protein':
        await cmdProtein(client);
        break;
      case 'combine':
        await cmdCombine(client);
        break;
      case 'breakdown':
        await cmdBreakdown(client);
        break;
      case 'scenario':
        await cmdScenario(client);
        break;
      case 'all':
        await cmdAll(client);
        break;
      case 'now':
        await cmdNow(client);
        break;
      case 'sodium':
        await cmdSodium(client);
        break;
      case 'mine':
        await cmdMine(client);
        break;
      case 'probe':
        await cmdProbe(client);
        break;
      case 'board':
        await cmdBoard(client);
        break;
      default:
        console.error(`未知命令: ${cmd}\n`);
        console.log(help);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ComplianceError) {
      console.error(`\n合规校验失败\n${err.message}`);
    } else {
      console.error(`\n执行失败: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  }
}

async function cmdProbe(client: McdClient): Promise<void> {
  console.error('验证 MCP 连通性…');
  const t = await client.now();
  console.error(`连接正常 · 服务器时间 ${t.formatted} · 星期${t.dayOfWeek}`);
}

void main();
