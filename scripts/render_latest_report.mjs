#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const EXPECTED_MODEL_VERSION = "long_term_review_v6";
const REPORTS_DIR = "reports";
const LONG_TERM_MEMORY_PATH = path.join(REPORTS_DIR, "long-term-memory.md");
const RECENT_REPORT_LIMIT = 7;
const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function todayInShanghai(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

async function readTextIfExists(filePath, fallback = "") {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
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
        <p><b>历史复盘影响：</b>${escapeHtml(review?.history_impact ?? "暂无历史复盘影响。")}</p>
        <p><b>长期记忆影响：</b>${escapeHtml(review?.long_term_memory_impact ?? "暂无长期记忆影响。")}</p>
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

function formatEffectiveness(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "样本不足";
  return `${parsed}%`;
}

function renderHistoryReview(review) {
  const items = Array.isArray(review?.review_items) ? review.review_items : [];
  const itemRows = items
    .slice(0, 8)
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.date)}</td>
        <td>${escapeHtml(item.fund)}</td>
        <td>${escapeHtml(item.prior_action)} ${escapeHtml(formatAmount(item.prior_amount))}</td>
        <td>${escapeHtml(item.current_action)}</td>
        <td>${escapeHtml(item.effective ? "暂时有效" : "需要修正")}</td>
        <td>${escapeHtml(item.reason)}</td>
      </tr>
    `)
    .join("");

  return `
    <section>
      <h2>近 7 日判断复盘</h2>
      <p class="section-note">这里复盘的是判断是否仍然站得住，不是预测准确率。样本不足时不硬算百分比。</p>
      <div class="history-grid">
        <article class="history-panel">
          <p class="eyebrow">判断有效率</p>
          <p class="history-score">${escapeHtml(formatEffectiveness(review?.effectiveness_pct))}</p>
        </article>
        <article class="history-panel">
          <p class="eyebrow">复盘样本</p>
          <p class="history-score">${escapeHtml(String(review?.sample_size ?? 0))} 条</p>
        </article>
      </div>
      <p><b>复盘口径：</b>${escapeHtml(review?.basis ?? "暂无历史复盘口径。")}</p>
      <div class="impact-grid">
        <div>
          <h4>判断有效的地方</h4>
          ${listHtml(review?.accurate_points)}
        </div>
        <div>
          <h4>判断不准确或证据不足的地方</h4>
          ${listHtml(review?.inaccurate_points)}
        </div>
        <div>
          <h4>后续建议修正</h4>
          ${listHtml(review?.follow_up_adjustments)}
        </div>
      </div>
      ${
        itemRows
          ? `<details class="evidence-details">
              <summary>展开逐条复盘</summary>
              <div class="table-wrap compact-table">
                <table>
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>基金</th>
                      <th>当时动作</th>
                      <th>今天动作</th>
                      <th>结论</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>${itemRows}</tbody>
                </table>
              </div>
            </details>`
          : "<p class=\"muted\">暂无可逐条复盘的日期报告。</p>"
      }
    </section>
  `;
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

function sourceStatusLabel(status) {
  if (status === "collected") return "已采集";
  if (status === "selected_but_no_current_signal") return "已选但本轮无有效信号";
  if (status === "registered_not_collected") return "注册候选，未采集";
  return status ?? "未知";
}

function renderSourceSelection(data) {
  const selection = data.source_selection ?? {};
  const selected = Array.isArray(selection.selected_sources)
    ? selection.selected_sources
    : [];
  const collected = selected.filter((source) => source.collection_status === "collected");
  const notCollected = selected.filter((source) => source.collection_status !== "collected");
  const historyContext = data.history_context ?? {};
  const memory = data.long_term_memory ?? {};
  const sourceErrors = Array.isArray(data.info_source_errors)
    ? data.info_source_errors
    : [];

  return `
    <section class="footer-note">
      <h2>来源与不确定性</h2>
      <p><b>本轮来源选择：</b>${escapeHtml(selection.strategy ?? "按来源注册表选择可用来源。")}</p>
      <p><b>已进入证据的来源：</b>${escapeHtml(
        collected.length > 0
          ? collected.map((source) => source.name).join("、")
          : "本轮没有抓到可进入证据的长期来源。"
      )}</p>
      <p><b>选中但未进入证据：</b>${escapeHtml(
        notCollected.length > 0
          ? notCollected
              .map((source) => `${source.name}（${sourceStatusLabel(source.collection_status)}）`)
              .join("、")
          : "无"
      )}</p>
      <p><b>历史报告：</b>已读取 ${escapeHtml(String(historyContext.usable_report_count ?? 0))} 份可用日期报告，最近目录：${escapeHtml((historyContext.dates ?? []).join("、") || "无")}。</p>
      <p><b>长期记忆：</b>${escapeHtml(memory.loaded ? `已读取 ${memory.path}` : "未读取")}；${escapeHtml(memory.created ? "本轮首次创建。" : "已用于长期逻辑复核。")}</p>
      <p><b>金额建议说明：</b>本次金额由当次行情位置、长期证据、基金角色、组合仓位、最近复盘和长期记忆共同推导，不使用固定默认比例。</p>
      <p><b>生成上下文：</b>报告生成器已接收交易确认时间差、未确认买入状态和下一交易日风险作为背景输入；这些事实不作为固定规则展示。</p>
      <p><b>不确定性说明：</b>半导体代理仍是前十大持仓等权篮子，黄金代理为黄金 ETF 行情，它们适合过滤动作金额，不能替代正式净值或长期基本面判断。</p>
      <p><b>数据缺口：</b>${escapeHtml(sourceErrors.length > 0 ? sourceErrors.join("；") : "本次未发现关键数据抓取缺口。")}</p>
    </section>
  `;
}

function reportHtml(data) {
  assertCurrentModel(data);

  const generatedAt = toChinaString(data.generated_at);
  const quality = data.data_quality;
  const top = data.top_conclusion ?? {};

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
    .meta-row, .review-grid, .portfolio-grid, .action-list, .tier-grid, .history-grid { display: grid; gap: 14px; }
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
    .review-card, .portfolio-panel, .action-card, .tier, .history-panel {
      border: 1px solid var(--line);
      background: var(--paper);
      border-radius: 12px;
      padding: 18px;
    }
    .history-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 12px 0 14px; }
    .history-score { font-size: 28px; font-weight: 800; margin-bottom: 0; }
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
      .meta-row, .portfolio-grid, .impact-grid, .tier-grid, .hero-amounts, .action-keyline, .history-grid { grid-template-columns: 1fr; }
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

  ${renderHistoryReview(data.history_review)}

  <section>
    <h2>长期逻辑复核</h2>
    <div class="review-grid">
      ${renderThesisReview(data.thesis_reviews?.semiconductor ?? {})}
      ${renderThesisReview(data.thesis_reviews?.gold ?? {})}
    </div>
  </section>

  ${renderSourceSelection(data)}

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

  return `- 说明：不使用固定默认比例；金额由当次行情、长期证据、基金角色、组合仓位、最近复盘、长期记忆和生成上下文共同推导。
${lines.join("\n")}`;
}

function sourceSelectionMarkdown(data) {
  const registry = data.source_registry ?? {};
  const selection = data.source_selection ?? {};
  const selected = selection.selected_sources ?? [];
  const proposed = selection.proposed_sources ?? [];

  const selectedLines = selected.map((source) => `- ${source.name}（${source.id}）
  - 类别：${source.category}
  - 可靠性：${source.reliability}
  - 本轮状态：${sourceStatusLabel(source.collection_status)}
  - 选择原因：${source.selected_reason}
  - 链接：${source.url}`);

  const proposedLines = proposed.map((source) => `- ${source.name}
  - 用途：${source.use_case}
  - 可靠性：${source.reliability}
  - 接入方式：${source.proposed_collection}
  - 原因：${source.reason}`);

  return `- 来源注册表版本：${registry.version ?? selection.registry_version ?? "未知"}
- 来源注册表来源数：${registry.source_count ?? "未知"}
- 本轮策略：${selection.strategy ?? "未知"}

### 本轮选中来源

${selectedLines.join("\n") || "- 无"}

### 本轮候选新增来源

${proposedLines.join("\n") || "- 无"}`;
}

function historyContextMarkdown(data) {
  const context = data.history_context ?? {};
  const files = context.referenced_files ?? [];
  const fileLines = files.map((file) => `- ${file.path}：${file.exists ? "存在" : "缺失"}，${file.bytes ?? 0} bytes`);
  const review = data.history_review ?? {};

  return `- 最近日期目录数量：${context.report_count ?? 0}
- 可用日期报告数量：${context.usable_report_count ?? 0}
- 日期：${(context.dates ?? []).join("、") || "无"}
- 判断有效率：${formatEffectiveness(review.effectiveness_pct)}
- 样本数：${review.sample_size ?? 0}
- 复盘口径：${review.basis ?? "无"}
- 文件：
${fileLines.join("\n") || "- 暂无历史文件"}`;
}

function longTermMemoryMarkdown(data) {
  const memory = data.long_term_memory ?? {};
  return `- 路径：${memory.path ?? "未知"}
- 是否读取：${memory.loaded ? "是" : "否"}
- 是否本轮创建：${memory.created ? "是" : "否"}
- 文件大小：${memory.bytes ?? 0} bytes
- 摘要：${memory.excerpt ?? "无"}`;
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

## 本轮来源选择

${sourceSelectionMarkdown(data)}

## 基金表现数据来源

${performanceBlocks}

## 长期逻辑复核证据

${reviewEvidenceBlocks(data) || "- 本次未抓到可写入长期逻辑复核的官方事件。"}

## 最近 7 日历史报告

${historyContextMarkdown(data)}

## 长期记忆

${longTermMemoryMarkdown(data)}

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

async function listDatedReportDirs() {
  let entries = [];
  try {
    entries = await readdir(REPORTS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && DATE_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

async function ensureDatedDataFile(data, inputPath) {
  const datedDir = path.join(REPORTS_DIR, data.report_date);
  const datedDataPath = path.join(datedDir, "data.json");
  await mkdir(datedDir, { recursive: true });
  if (path.resolve(inputPath) !== path.resolve(datedDataPath)) {
    await copyFile(inputPath, datedDataPath);
  }
}

async function readPrunedReportSummary(dirName) {
  const dirPath = path.join(REPORTS_DIR, dirName);
  const [dataRaw, sourcesRaw] = await Promise.all([
    readTextIfExists(path.join(dirPath, "data.json"), ""),
    readTextIfExists(path.join(dirPath, "sources.md"), ""),
  ]);
  let data = null;
  try {
    data = dataRaw ? JSON.parse(dataRaw) : null;
  } catch {
    data = null;
  }

  return {
    date: dirName,
    headline: data?.top_conclusion?.headline ?? "未知结论",
    action_summary: data?.top_conclusion?.action_summary ?? "未知动作",
    history_effectiveness_pct: data?.history_review?.effectiveness_pct ?? null,
    source_excerpt: sourcesRaw.slice(0, 600),
  };
}

function extractMemoryEntries(existingText) {
  const marker = "## 最近压缩更新";
  const index = existingText.indexOf(marker);
  if (index === -1) return [];
  const tail = existingText.slice(index + marker.length);
  return tail
    .split(/\n(?=### \d{4}-\d{2}-\d{2})/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("### "));
}

function markdownList(items, fallback = "暂无。") {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return `- ${fallback}`;
  return list.map((item) => `- ${item}`).join("\n");
}

function buildMemoryEntry(data, prunedReports) {
  const actions = (data.funds ?? [])
    .map((fund) => `${fundFullName(fund)} ${fund.action_plan?.action_label ?? "未知"} ${formatAmount(fund.action_plan?.recommended_amount ?? 0)}`)
    .join("；");
  const prunedText =
    prunedReports.length > 0
      ? `压缩并删除旧目录：${prunedReports.map((report) => report.date).join("、")}。`
      : "本轮没有超过 7 日的旧目录需要删除。";

  return `### ${data.report_date}

- 今日结论：${data.top_conclusion?.headline ?? "未知"}。
- 今日动作：${actions || "无"}。
- 判断有效率：${formatEffectiveness(data.history_review?.effectiveness_pct)}，样本 ${data.history_review?.sample_size ?? 0} 条。
- 有效判断：${(data.history_review?.accurate_points ?? []).slice(0, 2).join("；") || "暂无足够样本。"}
- 偏差判断：${(data.history_review?.inaccurate_points ?? []).slice(0, 2).join("；") || "暂无明显偏差。"}
- 来源可靠性：${(data.source_selection?.source_quality_notes ?? []).join("；") || "暂无来源沉淀。"}
- 旧报告处理：${prunedText}`;
}

function buildMemoryDocument(data, existingText, prunedReports) {
  const previousEntries = extractMemoryEntries(existingText)
    .filter((entry) => !entry.startsWith(`### ${data.report_date}`))
    .slice(0, 19);
  const newEntry = buildMemoryEntry(data, prunedReports);
  const entries = [newEntry, ...previousEntries].slice(0, 20);
  const selectedSources = data.source_selection?.selected_sources ?? [];
  const uncollectedSources = selectedSources
    .filter((source) => source.collection_status !== "collected")
    .map((source) => `${source.name}：${sourceStatusLabel(source.collection_status)}，暂不进入证据。`);
  const prunedNoise = prunedReports.map(
    (report) => `${report.date}：已压缩进长期记忆并删除日期目录，保留结论和动作摘要。`
  );

  return `# 长期记忆

> 本文件由日报自动化在每次生成报告后压缩、去噪并重写。不要手工追加流水账。

## 当前长期结论

- 半导体：${data.thesis_reviews?.semiconductor?.conclusion ?? "暂无。"}
- 黄金：${data.thesis_reviews?.gold?.conclusion ?? "暂无。"}

## 已验证有效的判断

${markdownList(data.history_review?.accurate_points)}

## 历史判断偏差

${markdownList(data.history_review?.inaccurate_points)}

## 资金与仓位经验

- ${data.portfolio_context?.summary ?? "暂无组合摘要。"}
- 今日动作：${data.top_conclusion?.action_summary ?? "暂无。"}
- 金额经验：${data.top_conclusion?.focus?.find((item) => item.includes("金额")) ?? "金额继续由当次证据、仓位和历史复盘共同推导。"}

## 来源可靠性

${markdownList(data.source_selection?.source_quality_notes)}

## 已删除或降权的噪音

${markdownList([...uncollectedSources, ...prunedNoise], "本轮未发现需要删除或降权的噪音。")}

## 最近压缩更新

${entries.join("\n\n")}
`;
}

async function updateLongTermMemory(data, prunedReports) {
  const existingText = await readTextIfExists(LONG_TERM_MEMORY_PATH, "");
  const nextText = buildMemoryDocument(data, existingText, prunedReports);
  await mkdir(path.dirname(LONG_TERM_MEMORY_PATH), { recursive: true });
  await writeFile(LONG_TERM_MEMORY_PATH, `${stripTrailingWhitespace(nextText)}\n`, "utf8");
}

async function pruneOldReportDirs() {
  const dirs = await listDatedReportDirs();
  const pruneDirs = dirs.slice(RECENT_REPORT_LIMIT);
  const summaries = await Promise.all(pruneDirs.map(readPrunedReportSummary));
  for (const dirName of pruneDirs) {
    await rm(path.join(REPORTS_DIR, dirName), { recursive: true, force: true });
  }
  return summaries;
}

async function main() {
  const inputDate = getArg("--date", todayInShanghai());
  const inputPath = getArg(
    "--input",
    path.join(REPORTS_DIR, inputDate, "data.json")
  );

  const raw = await readFile(inputPath, "utf8");
  const data = JSON.parse(raw);
  assertCurrentModel(data);
  const html = stripTrailingWhitespace(reportHtml(data));
  const sources = stripTrailingWhitespace(sourcesMarkdown(data));
  const reportPath = getArg(
    "--report",
    path.join(REPORTS_DIR, data.report_date, "report.html")
  );
  const sourcesPath = getArg(
    "--sources",
    path.join(REPORTS_DIR, data.report_date, "sources.md")
  );

  await ensureDatedDataFile(data, inputPath);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${html}\n`, "utf8");
  await writeFile(sourcesPath, `${sources}\n`, "utf8");

  const prunedReports = await pruneOldReportDirs();
  await updateLongTermMemory(data, prunedReports);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
