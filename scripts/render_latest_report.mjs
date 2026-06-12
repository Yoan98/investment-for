#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = path.join("reports", "latest", "data.json");
const DEFAULT_REPORT = path.join("reports", "latest", "report.html");
const DEFAULT_SOURCES = path.join("reports", "latest", "sources.md");
const EXPECTED_MODEL_VERSION = "long_term_review_v5";

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPercent(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(2)}%`;
}

function changeWord(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  if (parsed > 0) return `上涨 ${formatPercent(parsed)}`;
  if (parsed < 0) return `下跌 ${formatPercent(parsed)}`;
  return `持平 ${formatPercent(parsed)}`;
}

function formatAmount(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知金额";
  return `${Math.round(parsed).toLocaleString("zh-CN")} 元`;
}

function formatAllocationPct(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  return `${parsed.toFixed(1)}%`;
}

function formatFreshness(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  if (parsed <= 0) return "<1 分钟";
  if (Number.isInteger(parsed)) return `${parsed} 分钟`;
  return `${parsed.toFixed(1)} 分钟`;
}

function toChinaString(isoString) {
  if (!isoString) return "未知";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/\//g, "-");
}

function formatDataTime(value) {
  if (!value) return "未知";
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)) return value;
  return toChinaString(value);
}

function fundFullName(fund) {
  if (!fund) return "未知基金";
  return `${fund.code} ${fund.name}`;
}

function assertCurrentModel(data) {
  if (data.model_version !== EXPECTED_MODEL_VERSION) {
    throw new Error(
      `Unsupported data model: ${data.model_version ?? "missing"}; expected ${EXPECTED_MODEL_VERSION}`
    );
  }
}

function statusLabel(status) {
  if (status === "green") return "继续成立";
  if (status === "yellow") return "边际观察";
  if (status === "red") return "明显转弱";
  if (status === "complete") return "完整";
  if (status === "partial") return "部分";
  if (status === "blocked") return "阻断";
  return status ?? "未知";
}

function statusClass(status) {
  if (status === "green" || status === "complete" || status === "buy") return "good";
  if (status === "yellow" || status === "partial" || status === "hold" || status === "watch") return "watch";
  return "stop";
}

function actionClass(action) {
  if (action === "buy") return "good";
  if (action === "hold" || action === "watch") return "watch";
  return "stop";
}

function listHtml(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return "<p class=\"muted\">无</p>";
  return `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderEvidenceItems(items) {
  const evidenceItems = Array.isArray(items) ? items : [];
  if (evidenceItems.length === 0) {
    return "<p class=\"muted\">本次没有抓到可写入这一方向的高价值原始信息。</p>";
  }

  return evidenceItems
    .map((item) => `
      <div class="evidence-row">
        <p><b>${escapeHtml(item.title)}</b></p>
        <p class="meta">${escapeHtml(item.source)}｜${escapeHtml(item.time)}｜<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">来源链接</a></p>
        <p><b>原始事实：</b>${escapeHtml(item.fact)}</p>
        <p><b>逻辑含义：</b>${escapeHtml(item.logic_impact)}</p>
      </div>
    `)
    .join("");
}

function renderFundEvidence(items) {
  const fundItems = Array.isArray(items) ? items : [];
  if (fundItems.length === 0) return "<p class=\"muted\">暂无基金表现证据。</p>";

  return fundItems
    .map((item) => `
      <div class="fund-row">
        <p><b>${escapeHtml(item.code)} ${escapeHtml(item.name)}</b>｜${escapeHtml(item.role)}</p>
        <p>${escapeHtml(item.position_review)}</p>
        <p>${escapeHtml(item.official_review)}</p>
        <p>${escapeHtml(item.intraday_review)}</p>
        <p class="muted">${escapeHtml(item.interpretation)}</p>
      </div>
    `)
    .join("");
}

function renderThesisReview(review) {
  return `
    <article class="review-card">
      <div class="card-head">
        <h3>${escapeHtml(review?.title ?? "长期逻辑")}</h3>
        <span class="badge ${statusClass(review?.status)}">${escapeHtml(review?.status_label ?? statusLabel(review?.status))}</span>
      </div>
      <p class="lead"><b>结论：</b>${escapeHtml(review?.conclusion ?? "暂无结论。")}</p>
      <div class="impact-grid">
        <p><b>是否改变配置逻辑：</b>${escapeHtml(review?.allocation_impact ?? "未知")}</p>
        <p><b>当前仓位含义：</b>${escapeHtml(review?.portfolio_impact ?? "未知")}</p>
        <p><b>对今天动作和金额的影响：</b>${escapeHtml(review?.execution_impact ?? "未知")}</p>
      </div>
      <h4>后续观察项</h4>
      ${listHtml(review?.watch_items)}
      <details class="evidence-details">
        <summary>展开证据和基金表现</summary>
        <h4>${escapeHtml(review?.review_window ?? "最近 1-2 个月")}发生了什么</h4>
        ${listHtml(review?.recent_developments)}
        <h4>原始信息证据</h4>
        ${renderEvidenceItems(review?.evidence_items)}
        <h4>结合基金表现怎么看</h4>
        ${renderFundEvidence(review?.fund_evidence)}
      </details>
    </article>
  `;
}

function renderAmountTiers(tiers) {
  const items = Array.isArray(tiers) ? tiers : [];
  if (items.length === 0) return "<p class=\"muted\">暂无金额档位。</p>";

  return `
    <div class="tier-grid">
      ${items
        .map((tier) => `
          <div class="tier">
            <p class="tier-label">${escapeHtml(tier.label)}</p>
            <p class="tier-amount">${escapeHtml(formatAmount(tier.amount))}</p>
            <p class="muted">${escapeHtml(tier.description ?? "")}</p>
          </div>
        `)
        .join("")}
    </div>
  `;
}

function renderActionCards(funds) {
  return funds
    .map((fund) => {
      const plan = fund.action_plan ?? {};
      return `
        <article class="action-card">
          <div class="card-head">
            <div>
              <h3>${escapeHtml(fundFullName(fund))}</h3>
              <p class="muted">${escapeHtml(fund.role)}</p>
            </div>
            <span class="badge ${actionClass(plan.action)}">${escapeHtml(plan.action_label ?? "未知")}</span>
          </div>
          <div class="action-keyline">
            <div>
              <p class="eyebrow">本次更建议</p>
              <p class="big-amount">${escapeHtml(formatAmount(plan.recommended_amount ?? 0))}</p>
            </div>
            <p>${escapeHtml(plan.reason ?? "暂无原因。")}</p>
          </div>
          ${renderAmountTiers(plan.amount_tiers)}
          <p><b>金额怎么来的：</b>${escapeHtml(plan.amount_rationale ?? "暂无金额说明。")}</p>
          <h4>证据支撑</h4>
          ${listHtml(plan.evidence_support)}
        </article>
      `;
    })
    .join("");
}

function renderPortfolioContext(portfolioContext) {
  const groups = Array.isArray(portfolioContext?.groups)
    ? portfolioContext.groups
    : [];
  const positions = Array.isArray(portfolioContext?.positions)
    ? portfolioContext.positions
    : [];
  const positionRows = positions
    .map((position) => {
      const snapshot = position.market_snapshot ?? {};
      return `
        <tr>
          <td>${escapeHtml(position.code)} ${escapeHtml(position.name)}</td>
          <td>${escapeHtml(position.role)}</td>
          <td>${escapeHtml(formatAmount(position.amount))}</td>
          <td>${escapeHtml(formatAllocationPct(position.allocation_pct))}</td>
          <td>${escapeHtml(formatPercent(snapshot.today_estimate_pct))}</td>
          <td>${escapeHtml(changeWord(snapshot.performance_1d_pct))}</td>
          <td>${escapeHtml(changeWord(snapshot.performance_1w_pct))}</td>
          <td>${escapeHtml(changeWord(snapshot.performance_1m_pct))}</td>
          <td>${escapeHtml(position.current_status ?? position.note ?? "")}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <section>
      <h2>组合仓位概览</h2>
      <p class="section-note">这一层放在最后，作为动作建议的背景材料。仓位来自用户手工提供。</p>
      <div class="portfolio-grid">
        ${groups
          .map((group) => `
            <article class="portfolio-panel">
              <h3>${escapeHtml(group.label)}</h3>
              <p class="amount">${escapeHtml(formatAmount(group.amount))}</p>
              <p>占总资产约 ${escapeHtml(formatAllocationPct(group.allocation_pct))}</p>
              <p class="muted">${escapeHtml(group.interpretation ?? "")}</p>
            </article>
          `)
          .join("")}
      </div>
      <div class="table-wrap compact-table">
        <table>
          <thead>
            <tr>
              <th>基金</th>
              <th>角色</th>
              <th>当前金额</th>
              <th>占总资产</th>
              <th>今日估算</th>
              <th>近 1 日</th>
              <th>近 1 周</th>
              <th>近 1 月</th>
              <th>当前状态</th>
            </tr>
          </thead>
          <tbody>${positionRows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function reportHtml(data) {
  assertCurrentModel(data);

  const generatedAt = toChinaString(data.generated_at);
  const quality = data.data_quality;
  const top = data.top_conclusion ?? {};
  const sourceErrors = Array.isArray(data.info_source_errors)
    ? data.info_source_errors
    : [];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.report_date)} 长期投资基金日报</title>
  <style>
    :root {
      --page: #f4f7f5;
      --paper: #ffffff;
      --ink: #172126;
      --muted: #5f6c72;
      --line: #d8e0dd;
      --good: #176b4a;
      --watch: #9b6b12;
      --stop: #b13a32;
      --blue: #245d8f;
      --shadow: 0 18px 44px rgba(23, 33, 38, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: linear-gradient(180deg, #edf4f0 0%, var(--page) 38%, #eef2f5 100%);
      font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif;
      line-height: 1.72;
    }
    main { width: min(1120px, calc(100% - 28px)); margin: 26px auto 56px; }
    section {
      margin: 0 0 22px;
      padding: 24px;
      background: rgba(255, 255, 255, 0.96);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }
    h1, h2, h3, h4, p { margin-top: 0; }
    h1 { max-width: 900px; font-size: clamp(30px, 4vw, 46px); line-height: 1.16; margin-bottom: 12px; }
    h2 { font-size: clamp(22px, 2.4vw, 30px); margin-bottom: 14px; }
    h3 { font-size: 19px; margin-bottom: 8px; }
    h4 { font-size: 15px; margin: 16px 0 8px; }
    a { color: var(--blue); }
    ul { margin: 0; padding-left: 20px; }
    li + li { margin-top: 5px; }
    .meta-row, .review-grid, .portfolio-grid, .action-list, .tier-grid { display: grid; gap: 14px; }
    .meta-row { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 18px; }
    .meta-pill {
      border-left: 4px solid var(--blue);
      background: #f7faf9;
      padding: 10px 12px;
      color: var(--muted);
      border-radius: 10px;
      font-size: 14px;
    }
    .section-note, .muted, .meta { color: var(--muted); }
    .meta, .section-note { font-size: 14px; }
    .topline {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      color: var(--muted);
      font-size: 14px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 10px;
      border-radius: 999px;
      color: white;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .badge.good { background: var(--good); }
    .badge.watch { background: var(--watch); }
    .badge.stop { background: var(--stop); }
    .hero-amounts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin: 16px 0;
    }
    .hero-amount {
      background: #f7faf9;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
    }
    .hero-amount strong, .big-amount, .tier-amount {
      display: block;
      font-size: 26px;
      line-height: 1.2;
      margin-top: 4px;
    }
    .eyebrow, .tier-label {
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.04em;
      margin-bottom: 4px;
    }
    .review-grid { grid-template-columns: 1fr; }
    .review-card, .portfolio-panel, .action-card, .tier {
      border: 1px solid var(--line);
      background: var(--paper);
      border-radius: 12px;
      padding: 18px;
    }
    .lead { font-size: 17px; }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 12px;
      margin-bottom: 8px;
    }
    .action-keyline {
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      background: #f7faf9;
      margin: 12px 0 14px;
    }
    .tier-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 14px; }
    .evidence-row, .fund-row {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      margin-top: 12px;
    }
    .impact-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px 16px;
      margin-top: 14px;
    }
    .portfolio-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .portfolio-panel .amount { font-size: 24px; font-weight: 800; margin-bottom: 2px; }
    .evidence-details {
      margin-top: 16px;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    .evidence-details summary {
      cursor: pointer;
      color: var(--blue);
      font-weight: 700;
    }
    .action-list { grid-template-columns: 1fr; }
    .action-card { border-left: 5px solid var(--blue); }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); }
    table { width: 100%; border-collapse: collapse; min-width: 980px; font-size: 14px; }
    .compact-table { margin-top: 14px; }
    .compact-table table { min-width: 1060px; }
    th, td { padding: 12px 13px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #e9efed; }
    tr:last-child td { border-bottom: 0; }
    .footer-note p:last-child { margin-bottom: 0; }
    @media (max-width: 780px) {
      main { width: min(100% - 18px, 1120px); margin-top: 12px; }
      section { padding: 18px; border-radius: 12px; }
      .meta-row, .portfolio-grid, .impact-grid, .tier-grid, .hero-amounts, .action-keyline { grid-template-columns: 1fr; }
      .card-head { flex-direction: column; }
    }
  </style>
</head>
<body>
<main>
  <section>
    <div class="meta-row">
      <div class="meta-pill">抓取时间：${escapeHtml(generatedAt)} CST</div>
      <div class="meta-pill">数据质量：${escapeHtml(statusLabel(quality?.status))} / ${escapeHtml(String(quality?.confidence_pct ?? "未知"))}%</div>
      <div class="meta-pill">实时覆盖：${escapeHtml(String(quality?.complete_fund_count ?? 0))}/${escapeHtml(String(quality?.fund_count ?? 0))}</div>
      <div class="meta-pill">最旧实时数据：${escapeHtml(formatFreshness(quality?.oldest_realtime_freshness_minutes))}</div>
    </div>
    <div class="topline">
      <span class="badge ${statusClass(top.status)}">${escapeHtml(top.status_label ?? statusLabel(top.status))}</span>
      <span>${escapeHtml(top.data_status ?? "数据状态未知")}</span>
    </div>
    <h1>${escapeHtml(top.headline ?? "今日建议未知")}</h1>
    <div class="hero-amounts">
      <div class="hero-amount">
        <span class="eyebrow">建议买入合计</span>
        <strong>${escapeHtml(formatAmount(top.total_buy_amount ?? 0))}</strong>
      </div>
      <div class="hero-amount">
        <span class="eyebrow">建议卖出合计</span>
        <strong>${escapeHtml(formatAmount(top.total_sell_amount ?? 0))}</strong>
      </div>
    </div>
    <p><b>具体动作：</b>${escapeHtml(top.action_summary ?? "未知")}</p>
    ${listHtml(top.focus)}
  </section>

  <section>
    <h2>今日操作建议</h2>
    <p class="section-note">行动卡直接给动作、金额和证据。金额来自当次信息，不使用固定默认比例。</p>
    <div class="action-list">${renderActionCards(data.funds ?? [])}</div>
  </section>

  <section>
    <h2>长期逻辑复核</h2>
    <div class="review-grid">
      ${renderThesisReview(data.thesis_reviews?.semiconductor ?? {})}
      ${renderThesisReview(data.thesis_reviews?.gold ?? {})}
    </div>
  </section>

  <section class="footer-note">
    <h2>来源与不确定性</h2>
    <p><b>信息来源摘要：</b>实时执行过滤器来自天天基金估值接口和腾讯行情代理；基金表现数据来自东方财富历史净值接口；长期逻辑复核证据来自 WSTS、World Gold Council 和 SAFE 等公开来源。</p>
    <p><b>金额建议说明：</b>本次金额由当次行情位置、长期证据、基金角色和组合仓位共同推导，不使用固定默认比例。</p>
    <p><b>生成上下文：</b>报告生成器已接收交易确认时间差、未确认买入状态和下一交易日风险作为背景输入；这些事实不作为固定规则展示。</p>
    <p><b>不确定性说明：</b>半导体代理仍是前十大持仓等权篮子，黄金代理为黄金 ETF 行情，它们适合过滤动作金额，不能替代正式净值或长期基本面判断。</p>
    <p><b>数据缺口：</b>${escapeHtml(sourceErrors.length > 0 ? sourceErrors.join("；") : "本次未发现关键数据抓取缺口。")}</p>
  </section>

  ${renderPortfolioContext(data.portfolio_context)}
</main>
</body>
</html>`;
}

function liveSourceBlock(fund, feedName, feed, purpose) {
  return `- 来源名称：${feed?.source_name ?? "未知"}
- 链接：${feed?.source_url ?? "未知"}
- 用途：${fundFullName(fund)} 的${purpose}。
- 数据时间：${feedName === "intraday" ? feed?.data_time ?? "未知" : formatDataTime(feed?.data_time)}
- 抓取时间：${toChinaString(feed?.fetch_time)}
- 新鲜度：${formatFreshness(feed?.freshness_minutes)}（有效交易时间）
- 是否可用于今日动作和金额建议：${feed?.usable_for_today_execution ? "是" : "否"}
- 抓取错误：${feed?.error ?? "无"}
- 可信度备注：用于过滤动作和金额，不替代长期逻辑判断。`;
}

function reviewEvidenceBlocks(data) {
  const reviews = [
    data.thesis_reviews?.semiconductor,
    data.thesis_reviews?.gold,
  ].filter(Boolean);

  return reviews
    .flatMap((review) =>
      (review.evidence_items ?? []).map((item) => `- 复核方向：${review.title}
- 条目标题：${item.title}
- 来源名称：${item.source}
- 链接：${item.url}
- 发布时间：${item.time}
- 原始事实：${item.fact}
- 逻辑含义：${item.logic_impact}`)
    )
    .join("\n\n");
}

function portfolioSourceBlock(data) {
  const context = data.portfolio_context ?? {};
  const positionBlocks = (context.positions ?? [])
    .map((position) => `- ${position.code} ${position.name}：${formatAmount(position.amount)}，占比约 ${formatAllocationPct(position.allocation_pct)}，状态：${position.current_status ?? position.note ?? "无"}`)
    .join("\n");

  return `- 来源名称：用户手工提供的组合仓位
- 总资产：${formatAmount(context.total_assets)}
- 口径：${context.as_of ?? "未知"}
- 持仓明细：
${positionBlocks || "- 未提供持仓明细"}
- 可信度备注：用于约束动作和金额；自动化尚未接入账户实时持仓，金额需要人工更新。`;
}

function executionContextBlock(data) {
  const context = data.execution_context ?? {};
  return `- 生成时间：${context.generated_at_local ?? "未知"}
- 通常确认截止时间：${context.order_cutoff_time ?? "15:00"}
- 当前时间窗口：${context.order_window ?? "未知"}
- 交易确认事实：${context.trade_confirmation_fact ?? "未知"}
- 未确认买入状态：${context.pending_order_status ?? "unknown"}
- 给生成器的说明：${context.model_instruction ?? "无"}`;
}

function amountGuidanceBlock(data) {
  const lines = (data.funds ?? []).map((fund) => {
    const plan = fund.action_plan ?? {};
    const tiers = (plan.amount_tiers ?? [])
      .map((tier) => `${tier.label} ${formatAmount(tier.amount)}`)
      .join("；");
    return `- ${fundFullName(fund)}：${plan.action_label ?? "未知"}，本次更建议 ${formatAmount(plan.recommended_amount ?? 0)}；档位：${tiers || "无"}`;
  });

  return `- 规则说明：不使用固定默认比例；金额由当次行情、长期证据、基金角色、组合仓位和生成上下文共同推导。
${lines.join("\n")}`;
}

function sourcesMarkdown(data) {
  assertCurrentModel(data);

  const liveBlocks = data.funds
    .flatMap((fund) => [
      liveSourceBlock(fund, "intraday", fund.intraday_estimate, "盘中估值"),
      liveSourceBlock(fund, "underlying", fund.underlying_realtime, "底层实时代理校验"),
    ])
    .join("\n\n");

  const performanceBlocks = (data.portfolio_context?.positions ?? [])
    .map((position) => {
      const snapshot = position.market_snapshot ?? {};
      return `- 基金：${position.code} ${position.name}
- 今日估算来源：${snapshot.today_estimate_source_url ?? "无"}
- 今日估算时间：${snapshot.today_estimate_time ?? "无"}
- 正式净值来源：${snapshot.official_source_url ?? "未知"}
- 最新正式净值日期：${snapshot.nav_date ?? "未知"}
- 用途：展示今日估算、近 1 日、近 1 周、近 1 月表现，并支撑动作金额判断。`;
    })
    .join("\n\n");

  return `# Sources - ${data.report_date}

> 生成时间：${toChinaString(data.generated_at)} CST
> 数据模型：${data.model_version}

## 实时执行过滤器

${liveBlocks}

## 基金表现数据来源

${performanceBlocks}

## 长期逻辑复核证据

${reviewEvidenceBlocks(data) || "- 本次未抓到可写入长期逻辑复核的官方事件。"}

## 组合仓位来源

${portfolioSourceBlock(data)}

## 生成上下文来源

${executionContextBlock(data)}

## 金额建议说明

${amountGuidanceBlock(data)}

## 本次数据质量

- 状态：${data.data_quality?.label ?? "未知"}
- 可信度：${data.data_quality?.confidence_pct ?? "未知"}%
- 说明：${data.data_quality?.reason ?? "未知"}
`;
}

function stripTrailingWhitespace(value) {
  return String(value).replace(/[ \t]+$/gm, "");
}

async function main() {
  const inputPath = getArg("--input", DEFAULT_INPUT);
  const reportPath = getArg("--report", DEFAULT_REPORT);
  const sourcesPath = getArg("--sources", DEFAULT_SOURCES);

  const raw = await readFile(inputPath, "utf8");
  const data = JSON.parse(raw);

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${stripTrailingWhitespace(reportHtml(data))}\n`, "utf8");
  await writeFile(sourcesPath, `${stripTrailingWhitespace(sourcesMarkdown(data))}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
