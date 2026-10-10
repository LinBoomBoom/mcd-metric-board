import { McdClient } from './mcp-client.js';
import { matchAndRank, rankBySodium } from './matcher.js';
import { assertCompliance, ComplianceError } from './compliance.js';
import {
  renderMyBoard,
  renderNowBoard,
  renderProteinBoard,
  renderSodiumBoard,
  renderStyles,
  type MyBoardData,
} from './render.js';
import type { RankResult, Store, StoreAvailability } from './types.js';
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

  const html = renderStyles() + '<div class="board">' + renderProteinBoard(result) + '</div>';
  assertCompliance(stripTags(html), '蛋白密度榜');
  console.log(html);
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

  const html = renderStyles() + '<div class="board">' + renderNowBoard(availables, periodText) + '</div>';
  assertCompliance(stripTags(html), '此刻可点榜');
  console.log(html);
}

async function cmdSodium(client: McdClient): Promise<void> {
  console.error('拉取营养表…');
  const nutrition = await client.nutrition();
  const { items, min, max } = rankBySodium(nutrition);

  const html = renderStyles() + '<div class="board">' + renderSodiumBoard({ items, min, max }) + '</div>';
  assertCompliance(stripTags(html), '钠值分布榜');
  console.log(html);
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
  const html = renderStyles() + '<div class="board">' + renderMyBoard(data) + '</div>';
  assertCompliance(stripTags(html), '我的常点榜');
  console.log(html);
}

async function cmdBoard(client: McdClient): Promise<void> {
  console.error('渲染主界面…');
  console.error('（主界面为四榜导航卡片，各榜单请单独调用查看）');
  console.error('可用命令: protein | now | sodium | mine');
}

function stripTags(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'protein';

  const help = `麦麦参考榜 · 客观指标决策榜单

用法：
  npm run probe     验证 MCP 连通性
  npm run protein   每百元蛋白密度榜（核心主打）
  npm run now       此刻可点榜
  npm run sodium    钠值分布榜
  npm run mine      我的常点榜

环境变量：
  MCP_TOKEN        必填。麦当劳 MCP Token
  MCD_STORE_CODE   门店编码，默认 1450002（上海静安寺）
  MCD_STORE_NAME   门店名称，默认 上海静安寺餐厅
  MCD_CITY         城市，默认 上海
  MCD_KEYWORD      关键词，默认 静安寺
  MCD_LON / MCD_LAT 经纬度，默认静安寺坐标

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
