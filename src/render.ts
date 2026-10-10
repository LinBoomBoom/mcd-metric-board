import type { RankedItem, RankResult, StoreAvailability } from './types.js';
import { COMPLIANCE_FOOTER, NEUTRAL_NOTE } from './compliance.js';

/**
 * 榜单渲染层
 *
 * 设计要点（依据 design/03-交互决策清单.md）：
 *   1. 覆盖率常驻顶部，不可折叠 —— 主动披露是可信度来源
 *   2. 密度条用榜单内相对比例，不用绝对刻度 —— 否则低密度项不可见
 *   3. 无数据项独立分组，中性灰竖条，不参与色阶 —— 没有数据就没有视觉编码
 *   4. 单色阶，不用红绿 —— 红绿在中国饮食语境构成健康评判
 *   5. 每屏固定合规区
 */

const SEMANTIC = {
  success: 'var(--color-text-success)',
  warning: 'var(--color-text-warning)',
  neutral: 'var(--color-text-secondary)',
  muted: 'var(--color-text-tertiary)',
} as const;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

/**
 * 渲染覆盖率披露条
 *
 * 固定在列表顶部。位置显眼但不喧宾夺主。
 */
export function renderCoverage(matched: number, total: number): string {
  const ratio = total > 0 ? (matched / total) * 100 : 0;
  return `
<div class="coverage">
  <div class="coverage-text">
    <strong>${matched}</strong> / ${total} 项有营养数据
  </div>
  <div class="coverage-bar"><div style="width:${fmt(ratio, 1)}%"></div></div>
  <div class="coverage-pct">${fmt(ratio, 1)}%</div>
</div>
<div class="coverage-note">
  官方营养表与门店实时菜单存在版本差。未匹配项标注「暂无营养数据」，不做推测映射。
</div>`;
}

/**
 * 渲染单条排名项
 */
function renderRankedItem(
  item: RankedItem,
  index: number,
  medianDensity: number,
): string {
  const aboveMedian = (item.density ?? 0) >= medianDensity;
  const valueColor = aboveMedian ? SEMANTIC.success : SEMANTIC.warning;
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
  <span class="rank-no">${index}</span>
  <div class="rank-body">
    <div class="rank-name">${esc(item.name)}</div>
    <div class="rank-meta">${esc(meta)}</div>
    <div class="rank-bar"><div style="width:${fmt(Math.min(ratio, 100), 1)}%;background:${valueColor}"></div></div>
  </div>
  <div class="rank-value">
    <div class="rank-num" style="color:${valueColor}">${fmt(density)}g</div>
    <div class="rank-unit">蛋白 / 百元</div>
  </div>
</div>`;
}

/**
 * 渲染无数据项
 */
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
 */
export function renderProteinBoard(result: RankResult): string {
  const { ranked, unmatched, coverage, medianDensity, storeName } = result;

  const head = `
<div class="board-head">
  <div class="board-title">每百元蛋白密度</div>
  <div class="board-sub">按实付价折算 · ${esc(storeName)}</div>
</div>
${renderCoverage(coverage.matched, coverage.total)}`;

  const items = ranked
    .map((item, i) => renderRankedItem(item, i + 1, medianDensity))
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
  <div class="empty-title">暂无可计算的数据</div>
  <div class="empty-desc">该门店菜单与官方营养表暂无对应项<br>换一家门店或稍后再试</div>
</div>`
      : '';

  return `${head}
<div class="rank-list">${items}</div>
${noData}
${empty}
<div class="board-foot">
  <div class="cta">加入购物车</div>
  <div class="compliance">${NEUTRAL_NOTE} · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/**
 * 渲染此刻可点榜
 */
export function renderNowBoard(stores: StoreAvailability[], periodText: string): string {
  const statusMeta: Record<StoreAvailability['status'], { label: string; color: string }> = {
    open: { label: '在售', color: SEMANTIC.success },
    closing: { label: '将打烊', color: SEMANTIC.warning },
    closed: { label: '已打烊', color: SEMANTIC.muted },
    unavailable: { label: '不可用', color: SEMANTIC.muted },
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

      return `
<div class="store-item">
  <span class="store-mark" style="background:${
    s.status === 'open' ? SEMANTIC.success : s.status === 'closing' ? SEMANTIC.warning : 'var(--color-border-secondary)'
  }"></span>
  <div class="store-body">
    <div class="store-name" ${s.status === 'closed' ? 'style="color:var(--color-text-secondary)"' : ''}>${esc(s.storeName)}</div>
    <div class="store-time" ${s.status === 'closed' ? 'style="text-decoration:line-through"' : ''}>${esc(timeText)}</div>
    ${detail.length ? `<div class="store-detail">${esc(detail.join(' · '))}</div>` : ''}
  </div>
  <span class="store-badge" style="color:${meta.color}">${meta.label}</span>
</div>`;
    })
    .join('\n');

  const openCount = stores.filter((s) => s.status === 'open' || s.status === 'closing').length;

  return `
<div class="board-head">
  <div class="board-status"><span class="dot"></span>${esc(periodText)}</div>
  <div class="board-title">此刻可点</div>
  <div class="board-sub">官方时段口径 · 附近 ${openCount} 店营业中</div>
</div>
<div class="store-list">${items}</div>
<div class="board-foot">
  <div class="compliance">营业时间与时段划分均取自官方 MCP 数据 · 供应状态以实时结果为准 · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/**
 * 渲染钠值分布榜
 */
export interface SodiumBoardData {
  items: Array<{ productName: string; sodium: number; percentile: number }>;
  min: number;
  max: number;
}

export function renderSodiumBoard(data: SodiumBoardData): string {
  const shown = data.items;

  const items = shown
    .map((item) => {
      // 单色阶：浅 → 深 表示 低 → 高
      const color = sodiumColor(item.percentile);
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

  return `
<div class="board-head">
  <div class="board-title">钠值分布</div>
  <div class="board-sub">全菜单区间 ${Math.round(data.min)} 至 ${Math.round(data.max)}mg</div>
  <div class="scale">
    <span class="scale-label">低</span>
    <span class="scale-bar"></span>
    <span class="scale-label">高</span>
  </div>
</div>
<div class="sodium-list">${items}</div>
<div class="board-foot">
  <div class="compliance">色阶仅表示钠含量相对高低，不含评判含义 · ${COMPLIANCE_FOOTER}</div>
</div>`;
}

/** 单色阶映射：琥珀 → 深琥珀（绝不用红绿） */
function sodiumColor(percentile: number): string {
  const stops = ['#FAC775', '#EF9F27', '#BA7517', '#854F0B'];
  const idx = Math.min(stops.length - 1, Math.floor((percentile / 100) * stops.length));
  return stops[idx] ?? stops[0]!;
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
  const hasData = data.topItems.length > 0;

  if (!hasData) {
    return `
<div class="board-head">
  <div class="board-title">我的常点榜</div>
  <div class="board-sub">仅本机运行时计算 · 不存储不上传</div>
</div>
<div class="empty">
  <div class="empty-icon"></div>
  <div class="empty-title">你的常点榜还是空的</div>
  <div class="empty-desc">点一次外卖或到店<br>这里就会长出你的专属榜单</div>
  <div class="empty-cta">去点一单</div>
</div>
<div class="board-foot">
  <div class="compliance">数据来自你的账户，仅用于本次分析 · ${COMPLIANCE_FOOTER}</div>
</div>`;
  }

  const top = data.topItems
    .map(
      (item, i) => `
<div class="mine-item">
  <span class="rank-no">${i + 1}</span>
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

  return `
<div class="board-head">
  <div class="board-title">我的常点榜</div>
  <div class="board-sub">仅本机运行时计算 · 不存储不上传</div>
</div>
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

/** 渲染完整样式表 */
export function renderStyles(): string {
  return `
<style>
.board{border:0.5px solid var(--color-border-tertiary);border-radius:12px;background:var(--color-background-primary);overflow:hidden}
.board-head{padding:14px 16px;border-bottom:0.5px solid var(--color-border-tertiary)}
.board-title{font-size:15px;font-weight:500}
.board-sub{font-size:12px;color:var(--color-text-secondary);margin-top:3px}
.board-status{font-size:12px;color:var(--color-text-secondary);margin-bottom:8px}
.board-status .dot,.expire-item .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--color-text-warning);margin-right:6px}
.coverage{padding:10px 16px;border-bottom:0.5px solid var(--color-border-tertiary);display:flex;align-items:center;gap:8px}
.coverage-text{font-size:12px;color:var(--color-text-secondary);white-space:nowrap}
.coverage-text strong{font-size:13px;font-weight:500;color:var(--color-text-primary)}
.coverage-bar{flex:1;height:3px;border-radius:2px;background:var(--color-background-secondary);overflow:hidden}
.coverage-bar div{height:100%;background:var(--color-text-secondary)}
.coverage-pct{font-size:12px;color:var(--color-text-tertiary)}
.coverage-note{padding:8px 16px;font-size:11px;color:var(--color-text-tertiary);background:var(--color-background-secondary);line-height:1.6}
.rank-item{display:flex;align-items:flex-start;gap:10px;padding:10px 16px;border-bottom:0.5px solid var(--color-border-tertiary)}
.rank-no{font-size:13px;color:var(--color-text-tertiary);width:14px;flex-shrink:0}
.rank-body{flex:1;min-width:0}
.rank-name{font-size:13px;font-weight:500}
.rank-meta,.mine-meta{font-size:12px;color:var(--color-text-secondary);margin-top:2px}
.rank-bar{height:4px;border-radius:2px;background:var(--color-background-secondary);margin-top:8px;overflow:hidden}
.rank-bar div{height:100%}
.rank-value{text-align:right;flex-shrink:0}
.rank-num{font-size:13px;font-weight:500}
.rank-unit{font-size:11px;color:var(--color-text-tertiary)}
.divider{padding:8px 16px;font-size:11px;color:var(--color-text-tertiary);background:var(--color-background-secondary)}
.unmatched-item{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:0.5px solid var(--color-border-tertiary);background:var(--color-background-secondary)}
.unmatched-mark{width:4px;height:28px;border-radius:2px;background:var(--color-border-secondary);flex-shrink:0}
.unmatched-name{font-size:13px;color:var(--color-text-secondary)}
.unmatched-meta{font-size:11px;color:var(--color-text-tertiary);margin-top:2px}
.store-item,.sodium-item,.mine-item,.expire-item{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:0.5px solid var(--color-border-tertiary)}
.store-mark{width:4px;height:30px;border-radius:2px;flex-shrink:0}
.store-name,.sodium-name,.expire-name{font-size:13px;font-weight:500}
.store-time,.sodium-meta{font-size:12px;color:var(--color-text-secondary);margin-top:2px}
.store-detail{font-size:11px;color:var(--color-text-tertiary);margin-top:3px}
.store-badge{font-size:12px;flex-shrink:0;padding:3px 9px;border-radius:4px;background:var(--color-background-secondary)}
.sodium-bar{width:4px;height:30px;border-radius:2px;flex-shrink:0}
.scale{display:flex;align-items:center;gap:8px;margin-top:10px}
.scale-label{font-size:11px;color:var(--color-text-tertiary)}
.scale-bar{flex:1;height:6px;border-radius:3px;background:linear-gradient(to right,#FAC775,#EF9F27,#BA7517,#854F0B)}
.section{padding:12px 16px;border-bottom:0.5px solid var(--color-border-tertiary)}
.section-label{font-size:12px;color:var(--color-text-tertiary);margin-bottom:8px}
.section-value{font-size:13px}
.empty{padding:32px 24px;text-align:center}
.empty-icon{width:44px;height:44px;border-radius:50%;background:var(--color-background-secondary);margin:0 auto 16px}
.empty-title{font-size:15px;font-weight:500;margin-bottom:8px}
.empty-desc{font-size:13px;color:var(--color-text-secondary);line-height:1.6;margin-bottom:20px}
.empty-cta{display:inline-block;padding:8px 20px;border-radius:8px;background:var(--color-text-primary);color:var(--color-background-primary);font-size:13px;font-weight:500}
.board-foot{padding:12px 16px;border-top:0.5px solid var(--color-border-tertiary)}
.cta{padding:9px;border-radius:8px;background:var(--color-text-primary);color:var(--color-background-primary);font-size:13px;font-weight:500;text-align:center;margin-bottom:10px}
.compliance{font-size:11px;color:var(--color-text-tertiary);line-height:1.6}
</style>`;
}
