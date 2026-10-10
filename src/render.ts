import type { RankedItem, RankResult, StoreAvailability } from './types.js';
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

  const items = ranked
    .map((item, i) => renderRankedItem(item, i, medianDensity))
    .join('\n');

  const noData =
    unmatched.length > 0
      ? `
<div class="divider"><span>暂无营养数据 · ${unmatched.length} 项</span></div>
${unmatched.map((u) => renderUnmatched(u.name, u.price)).join('\n')}`
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

  const cta =
    ranked.length > 0
      ? '<button class="btn-primary" type="button">加入购物车</button>'
      : '';

  return `${head}
<div class="rank-list">${items}</div>
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

export function renderSodiumBoard(data: SodiumBoardData): string {
  const items = data.items
    .map((item) => {
      const color = scaleColor(item.percentile);
      return `
<div class="sodium-item">
  <span class="sodium-bar" style="background:${color}"></span>
  <div class="sodium-body">
    <div class="sodium-name">${esc(item.productName)}</div>
    <div class="sodium-meta">钠 ${Math.round(item.sodium)}mg · 全菜单 ${fmt(item.percentile, 0)}% 分位</div>
  </div>
</div>`;
    })
    .join('\n');

  const head = boardHead(
    '钠值分布',
    `全菜单区间 ${Math.round(data.min)} 至 ${Math.round(data.max)}mg`,
    `<div class="scale">
      <span class="scale-label">低</span>
      <span class="scale-bar"></span>
      <span class="scale-label">高</span>
    </div>`,
  );

  return `${head}
<div class="sodium-list">${items}</div>
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
</body>
</html>`;
}

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
</style>`;
}
