import type {
  BreakdownResult,
  ComboPick,
  RankedItem,
  RankResult,
  ScenarioResult,
  SolveResult,
  StoreAvailability,
} from './types.js';
import { COMPLIANCE_FOOTER, NEUTRAL_NOTE } from './compliance.js';

/**
 * 榜单渲染层
 *
 * 视觉体系：麦当劳品牌语言（暖色、粗字重、大圆角）
 * 设计规范：design/04-麦当劳风格设计规范.md
 *
 * ## 合规边界（务必遵守）
 * 采用品牌**视觉语言**，但不复制**商标资产**：
 *   - 品牌标记为自建「麦」字方块，非官方 Logo
 *   - 不使用官方字体文件（用系统字体栈 + 提高字重模拟粗壮感）
 *   - 每屏常驻「非麦当劳官方产品」声明
 *
 * ## 数据编码约束
 *   1. 品牌红只用于品牌与操作，不用于数据编码 —— 避免与语义混淆
 *   2. 数据一律走暖棕单色阶，绝不用红绿 —— 红绿构成健康评判
 *   3. 排名徽标仅用于蛋白密度榜；钠值榜是纯数据呈现，不加排名强调
 *   4. 覆盖率常驻顶部，不可折叠 —— 主动披露是可信度来源
 */

/** 数据色阶：暖棕单色阶（浅 → 深 = 低 → 高） */
const DATA_SCALE = ['#F7DCA8', '#E8A93C', '#C2701A', '#8A4A12'] as const;

/** 排名徽标配色：前三名庆祝式，其余中性 */
const RANK_BADGE = [
  { bg: 'var(--brand-red)', fg: '#FFFFFF' },
  { bg: 'var(--brand-gold)', fg: '#241A14' },
  { bg: '#C98A3E', fg: '#FFFFFF' },
] as const;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

/** 按分位取数据色阶颜色 */
function scaleColor(percentile: number): string {
  const idx = Math.min(
    DATA_SCALE.length - 1,
    Math.floor((Math.max(0, Math.min(100, percentile)) / 100) * DATA_SCALE.length),
  );
  return DATA_SCALE[idx] ?? DATA_SCALE[0];
}

/** 品牌标记：自建「麦」字方块，非官方 Logo */
function brandMark(): string {
  return '<span class="brand-mark">麦</span>';
}

/** 榜单头部：品牌标记 + 标题 + 副标题 */
function boardHead(title: string, sub: string, extra = ''): string {
  return `
<div class="board-head">
  <div class="board-title-row">
    ${brandMark()}
    <div class="board-title-block">
      <div class="board-title">${esc(title)}</div>
      <div class="board-sub">${esc(sub)}</div>
    </div>
  </div>
  ${extra}
</div>`;
}

/**
 * 渲染覆盖率披露条
 *
 * 固定在列表顶部，不可折叠。这是本项目的核心信任机制。
 */
export function renderCoverage(matched: number, total: number): string {
  const ratio = total > 0 ? (matched / total) * 100 : 0;
  return `
<div class="coverage">
  <div class="coverage-row">
    <div class="coverage-text"><strong>${matched}</strong> / ${total} 项有营养数据</div>
    <div class="coverage-pct">${fmt(ratio, 1)}%</div>
  </div>
  <div class="coverage-bar"><div style="width:${fmt(ratio, 1)}%"></div></div>
  <div class="coverage-note">
    官方营养表与门店实时菜单存在版本差。未匹配项标注「暂无营养数据」，不做推测映射。
  </div>
</div>`;
}

/** 排名徽标 */
function rankBadge(index: number): string {
  const preset = RANK_BADGE[index];
  if (preset) {
    return `<span class="rank-badge" style="background:${preset.bg};color:${preset.fg}">${index + 1}</span>`;
  }
  return `<span class="rank-badge rank-badge--plain">${index + 1}</span>`;
}

/**
 * 渲染单条排名项
 */
function renderRankedItem(item: RankedItem, index: number, medianDensity: number): string {
  const aboveMedian = (item.density ?? 0) >= medianDensity;
  const valueColor = aboveMedian ? 'var(--value-green)' : 'var(--gold-deep)';
  const density = item.density ?? 0;
  const ratio = item.densityRatio ?? 0;

  const meta = [
    `¥${fmt(item.price, 2)}`,
    item.protein !== undefined ? `蛋白 ${fmt(item.protein)}g` : null,
    item.sodium !== undefined ? `钠 ${Math.round(item.sodium)}mg` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return `
<div class="rank-item">
  ${rankBadge(index)}
  <div class="rank-body">
    <div class="rank-name">${esc(item.name)}</div>
    <div class="rank-meta">${esc(meta)}</div>
    <div class="data-bar"><div style="width:${fmt(Math.min(ratio, 100), 1)}%;background:${valueColor}"></div></div>
  </div>
  <div class="rank-value">
    <div class="rank-num" style="color:${valueColor}">${fmt(density)}<span class="rank-unit">g</span></div>
    <div class="rank-label">蛋白 / 百元</div>
  </div>
</div>`;
}

/** 渲染无数据项：中性灰竖条，不参与色阶 */
function renderUnmatched(name: string, price: number): string {
  return `
<div class="unmatched-item">
  <span class="unmatched-mark"></span>
  <div class="unmatched-body">
    <div class="unmatched-name">${esc(name)}</div>
    <div class="unmatched-meta">¥${fmt(price, 2)} · 暂无营养数据</div>
  </div>
</div>`;
}

/**
 * 渲染蛋白密度榜（核心主打）
 *
 * 唯一使用排名徽标的榜单 —— 排序即价值，值得庆祝。
 */
export function renderProteinBoard(result: RankResult): string {
  const { ranked, unmatched, coverage, medianDensity, storeName } = result;

  const head = boardHead(
    '每百元蛋白密度',
    `按实付价折算 · ${storeName}`,
    renderCoverage(coverage.matched, coverage.total),
  );

  /** 单档列表：序号用档内排名，便于档内比较 */
  const list = (items: RankedItem[]): string =>
    items.length > 0
      ? `<div class="rank-list">${items
          .map((item, i) => renderRankedItem(item, i, medianDensity))
          .join('')}</div>`
      : `<div class="empty"><div class="empty-title">该档位暂无餐品</div><div class="empty-desc">换个档位或换一家门店看看</div></div>`;

  const panels: TabPanel[] = [];
  const allShown = ranked.slice(0, ALL_TAB_CAP);
  panels.push({
    label: '全部',
    count: ranked.length,
    html:
      list(allShown) +
      (ranked.length > allShown.length
        ? `<div class="more-hint">另有 ${ranked.length - allShown.length} 项未展示，可按价位档查看</div>`
        : ''),
  });

  for (const band of PRICE_BANDS) {
    const items = ranked.filter((r) => band.test(r.price));
    panels.push({ label: band.label, count: items.length, html: list(items) });
  }

  const noData =
    unmatched.length > 0
      ? `
<div class="divider"><span>暂无营养数据 · ${unmatched.length} 项</span></div>
${unmatched.slice(0, 8).map((u) => renderUnmatched(u.name, u.price)).join('')}
${
  unmatched.length > 8
    ? `<div class="more-hint">另有 ${unmatched.length - 8} 项暂无营养数据</div>`
    : ''
}`
      : '';

  const empty =
    ranked.length === 0
      ? `
<div class="empty">
  <div class="empty-icon"></div>
  <div class="empty-title">暂无可计算的数据</div>
  <div class="empty-desc">该门店菜单与官方营养表暂无对应项<br>换一家门店或稍后再试</div>
</div>`
      : '';

  const cta = ranked.length > 0 ? '<button class="btn-primary" type="button">加入购物车</button>' : '';

  return `${head}
${renderTabs(panels)}
${noData}
${empty}
<div class="board-foot">
  ${cta}
  <div class="compliance">${NEUTRAL_NOTE} · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/**
 * 渲染此刻可点榜
 */
export function renderNowBoard(stores: StoreAvailability[], periodText: string): string {
  const statusMeta: Record<
    StoreAvailability['status'],
    { label: string; color: string; bg: string }
  > = {
    open: { label: '在售', color: 'var(--value-green)', bg: '#E7F5EC' },
    closing: { label: '将打烊', color: 'var(--gold-deep)', bg: 'var(--brand-gold-soft)' },
    closed: { label: '已打烊', color: 'var(--text-tertiary)', bg: 'var(--bg-sunken)' },
    unavailable: { label: '不可用', color: 'var(--text-tertiary)', bg: 'var(--bg-sunken)' },
  };

  const items = stores
    .map((s) => {
      const meta = statusMeta[s.status];
      const timeText = `${s.startTime} 至 ${s.endTime}`;
      const detail: string[] = [];
      if (s.onSaleCount !== null) detail.push(`在售 ${s.onSaleCount} 项`);
      else if (s.status === 'closed') detail.push('已过营业时段');
      if (s.closingSoonText) detail.push(s.closingSoonText);
      if (s.distance > 0) detail.push(`${s.distance} 米`);

      const markColor =
        s.status === 'open'
          ? 'var(--value-green)'
          : s.status === 'closing'
            ? 'var(--brand-gold)'
            : 'var(--border-strong)';

      return `
<div class="store-item">
  <span class="store-mark" style="background:${markColor}"></span>
  <div class="store-body">
    <div class="store-name${s.status === 'closed' ? ' is-closed' : ''}">${esc(s.storeName)}</div>
    <div class="store-time${s.status === 'closed' ? ' is-closed' : ''}">${esc(timeText)}</div>
    ${detail.length ? `<div class="store-detail">${esc(detail.join(' · '))}</div>` : ''}
  </div>
  <span class="pill" style="color:${meta.color};background:${meta.bg}">${meta.label}</span>
</div>`;
    })
    .join('\n');

  const openCount = stores.filter((s) => s.status === 'open' || s.status === 'closing').length;

  const head = boardHead(
    '此刻可点',
    `官方时段口径 · 附近 ${openCount} 店营业中`,
    `<div class="board-status"><span class="dot"></span>${esc(periodText)}</div>`,
  );

  return `${head}
<div class="store-list">${items}</div>
<div class="board-foot">
  <div class="compliance">营业时间与时段划分均取自官方 MCP 数据 · 供应状态以实时结果为准 · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/**
 * 渲染钠值分布榜
 *
 * 纯数据呈现 —— 不使用排名徽标，避免引入「谁更好」的暗示。
 */
export interface SodiumBoardData {
  items: Array<{ productName: string; sodium: number; percentile: number }>;
  min: number;
  max: number;
}

/** 单条钠值项 */
function sodiumRow(item: { productName: string; sodium: number; percentile: number }): string {
  const color = scaleColor(item.percentile);
  return `
<div class="sodium-item">
  <span class="sodium-bar" style="background:${color}"></span>
  <div class="sodium-body">
    <div class="sodium-name">${esc(item.productName)}</div>
    <div class="sodium-meta">钠 ${Math.round(item.sodium)}mg · 全菜单 ${fmt(item.percentile, 0)}% 分位</div>
  </div>
</div>`;
}

export function renderSodiumBoard(data: SodiumBoardData): string {
  const head = boardHead(
    '钠值分布',
    `全菜单区间 ${Math.round(data.min)} 至 ${Math.round(data.max)}mg`,
    `<div class="scale">
      <span class="scale-label">低</span>
      <span class="scale-bar"></span>
      <span class="scale-label">高</span>
    </div>`,
  );

  const list = (items: SodiumBoardData['items']): string =>
    items.length > 0
      ? `<div class="sodium-list">${items.map(sodiumRow).join('')}</div>`
      : `<div class="empty"><div class="empty-title">该区间暂无餐品</div><div class="empty-desc">换个区间看看</div></div>`;

  /** 全菜单 158 项，先按数值升序，分档展示 */
  const ascending = [...data.items].sort((a, b) => a.sodium - b.sodium);

  const panels: TabPanel[] = [
    {
      label: '最低 20',
      count: data.items.length,
      html: list(ascending.slice(0, ALL_TAB_CAP)),
    },
    ...SODIUM_BANDS.map((band) => {
      const items = ascending.filter((i) => band.test(i.sodium));
      return { label: band.label, count: items.length, html: list(items) };
    }),
  ];

  return `${head}
${renderTabs(panels)}
<div class="board-foot">
  <div class="compliance">色阶仅表示钠含量相对高低，不含评判含义 · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/**
 * 渲染我的常点榜
 */
export interface MyBoardData {
  topItems: Array<{ name: string; count: number }>;
  lastOrder?: { name: string; daysAgo: number };
  expiringCoupons?: number;
  expiringPoints?: number;
  pointsExpireNote?: string;
}

export function renderMyBoard(data: MyBoardData): string {
  const head = boardHead('我的常点榜', '仅本机运行时计算 · 不存储不上传');

  if (data.topItems.length === 0) {
    return `${head}
<div class="empty">
  <div class="empty-icon"></div>
  <div class="empty-title">你的常点榜还是空的</div>
  <div class="empty-desc">点一次外卖或到店<br>这里就会长出你的专属榜单</div>
  <button class="btn-primary btn-primary--inline" type="button">去点一单</button>
</div>
<div class="board-foot">
  <div class="compliance">数据来自你的账户，仅用于本次分析 · ${COMPLIANCE_FOOTER}</div>
</div>`;
  }

  const top = data.topItems
    .map(
      (item, i) => `
<div class="mine-item">
  ${rankBadge(i)}
  <div class="mine-body">
    <div class="rank-name">${esc(item.name)}</div>
    <div class="mine-meta">点了 ${item.count} 次</div>
  </div>
</div>`,
    )
    .join('\n');

  const last =
    data.lastOrder !== undefined
      ? `
<div class="section">
  <div class="section-label">距上次点单</div>
  <div class="section-value">${esc(data.lastOrder.name)} · ${data.lastOrder.daysAgo} 天前</div>
</div>`
      : '';

  const expiring: string[] = [];
  if (data.expiringCoupons && data.expiringCoupons > 0) {
    expiring.push(`
<div class="expire-item">
  <span class="dot"></span>
  <div>
    <div class="expire-name">${data.expiringCoupons} 张优惠券</div>
    <div class="mine-meta">即将过期</div>
  </div>
</div>`);
  }
  if (data.expiringPoints && data.expiringPoints > 0) {
    expiring.push(`
<div class="expire-item">
  <span class="dot"></span>
  <div>
    <div class="expire-name">${data.expiringPoints} 积分</div>
    <div class="mine-meta">${esc(data.pointsExpireNote ?? '本月将过期')}</div>
  </div>
</div>`);
  }

  const expireSection =
    expiring.length > 0
      ? `
<div class="section">
  <div class="section-label">即将过期</div>
  ${expiring.join('\n')}
</div>`
      : '';

  return `${head}
<div class="section">
  <div class="section-label">你的常点 Top ${data.topItems.length}</div>
  ${top}
</div>
${last}
${expireSection}
<div class="board-foot">
  <div class="compliance">积分兑换需自行确认，榜单不构成消费建议 · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/**
 * 渲染总览榜（主界面 · 四榜导航）
 *
 * 栅格用 auto-fit + minmax，窄屏 1 列、宽屏 2 列，无需媒体查询。
 */
export interface OverviewData {
  /** 官方时段文本，如「官方时段 · 宵夜 22:14至23:59」 */
  periodText: string;
  /** 附近营业中门店数 */
  openStoreCount: number;
  /** 默认门店名，可选 */
  storeName?: string;
}

export function renderOverviewBoard(data: OverviewData): string {
  const cards: Array<{
    label: string;
    tagCls: string;
    title: string;
    desc: string;
    primary: boolean;
  }> = [
    {
      label: '此刻可点',
      tagCls: 'tag--tools',
      title: '你现在能买到什么',
      desc: '附近门店实时菜单交集，含售罄与打烊标记',
      primary: false,
    },
    {
      label: '核心主打',
      tagCls: 'tag--primary',
      title: '每百元蛋白密度榜',
      desc: '按实付价折算，直说这一顿值不值',
      primary: true,
    },
    {
      label: '数据可视',
      tagCls: 'tag--tools',
      title: '钠值分布榜',
      desc: '单色阶映射全菜单钠值分布',
      primary: false,
    },
    {
      label: '独家',
      tagCls: 'tag--exclusive',
      title: '我的常点榜',
      desc: '复购频次、点单间隔、券与积分过期提醒',
      primary: false,
    },
  ];

  const html = cards
    .map(
      (c) => `
<div class="nav-card${c.primary ? ' nav-card--primary' : ''}">
  <div class="nav-card__top">
    <span class="tag ${c.tagCls}">${esc(c.label)}</span>
  </div>
  <div class="nav-card__title">${esc(c.title)}</div>
  <div class="nav-card__desc">${esc(c.desc)}</div>
</div>`,
    )
    .join('\n');

  const sub = data.storeName
    ? `${data.storeName} · 附近 ${data.openStoreCount} 店营业中`
    : `附近 ${data.openStoreCount} 店营业中`;

  return `
<div class="board-head">
  <div class="board-title-row">
    ${brandMark()}
    <div class="board-title-block">
      <div class="board-title">麦麦参考榜</div>
      <div class="board-sub">${esc(sub)}</div>
    </div>
  </div>
  <div class="board-status"><span class="dot"></span>${esc(data.periodText)}</div>
</div>
<div class="nav-grid">${html}</div>
<div class="board-foot">
  <div class="compliance">四个榜单均为客观数据对比，未匹配项不做推测映射 · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/* ═══════════════════════════════════════════════════════════
   Tab 组件
   纯 CSS 切换（radio + :checked），保证宿主剥离脚本时仍可切换；
   文档中另附脚本接管高度动画，实现丝滑过渡。两层机制互不依赖。
   ═══════════════════════════════════════════════════════════ */

let tabsSeq = 0;

export interface TabPanel {
  label: string;
  /** 该页条数，显示为角标 */
  count?: number;
  html: string;
}

/**
 * 渲染 Tab 组
 *
 * 无脚本时的行为：面板以 grid 叠放，靠 :checked 控制可见性，容器高度取最高页。
 * 有脚本时的行为：脚本把容器高度锁定为当前页高度并过渡，切换丝滑。
 */
export function renderTabs(panels: TabPanel[]): string {
  if (panels.length === 0) return '';
  if (panels.length === 1) return panels[0]!.html;

  tabsSeq += 1;
  const g = `tb${tabsSeq}`;

  const radios = panels
    .map(
      (_, i) =>
        `<input class="tabs__radio" type="radio" name="${g}" id="${g}-${i}"${i === 0 ? ' checked' : ''}>`,
    )
    .join('');

  const labels = panels
    .map(
      (p, i) =>
        `<label class="tabs__tab" for="${g}-${i}">${esc(p.label)}${
          p.count !== undefined ? `<span class="tabs__cnt">${p.count}</span>` : ''
        }</label>`,
    )
    .join('');

  const bodies = panels.map((p) => `<div class="tabs__panel">${p.html}</div>`).join('');

  const rules = panels
    .map((_, i) => {
      const sel = `#${g}-${i}:checked`;
      return (
        `${sel}~.tabs__panels>.tabs__panel:nth-child(${i + 1}){opacity:1;visibility:visible;transform:none}` +
        `${sel}~.tabs__bar>.tabs__tab:nth-of-type(${i + 1}){color:var(--text-primary)}` +
        `${sel}~.tabs__bar>.tabs__ink{transform:translateX(${i * 100}%)}`
      );
    })
    .join('');

  return (
    `<style>${rules}</style>` +
    `<div class="tabs" data-tabs>` +
    radios +
    `<div class="tabs__bar" style="--n:${panels.length}">${labels}<span class="tabs__ink"></span></div>` +
    `<div class="tabs__panels">${bodies}</div>` +
    `</div>`
  );
}

/** 价格分档，用于长列表分组 */
const PRICE_BANDS = [
  { label: '≤¥20', test: (p: number) => p <= 20 },
  { label: '¥20–30', test: (p: number) => p > 20 && p <= 30 },
  { label: '>¥30', test: (p: number) => p > 30 },
] as const;

/** 钠值分档，用于长列表分组（仅数值区间，不含评判） */
const SODIUM_BANDS = [
  { label: '<400mg', test: (v: number) => v < 400 },
  { label: '400–700mg', test: (v: number) => v >= 400 && v < 700 },
  { label: '≥700mg', test: (v: number) => v >= 700 },
] as const;

/** 「全部」页的条数上限，超出提示用分组查看 */
const ALL_TAB_CAP = 20;

/**
 * 渲染组合求解榜（随心配）
 *
 * 按求解目标分 Tab：密度最优 / 省最多 / 蛋白最高 / 不加价。
 */
export function renderCombineBoard(result: SolveResult): string {
  const { roundsSummary } = result;

  const coverageNote = `
<div class="note">
  <div class="note__row"><span>理论组合</span><strong>${result.totalCombos}</strong></div>
  <div class="note__row"><span>可完整比价</span><strong>${result.comparableCombos}</strong></div>
  <div class="note__row"><span>有营养数据</span><strong>${result.nutritionCombos}</strong></div>
  <div class="note__text">套餐内小食与饮品多数不单独售卖，因此无法取得单点价；未取得的一律不计入比价，不按同类项估算。</div>
</div>`;

  const roundChips = roundsSummary
    .map(
      (r) =>
        `<div class="chip-row"><span class="chip-row__name">${esc(r.name)}</span><span class="chip-row__val">${r.choiceCount} 选 1 · 可定价 ${r.pricedCount} · 有营养 ${r.nutritionCount}</span></div>`,
    )
    .join('');

  const renderPick = (p: ComboPick | null, objective: string): string => {
    if (!p) {
      return `<div class="empty"><div class="empty-title">该目标暂无可计算组合</div><div class="empty-desc">受可定价项覆盖限制，换其他目标看看</div></div>`;
    }
    const items = p.items
      .map(
        (it) => `
<div class="pick-item">
  <div class="pick-item__body">
    <div class="pick-item__name">${esc(it.name)}</div>
    <div class="pick-item__meta">${esc(it.roundName)}${
      it.diffPrice !== 0
        ? ` · 套餐内${it.diffPrice > 0 ? '加' : '减'} ¥${Math.abs(it.diffPrice).toFixed(1)}`
        : ' · 不加价'
    }${it.singlePrice !== null ? ` · 单点 ¥${it.singlePrice.toFixed(1)}` : ' · 未单独售卖'}</div>
  </div>
  ${it.protein !== null ? `<span class="pick-item__p">${it.protein.toFixed(0)}g</span>` : ''}
</div>`,
      )
      .join('');

    const stats: string[] = [];
    stats.push(
      `<div class="stat"><div class="stat__v">¥${p.totalPrice.toFixed(1)}</div><div class="stat__k">套餐实付</div></div>`,
    );
    if (p.singleSum !== null) {
      stats.push(
        `<div class="stat"><div class="stat__v stat__v--strike">¥${p.singleSum.toFixed(1)}</div><div class="stat__k">单点合计</div></div>`,
      );
    }
    if (p.saved !== null) {
      stats.push(
        `<div class="stat"><div class="stat__v stat__v--good">省 ¥${p.saved.toFixed(1)}</div><div class="stat__k">相对单点</div></div>`,
      );
    }
    if (p.density !== null) {
      stats.push(
        `<div class="stat"><div class="stat__v">${p.density.toFixed(1)}g</div><div class="stat__k">蛋白 / 百元</div></div>`,
      );
    }

    return `
<div class="objective">${esc(objective)}</div>
<div class="pick">${items}</div>
<div class="stats">${stats.join('')}</div>`;
  };

  const panels: TabPanel[] = [
    { label: '密度最优', html: renderPick(result.bestByDensity, '蛋白密度最高') },
    { label: '省最多', html: renderPick(result.bestBySaving, '相对单点省得最多') },
    { label: '蛋白最高', html: renderPick(result.bestByProtein, '蛋白质合计最高') },
    { label: '不加价', html: renderPick(result.bestNoSurcharge, '不超基础价的前提下最优') },
  ];

  const head = `
<div class="board-head">
  <div class="board-title-row">
    ${brandMark()}
    <div class="board-title-block">
      <div class="board-title">组合配置方案</div>
      <div class="board-sub">${esc(result.comboName)} · 基础价 ¥${result.basePrice.toFixed(1)}${
        result.originalPrice !== null ? ` · 官方标注原价 ¥${result.originalPrice.toFixed(1)}` : ''
      }</div>
    </div>
  </div>
</div>
${coverageNote}
<div class="chip-list">${roundChips}</div>`;

  return `${head}${renderTabs(panels)}
<div class="board-foot">
  <div class="compliance">组合与价格均为官方 MCP 实时数据计算结果 · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/**
 * 渲染套餐拆解榜（盈亏平衡）
 */
export function renderBreakdownBoard(result: BreakdownResult): string {
  const rows = result.items
    .map((it) => {
      const isPriced = it.singlePrice !== null;
      return `
<div class="bd-item${isPriced ? '' : ' bd-item--dim'}">
  <div class="bd-body">
    <div class="bd-name">${esc(it.name)}</div>
    <div class="bd-meta">${esc(it.roundName)}${
      it.protein !== null ? ` · 蛋白 ${it.protein.toFixed(0)}g` : ''
    }</div>
  </div>
  <div class="bd-right">
    ${
      isPriced
        ? `<div class="bd-single">单点 ¥${it.singlePrice!.toFixed(1)}</div>
           <div class="bd-diff">套餐内 ${it.diffPrice > 0 ? `+¥${it.diffPrice.toFixed(1)}` : it.diffPrice < 0 ? `−¥${Math.abs(it.diffPrice).toFixed(1)}` : '不加价'}</div>`
        : `<div class="bd-single bd-single--na">未单独售卖</div>
           <div class="bd-diff">套餐内 ${it.diffPrice > 0 ? `+¥${it.diffPrice.toFixed(1)}` : it.diffPrice < 0 ? `−¥${Math.abs(it.diffPrice).toFixed(1)}` : '不加价'}</div>`
    }
  </div>
</div>`;
    })
    .join('');

  const priced = result.items.filter((i) => i.singlePrice !== null);
  const best = priced.length > 0 ? priced[0] : null;

  const highlight =
    best && best.value !== null
      ? `
<div class="note">
  <div class="note__text">这组里单点价最高的搭配：<strong>${esc(best.name)}</strong> —— 单点 ¥${best.singlePrice!.toFixed(1)}${
    best.diffPrice > 0
      ? `，套餐内加 ¥${best.diffPrice.toFixed(1)} 即可拿到`
      : best.diffPrice < 0
        ? `，套餐内还减 ¥${Math.abs(best.diffPrice).toFixed(1)}`
        : '，套餐内不加价'
  }。套餐基础价 ¥${result.basePrice.toFixed(1)}${
    result.originalPrice !== null ? `，官方标注原价 ¥${result.originalPrice.toFixed(1)}` : ''
  }。</div>
</div>`
      : '';

  return `
<div class="board-head">
  <div class="board-title-row">
    ${brandMark()}
    <div class="board-title-block">
      <div class="board-title">套餐逐项拆解</div>
      <div class="board-sub">${esc(result.comboName)} · 基础价 ¥${result.basePrice.toFixed(1)}</div>
    </div>
  </div>
</div>
<div class="note">
  <div class="note__row"><span>可算出单点价</span><strong>${result.pricedCount} / ${result.totalCount}</strong></div>
  <div class="note__text">门店菜单只为可单独购买的餐品标价，套餐内多数小食与饮品不单卖，因此无法逐项比价。</div>
</div>
${highlight}
<div class="bd-list">${rows}</div>
<div class="board-foot">
  <div class="compliance">价格均取自官方 MCP 实时菜单，未按同类项估算 · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/**
 * 渲染场景榜
 *
 * 用客观约束定义场景，而非人群标签 —— 不做任何健康宣称。
 */
export function renderScenarioBoard(results: ScenarioResult[]): string {
  const panels: TabPanel[] = results.map((r) => {
    const rows = r.hits
      .map((h, i) => {
        const num = h.density !== null ? `${h.density.toFixed(1)}g` : '—';
        return `
<div class="rank-item">
  ${rankBadge(i)}
  <div class="rank-body">
    <div class="rank-name">${esc(h.name)}</div>
    <div class="rank-meta">¥${h.price.toFixed(1)}${
      h.protein !== null ? ` · 蛋白 ${h.protein.toFixed(0)}g` : ' · 暂无营养数据'
    }${h.sodium !== null ? ` · 钠 ${Math.round(h.sodium)}mg` : ''}</div>
  </div>
  <div class="rank-value">
    <div class="rank-num">${num}</div>
    <div class="rank-label">蛋白 / 百元</div>
  </div>
</div>`;
      })
      .join('');

    const body =
      r.hits.length > 0
        ? `<div class="scenario-criteria">筛选条件 · ${esc(r.scenario.criteria)} · 命中 ${r.totalMatched} 项，显示前 ${r.hits.length}</div><div class="rank-list">${rows}</div>`
        : `<div class="empty"><div class="empty-title">该场景暂无命中</div><div class="empty-desc">换一个场景或换一家门店看看</div></div>`;

    return { label: r.scenario.title, count: r.totalMatched, html: body };
  });

  return `
<div class="board-head">
  <div class="board-title-row">
    ${brandMark()}
    <div class="board-title-block">
      <div class="board-title">场景方案</div>
      <div class="board-sub">按客观条件筛选，不做推荐判断</div>
    </div>
  </div>
</div>
${renderTabs(panels)}
<div class="board-foot">
  <div class="compliance">场景为客观筛选条件，结果按数据排序，不构成消费或营养建议 · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/** 包裹为榜单容器；wide 用于总览榜的多卡栅格 */
export function wrapBoard(inner: string, wide = false): string {
  return `<div class="board${wide ? ' board--wide' : ''}">${inner}</div>`;
}

/**
 * 包装为完整 HTML 文档
 *
 * 输出完整文档而非片段，原因：
 *   宿主容器宽度不可预知（对话流窄、产物面板宽），需要 viewport 与响应式壳才能自适应。
 *   完整文档可直接双击打开作为 H5 查看与截图，同时不影响被宿主嵌入。
 *   需要片段时由 CLI 的 --fragment 参数输出。
 */
export function renderDocument(title: string, board: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="description" content="麦麦参考榜 · 基于麦当劳官方 MCP 的客观指标决策榜单。非麦当劳官方产品。">
<title>${esc(title)}</title>
${renderStyles()}
</head>
<body>
<div class="page">
${board}
</div>
${TAB_SCRIPT}
</body>
</html>`;
}

/** 完整报告的一条：标签 + 榜单 */
export interface ReportSection {
  title: string;
  tag?: string;
  board: string;
  wide?: boolean;
}

/**
 * 渲染完整报告（多榜同页）
 *
 * 存在的必要性：Tab 的 radio id 由全局自增序号生成，
 * 各榜若分别独立渲染再拼到同一文档，id 会冲突导致切换失效。
 * 由本函数在单次渲染流程内组装，可保证 id 唯一。
 */
export function renderReportDocument(
  title: string,
  sections: ReportSection[],
  hero?: { heading: string; sub: string },
): string {
  const items = sections
    .map(
      (s) => `
<div class="stack__item${s.wide ? ' stack__item--wide' : ''}">
  <div class="stack__label">
    <span class="stack__title">${esc(s.title)}</span>
    ${s.tag ? `<span class="stack__tag">${esc(s.tag)}</span>` : ''}
  </div>
  ${s.board}
</div>`,
    )
    .join('');

  const heroHtml = hero
    ? `<div class="stack__hero"><h1>${esc(hero.heading)}</h1><p>${esc(hero.sub)}</p></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="description" content="麦麦参考榜 · 基于麦当劳官方 MCP 的客观指标决策榜单。非麦当劳官方产品。">
<title>${esc(title)}</title>
${renderStyles()}
</head>
<body>
<div class="page">
<div class="stack">${heroHtml}${items}</div>
</div>
${TAB_SCRIPT}
</body>
</html>`;
}

/**
 * Tab 高度过渡脚本
 *
 * 职责单一：把面板容器的高度锁定为当前页高度并做过渡，使切换丝滑。
 * 切换本身由 CSS :checked 完成，因此本脚本缺失时 Tab 依然可用
 * （退化为容器高度取最高页，无高度动画）。
 */
const TAB_SCRIPT = `<script>
(function(){
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-tabs]').forEach(function(tabs){
    var wrap = tabs.querySelector('.tabs__panels');
    if(!wrap) return;
    var panels = [].slice.call(wrap.querySelectorAll('.tabs__panel'));
    if(!panels.length) return;

    function active(){
      for(var i=0;i<panels.length;i++){
        if(getComputedStyle(panels[i]).visibility === 'visible') return panels[i];
      }
      return panels[0];
    }
    function measure(){
      var p = active();
      if(!p) return;
      wrap.style.height = p.offsetHeight + 'px';
    }
    function enable(){
      tabs.classList.add('tabs--anim');
      measure();
    }

    tabs.querySelectorAll('.tabs__radio').forEach(function(r){
      r.addEventListener('change', function(){
        if(reduce){ wrap.style.height = 'auto'; return; }
        measure();
      });
    });

    // 首屏测量：等字体与布局稳定后再锁高
    if(document.readyState === 'complete') enable();
    else window.addEventListener('load', enable);

    if(window.ResizeObserver){
      var ro = new ResizeObserver(function(){ measure(); });
      panels.forEach(function(p){ ro.observe(p); });
    } else {
      window.addEventListener('resize', measure);
    }
  });
})();
</script>`;

/**
 * 渲染完整样式表
 *
 * 令牌定义见 DESIGN.md 第 2 节
 */
export function renderStyles(): string {
  return `
<style>
:root{
  --brand-red:#DA291C;--brand-red-hover:#B8221A;--brand-red-active:#8E1A14;
  --brand-gold:#FFC72C;--brand-gold-soft:#FFF3CE;
  --bg-page:#FFF9F2;--bg-card:#FFFFFF;--bg-sunken:#FDF3E7;--bg-brand-tint:#FFF1EC;
  --text-primary:#241A14;--text-secondary:#6E5B4E;--text-tertiary:#9C8878;
  --border:#F0E2D2;--border-strong:#E0CDB8;
  --value-green:#0F7B3F;--gold-deep:#B26A00;
  --fs-xs:11px;--fs-sm:12px;--fs-md:13px;--fs-lg:15px;--fs-xl:17px;
  --r-sm:8px;--r-md:12px;--r-lg:18px;--r-pill:999px;
  --shadow-card:0 1px 2px rgba(36,26,20,.04),0 8px 24px -12px rgba(36,26,20,.10);
  --font-base:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --page-bg:#FFF9F2;
  --page-fg:#241A14;
}

/* ═══════════════════════════════════════════════════════════
   容器自适应外壳
   宿主容器宽度不可预知（对话流可能 400px，产物面板可能 1200px），
   因此不针对「端」做分支，统一采用「窄则吃满、宽则居中定宽」策略。
   ═══════════════════════════════════════════════════════════ */
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg-page);color:var(--page-fg);font-family:var(--font-base)}
.page{
  padding:20px 12px;
  padding-left:max(12px,env(safe-area-inset-left));
  padding-right:max(12px,env(safe-area-inset-right));
  padding-bottom:max(20px,env(safe-area-inset-bottom));
  display:flex;justify-content:center;align-items:flex-start;
}
.board{
  width:100%;max-width:480px;
  background:var(--bg-card);border:1px solid var(--border);
  border-radius:var(--r-lg);box-shadow:var(--shadow-card);overflow:hidden;
}
/* 总览榜为多卡栅格，宽屏给更宽的上限 */
.board--wide{max-width:760px}

/* ── 头部 ── */
.board-head{padding:16px}
.board-title-row{display:flex;align-items:center;gap:10px}
.brand-mark{width:26px;height:26px;border-radius:var(--r-sm);background:var(--brand-red);color:#FFFFFF;font-size:var(--fs-md);font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.board-title-block{min-width:0}
.board-title{font-size:var(--fs-lg);font-weight:700;letter-spacing:-.01em;line-height:1.3}
.board-sub{font-size:var(--fs-sm);color:var(--text-secondary);margin-top:2px}
.board-status{font-size:var(--fs-sm);color:var(--text-secondary);margin-top:12px}
.board-status .dot,.expire-item .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--brand-gold);margin-right:6px;vertical-align:middle}

/* ── 覆盖率（常驻，不可折叠） ── */
.coverage{padding:12px 16px;border-top:1px solid var(--border);margin:14px -16px -16px;background:var(--bg-brand-tint)}
.coverage-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.coverage-text{font-size:var(--fs-sm);color:var(--text-secondary)}
.coverage-text strong{font-size:var(--fs-lg);font-weight:700;color:var(--brand-red)}
.coverage-pct{font-size:var(--fs-sm);font-weight:500;color:var(--text-secondary)}
.coverage-bar{height:4px;border-radius:var(--r-pill);background:#F2E0D8;overflow:hidden;margin-top:8px}
.coverage-bar div{height:100%;border-radius:var(--r-pill);background:var(--brand-red)}
.coverage-note{font-size:var(--fs-xs);color:var(--text-tertiary);line-height:1.6;margin-top:8px}

/* ── 排名列表 ── */
.rank-item{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)}
.rank-item:last-child{border-bottom:none}
.rank-list{border-top:1px solid var(--border)}
.rank-badge{width:20px;height:20px;border-radius:6px;font-size:var(--fs-sm);font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.rank-badge--plain{background:var(--bg-sunken);color:var(--text-tertiary)}
.rank-body{flex:1;min-width:0}
.rank-name{font-size:var(--fs-md);font-weight:500;line-height:1.4}
.rank-meta,.mine-meta{font-size:var(--fs-sm);color:var(--text-secondary);margin-top:3px}
.data-bar{height:6px;border-radius:var(--r-pill);background:var(--bg-sunken);margin-top:8px;overflow:hidden}
.data-bar div{height:100%;border-radius:var(--r-pill)}
.rank-value{text-align:right;flex-shrink:0}
.rank-num{font-size:var(--fs-lg);font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.rank-unit{font-size:var(--fs-sm);font-weight:500;margin-left:1px}
.rank-label{font-size:var(--fs-xs);color:var(--text-tertiary);margin-top:2px}

/* ── 无数据分组 ── */
.divider{padding:8px 16px;font-size:var(--fs-xs);color:var(--text-tertiary);background:var(--bg-sunken);border-top:1px solid var(--border)}
.unmatched-item{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--border);background:var(--bg-sunken)}
.unmatched-item:last-child{border-bottom:none}
.unmatched-mark{width:4px;height:28px;border-radius:var(--r-pill);background:var(--border-strong);flex-shrink:0}
.unmatched-body{min-width:0}
.unmatched-name{font-size:var(--fs-md);color:var(--text-secondary)}
.unmatched-meta{font-size:var(--fs-xs);color:var(--text-tertiary);margin-top:2px}

/* ── 门店 / 钠值 / 常规列表 ── */
.store-list,.sodium-list,.mine-list{border-top:1px solid var(--border)}
.store-item,.sodium-item,.mine-item,.expire-item{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)}
.store-item:last-child,.sodium-item:last-child,.mine-item:last-child,.expire-item:last-child{border-bottom:none}
.store-mark{width:4px;height:32px;border-radius:var(--r-pill);flex-shrink:0}
.store-body,.sodium-body{flex:1;min-width:0}
.store-name,.sodium-name,.expire-name{font-size:var(--fs-md);font-weight:500;line-height:1.4}
.store-name.is-closed{color:var(--text-secondary);font-weight:400}
.store-time,.sodium-meta{font-size:var(--fs-sm);color:var(--text-secondary);margin-top:3px}
.store-time.is-closed{color:var(--text-tertiary);text-decoration:line-through}
.store-detail{font-size:var(--fs-xs);color:var(--text-tertiary);margin-top:3px}
.pill{font-size:var(--fs-sm);font-weight:500;flex-shrink:0;padding:3px 10px;border-radius:var(--r-pill)}
.sodium-bar{width:5px;height:32px;border-radius:var(--r-pill);flex-shrink:0}
.scale{display:flex;align-items:center;gap:8px;margin-top:12px}
.scale-label{font-size:var(--fs-xs);color:var(--text-tertiary)}
.scale-bar{flex:1;height:6px;border-radius:var(--r-pill);background:linear-gradient(to right,#F7DCA8,#E8A93C,#C2701A,#8A4A12)}

/* ── 区块 ── */
.section{padding:14px 16px;border-top:1px solid var(--border)}
.section-label{font-size:var(--fs-xs);color:var(--text-tertiary);margin-bottom:10px;text-transform:uppercase;letter-spacing:.04em}
.section-value{font-size:var(--fs-md)}

/* ── 空状态：转化为引导 ── */
.empty{padding:36px 24px;text-align:center;border-top:1px solid var(--border)}
.empty-icon{width:48px;height:48px;border-radius:50%;background:var(--bg-sunken);margin:0 auto 16px}
.empty-title{font-size:var(--fs-lg);font-weight:700;margin-bottom:8px}
.empty-desc{font-size:var(--fs-md);color:var(--text-secondary);line-height:1.6;margin-bottom:20px}

/* ── 主按钮：品牌红 ── */
/* 高度 44px：满足移动端最小触摸目标（WCAG 2.5.5 / iOS HIG） */
.btn-primary{display:block;width:100%;height:44px;border:none;border-radius:var(--r-md);background:var(--brand-red);color:#FFFFFF;font-family:inherit;font-size:var(--fs-md);font-weight:700;letter-spacing:.02em;cursor:pointer;box-shadow:0 2px 8px rgba(218,41,28,.24);transition:background .15s,box-shadow .15s,transform .15s}
.btn-primary:hover{background:var(--brand-red-hover);box-shadow:0 4px 12px rgba(218,41,28,.30);transform:translateY(-1px)}
.btn-primary:active{background:var(--brand-red-active);box-shadow:0 1px 3px rgba(218,41,28,.20);transform:translateY(0)}
.btn-primary:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(218,41,28,.28)}
.btn-primary:disabled{background:#E5D9CE;color:#A08D7D;box-shadow:none;cursor:not-allowed;transform:none}
.btn-primary--inline{display:inline-block;width:auto;padding:0 22px}

/* ── 底部 ── */
.board-foot{padding:14px 16px;border-top:1px solid var(--border);background:var(--bg-sunken)}
.compliance{font-size:var(--fs-xs);color:var(--text-tertiary);line-height:1.7}
.board-foot .btn-primary{margin-bottom:12px}

/* ── 总览榜：四榜导航栅格 ── */
/* auto-fit + minmax：窄屏 1 列，宽屏 2 列，无需媒体查询 */
.nav-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;padding:14px 16px}
.nav-card{display:block;padding:13px 14px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-card);text-decoration:none;color:inherit;cursor:pointer;transition:border-color .15s,background .15s,transform .15s}
.nav-card:hover{border-color:var(--border-strong);background:var(--bg-sunken);transform:translateY(-1px)}
.nav-card:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(218,41,28,.28)}
.nav-card--primary{border-color:#F5CFC9;background:var(--bg-brand-tint)}
.nav-card__top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}
.nav-card__title{font-size:var(--fs-md);font-weight:700;line-height:1.35}
.nav-card__desc{font-size:var(--fs-sm);color:var(--text-secondary);line-height:1.55;margin-top:4px}
.tag{font-size:var(--fs-xs);font-weight:700;padding:2px 7px;border-radius:var(--r-sm);flex-shrink:0;white-space:nowrap}
.tag--tools{color:var(--text-tertiary);background:var(--bg-sunken)}
.tag--primary{color:#FFFFFF;background:var(--brand-red)}
.tag--gold{color:#241A14;background:var(--brand-gold)}
.tag--exclusive{color:#FFFFFF;background:var(--value-green)}

/* ── 空状态图形（纯 CSS，无图片请求） ── */
.empty-icon{position:relative}
.empty-icon::before{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:19px;height:15px;border:2px solid var(--border-strong);border-radius:3px}
.empty-icon::after{content:"";position:absolute;left:50%;top:calc(50% - 5px);transform:translateX(-50%);width:9px;height:2px;background:var(--brand-gold);border-radius:1px}

/* ── Tab 组件 ── */
.tabs{position:relative}
.tabs__radio{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.tabs__bar{position:relative;display:flex;gap:2px;margin:12px 16px 4px;padding:4px;background:var(--bg-sunken);border-radius:var(--r-pill)}
.tabs__tab{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;padding:8px 4px;border-radius:var(--r-pill);font-size:var(--fs-sm);font-weight:500;color:var(--text-secondary);cursor:pointer;position:relative;z-index:1;white-space:nowrap;transition:color .28s ease;-webkit-tap-highlight-color:transparent}
.tabs__tab:hover{color:var(--text-primary)}
.tabs__cnt{font-size:10px;font-weight:700;color:var(--text-tertiary);transition:color .28s ease}
.tabs__tab:hover .tabs__cnt{color:var(--text-secondary)}
.tabs__ink{position:absolute;top:4px;bottom:4px;left:4px;width:calc((100% - 8px) / var(--n,2));background:var(--bg-card);border-radius:var(--r-pill);box-shadow:0 1px 3px rgba(36,26,20,.10);transition:transform .34s cubic-bezier(.34,1.2,.64,1);pointer-events:none}
/* 无脚本兜底：面板叠放，靠 :checked 控制可见性 */
.tabs__panels{display:grid;overflow:hidden}
.tabs__panel{grid-area:1/1;opacity:0;visibility:hidden;transform:translateY(6px);transition:opacity .3s ease,transform .3s ease,visibility .3s ease;min-width:0}
/* 有脚本时由脚本接管高度过渡 */
.tabs--anim .tabs__panels{transition:height .34s cubic-bezier(.34,1.2,.64,1)}

/* ── 说明块 ── */
.note{padding:12px 16px;background:var(--bg-brand-tint);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.note__row{display:flex;justify-content:space-between;font-size:var(--fs-sm);color:var(--text-secondary);line-height:1.9}
.note__row strong{color:var(--brand-red);font-weight:700}
.note__text{font-size:var(--fs-xs);color:var(--text-tertiary);line-height:1.65;margin-top:6px}
.note__text strong{color:var(--text-secondary)}

/* ── 组合求解 ── */
.chip-list{padding:10px 16px;border-bottom:1px solid var(--border)}
.chip-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:3px 0}
.chip-row__name{font-size:var(--fs-sm);font-weight:500;flex-shrink:0}
.chip-row__val{font-size:var(--fs-xs);color:var(--text-tertiary);text-align:right}
.objective{padding:10px 16px 0;font-size:var(--fs-xs);color:var(--text-tertiary);letter-spacing:.02em}
.pick{padding:10px 16px 4px}
.pick-item{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)}
.pick-item:last-child{border-bottom:none}
.pick-item__body{flex:1;min-width:0}
.pick-item__name{font-size:var(--fs-md);font-weight:500;line-height:1.4}
.pick-item__meta{font-size:var(--fs-xs);color:var(--text-tertiary);margin-top:3px}
.pick-item__p{font-size:var(--fs-sm);font-weight:700;color:var(--value-green);flex-shrink:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;padding:12px 16px 16px}
.stat{background:var(--bg-sunken);border-radius:var(--r-md);padding:10px 11px}
.stat__v{font-size:var(--fs-lg);font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.stat__v--strike{color:var(--text-tertiary);text-decoration:line-through;font-weight:500}
.stat__v--good{color:var(--value-green)}
.stat__k{font-size:10px;color:var(--text-tertiary);margin-top:3px}

/* ── 套餐拆解 ── */
.bd-list{border-top:1px solid var(--border)}
.bd-item{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--border)}
.bd-item:last-child{border-bottom:none}
.bd-item--dim{background:var(--bg-sunken)}
.bd-body{flex:1;min-width:0}
.bd-name{font-size:var(--fs-md);font-weight:500;line-height:1.4}
.bd-body .bd-meta{font-size:var(--fs-xs);color:var(--text-tertiary);margin-top:3px}
.bd-right{text-align:right;flex-shrink:0}
.bd-single{font-size:var(--fs-sm);font-weight:500;color:var(--text-secondary);font-variant-numeric:tabular-nums}
.bd-single--na{color:var(--text-tertiary);font-weight:400}
.bd-diff{font-size:10px;color:var(--brand-red);margin-top:2px;font-weight:500}
.bd-item--dim .bd-diff{color:var(--text-tertiary);font-weight:400}

/* ── 场景 ── */
.scenario-criteria{padding:10px 16px;font-size:var(--fs-xs);color:var(--text-tertiary);background:var(--bg-sunken);border-bottom:1px solid var(--border)}
.more-hint{padding:10px 16px;font-size:var(--fs-xs);color:var(--text-tertiary);text-align:center;border-top:1px solid var(--border)}

/* ── 完整报告：多榜纵向堆叠 ── */
.stack{display:flex;flex-direction:column;gap:30px;align-items:center;width:100%}
.stack__item{width:100%;max-width:480px}
.stack__item--wide{max-width:760px}
.stack__label{display:flex;align-items:baseline;gap:8px;margin:0 0 10px}
.stack__title{font-size:var(--fs-md);font-weight:700;letter-spacing:-.01em}
.stack__tag{font-size:var(--fs-xs);color:var(--text-tertiary)}
.stack__hero{width:100%;max-width:760px;margin-bottom:6px}
.stack__hero h1{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0;color:var(--text-primary)}
.stack__hero p{font-size:var(--fs-md);color:var(--text-secondary);line-height:1.7;margin:10px 0 0}
</style>`;
}
