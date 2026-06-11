#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = path.join("reports", "latest", "data.json");
const DEFAULT_REPORT = path.join("reports", "latest", "report.html");
const DEFAULT_SOURCES = path.join("reports", "latest", "sources.md");
const EXPECTED_MODEL_VERSION = "long_term_execution_v1";

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
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatter.format(date).replace(/\//g, "-");
}

function formatDataTime(value) {
  if (!value) return "未知";
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)) {
    return value;
  }
  return toChinaString(value);
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
  if (status === "green" || status === "complete") return "good";
  if (status === "yellow" || status === "partial") return "watch";
  return "stop";
}

function actionClass(action) {
  if (action === "normal_plan" || action === "small_approach") return "good";
  if (action === "half_plan" || action === "observe_only") return "watch";
  return "stop";
}

function listHtml(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return "<p class=\"muted\">无</p>";
  return `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function buildTodayActionSummary(funds, dataQuality) {
  if (!dataQuality?.can_issue_today_execution) {
    return "今日不输出执行建议，只保留长期逻辑复核和正式净值复核。";
  }

  const actions = funds.map(
    (fund) => `${fund.code} ${fund.execution_plan?.action_label ?? "未知"}`
  );
  return actions.join("；");
}

function renderThesisCard(title, thesis) {
  return `
    <article class="thesis-card">
      <div class="card-head">
        <h3>${escapeHtml(title)}</h3>
        <span class="badge ${statusClass(thesis?.status)}">${escapeHtml(statusLabel(thesis?.status))}</span>
      </div>
      <p>${escapeHtml(thesis?.view ?? "暂无长期逻辑说明。")}</p>
      <h4>观察项</h4>
      ${listHtml(thesis?.watch_items)}
    </article>
  `;
}

function renderExecutionWindow(data) {
  const quality = data.data_quality;
  const canIssue = quality?.can_issue_today_execution;
  return `
    <section>
      <h2>今日执行判断</h2>
      <div class="window-grid">
        <article class="plain-panel">
          <h3>今天先判断执行，不重判长期方向</h3>
          <p>长期逻辑决定是否继续配置，盘中估算和底层代理只决定今天是否按计划执行、减半、靠近或暂停。</p>
        </article>
        <article class="plain-panel">
          <h3>${canIssue ? "可以输出执行节奏" : "今天不输出执行建议"}</h3>
          <p>${escapeHtml(quality?.reason ?? "数据质量状态未知。")}</p>
        </article>
      </div>
    </section>
  `;
}

function renderActionCards(funds) {
  return funds
    .map((fund) => {
      const plan = fund.execution_plan ?? {};
      return `
        <article class="action-card">
          <div class="card-head">
            <div>
              <h3>${escapeHtml(fund.code)} ${escapeHtml(fund.name)}</h3>
              <p class="muted">${escapeHtml(fund.role)}</p>
            </div>
            <span class="badge ${actionClass(plan.action)}">${escapeHtml(plan.action_label ?? "未知")}</span>
          </div>
          <div class="action-grid">
            <p><b>执行幅度：</b>${escapeHtml(plan.amount_label ?? "未知")}</p>
            <p><b>节奏：</b>${escapeHtml(plan.cadence ?? "未知")}</p>
          </div>
          <p><b>原因：</b>${escapeHtml(plan.reason ?? "暂无原因。")}</p>
          <h4>证据</h4>
          ${listHtml(plan.evidence)}
          <h4>停止条件</h4>
          ${listHtml(plan.stop_conditions)}
        </article>
      `;
    })
    .join("");
}

function renderNavReviewTable(funds) {
  const rows = funds
    .map((fund) => `
      <tr>
        <td>${escapeHtml(fund.code)}</td>
        <td>${escapeHtml(fund.name)}</td>
        <td>${escapeHtml(fund.role)}</td>
        <td>${escapeHtml(fund.official_nav?.nav ?? "未知")} / ${escapeHtml(fund.official_nav?.nav_date ?? "未知")}</td>
        <td>${escapeHtml(changeWord(fund.official_nav?.performance_1d_pct))}</td>
        <td>${escapeHtml(changeWord(fund.official_nav?.performance_1w_pct))}</td>
        <td>${escapeHtml(changeWord(fund.official_nav?.performance_1m_pct))}</td>
        <td>${escapeHtml(fund.trigger_check?.official_nav_review ?? "正式净值仅用于复核。")}</td>
      </tr>
    `)
    .join("");

  return `
    <section>
      <h2>正式净值复核</h2>
      <p class="section-note">这一层只复核前一交易日结果，不覆盖今天的执行结论。</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>基金代码</th>
              <th>基金名称</th>
              <th>角色</th>
              <th>最新正式净值</th>
              <th>近 1 日</th>
              <th>近 1 周</th>
              <th>近 1 月</th>
              <th>复核结论</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderInfoCards(items, emptyText) {
  if (!Array.isArray(items) || items.length === 0) {
    return `
      <article class="info-card">
        <h3>${escapeHtml(emptyText)}</h3>
        <p class="muted">本次运行没有抓到足够高价值、且适合放进这一层的官方新增信息。</p>
      </article>
    `;
  }

  return items
    .map((item) => `
      <article class="info-card">
        <h3>${escapeHtml(item.title)}</h3>
        <p class="meta">影响对象：${escapeHtml(item.impact)}｜时间：${escapeHtml(item.time)}｜来源：<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.source)}</a>｜可信度：${escapeHtml(item.credibility)}</p>
        <p><b>原始信息：</b>${escapeHtml(item.fact)}</p>
        <p><b>可能影响：</b>${escapeHtml(item.effect)}</p>
      </article>
    `)
    .join("");
}

function reportHtml(data) {
  assertCurrentModel(data);

  const generatedAt = toChinaString(data.generated_at);
  const quality = data.data_quality;
  const thesis = data.portfolio_thesis;
  const actionSummary = buildTodayActionSummary(data.funds ?? [], quality);
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
      background:
        linear-gradient(180deg, #edf4f0 0%, var(--page) 38%, #eef2f5 100%);
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
    h1 { max-width: 880px; font-size: clamp(30px, 4vw, 46px); line-height: 1.16; margin-bottom: 12px; }
    h2 { font-size: clamp(22px, 2.4vw, 30px); margin-bottom: 14px; }
    h3 { font-size: 19px; margin-bottom: 8px; }
    h4 { font-size: 15px; margin: 14px 0 8px; }
    a { color: var(--blue); }
    ul { margin: 0; padding-left: 20px; }
    li + li { margin-top: 5px; }
    .meta-row, .thesis-grid, .window-grid, .action-list, .info-grid { display: grid; gap: 14px; }
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
    .thesis-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .thesis-card, .plain-panel, .action-card, .info-card {
      border: 1px solid var(--line);
      background: var(--paper);
      border-radius: 12px;
      padding: 18px;
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 12px;
      margin-bottom: 8px;
    }
    .window-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .action-list { grid-template-columns: 1fr; }
    .action-card { border-left: 5px solid var(--blue); }
    .action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; }
    .info-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); }
    table { width: 100%; border-collapse: collapse; min-width: 980px; font-size: 14px; }
    th, td { padding: 12px 13px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #e9efed; }
    tr:last-child td { border-bottom: 0; }
    .footer-note p:last-child { margin-bottom: 0; }
    @media (max-width: 780px) {
      main { width: min(100% - 18px, 1120px); margin-top: 12px; }
      section { padding: 18px; border-radius: 12px; }
      .meta-row, .thesis-grid, .window-grid, .info-grid, .action-grid { grid-template-columns: 1fr; }
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
      <span class="badge ${statusClass(thesis?.overall_status)}">${escapeHtml(statusLabel(thesis?.overall_status))}</span>
      <span>长期逻辑总状态</span>
    </div>
    <h1>${escapeHtml(thesis?.headline ?? "长期逻辑状态未知")}</h1>
    <p><b>今日执行：</b>${escapeHtml(actionSummary)}</p>
    <p class="section-note"><b>一句话原因：</b>长期配置逻辑先于盘中涨跌；今天的新鲜数据只用于过滤执行节奏。</p>
  </section>

  <section>
    <h2>长期逻辑复核</h2>
    <div class="thesis-grid">
      ${renderThesisCard("半导体长期逻辑", thesis?.semiconductor ?? {})}
      ${renderThesisCard("黄金长期逻辑", thesis?.gold ?? {})}
    </div>
  </section>

  ${renderExecutionWindow(data)}

  <section>
    <h2>具体基金行动卡</h2>
    <div class="action-list">${renderActionCards(data.funds ?? [])}</div>
  </section>

  ${renderNavReviewTable(data.funds ?? [])}

  <section>
    <h2>原始信息层</h2>
    <h3>近期信息</h3>
    <div class="info-grid">${renderInfoCards(data.recent_info_items, "近期高价值新增信息：无")}</div>
    <h3 style="margin-top:20px;">长期信息</h3>
    <div class="info-grid">${renderInfoCards(data.long_term_info_items, "长期关键锚点：本次未补充")}</div>
  </section>

  <section class="footer-note">
    <h2>来源与不确定性</h2>
    <p><b>信息来源摘要：</b>实时执行过滤器来自天天基金估值接口和腾讯行情代理；正式净值复核来自东方财富历史净值接口；原始信息层来自 WSTS、World Gold Council 和 SAFE 等公开来源。</p>
    <p><b>不确定性说明：</b>半导体代理仍是前十大持仓等权篮子，黄金代理为黄金 ETF 行情，它们适合过滤今天执行节奏，不能替代正式净值或长期基本面判断。</p>
    <p><b>数据缺口：</b>${escapeHtml(sourceErrors.length > 0 ? sourceErrors.join("；") : "本次未发现关键数据抓取缺口。")}</p>
  </section>
</main>
</body>
</html>`;
}

function liveSourceBlock(fund, feedName, feed, purpose) {
  return `- 来源名称：${feed?.source_name ?? "未知"}
- 链接：${feed?.source_url ?? "未知"}
- 用途：${fund.code} ${fund.name} 的${purpose}。
- 数据时间：${feedName === "intraday" ? feed?.data_time ?? "未知" : formatDataTime(feed?.data_time)}
- 抓取时间：${toChinaString(feed?.fetch_time)}
- 新鲜度：${formatFreshness(feed?.freshness_minutes)}（有效交易时间）
- 是否可用于今日执行：${feed?.usable_for_today_execution ? "是" : "否"}
- 抓取错误：${feed?.error ?? "无"}
- 可信度备注：用于过滤今天执行节奏，不替代长期逻辑判断。`;
}

function sourcesMarkdown(data) {
  assertCurrentModel(data);

  const liveBlocks = data.funds
    .flatMap((fund) => [
      liveSourceBlock(fund, "intraday", fund.intraday_estimate, "盘中估值"),
      liveSourceBlock(fund, "underlying", fund.underlying_realtime, "底层实时代理校验"),
    ])
    .join("\n\n");

  const officialBlocks = data.funds
    .map((fund) => `- 来源名称：${fund.official_nav?.source_name ?? "未知"}
- 链接：${fund.official_nav?.source_url ?? "未知"}
- 用途：${fund.code} ${fund.name} 的正式净值复核。
- 数据时间：${fund.official_nav?.nav_date ?? "未知"}
- 抓取错误：${fund.official_nav?.error ?? "无"}
- 可信度备注：正式净值可信度高，只用于复核前一交易日表现。`)
    .join("\n\n");

  const recentInfoBlocks = (data.recent_info_items ?? [])
    .map((item) => `- 条目标题：${item.title}
- 来源名称：${item.source}
- 链接：${item.url}
- 用途：${item.impact} 的近期原始信息。
- 发布时间：${item.time}
- 可信度备注：${item.credibility}；用于长期逻辑复核，不直接生成今日动作。`)
    .join("\n\n");

  const longTermInfoBlocks = (data.long_term_info_items ?? [])
    .map((item) => `- 条目标题：${item.title}
- 来源名称：${item.source}
- 链接：${item.url}
- 用途：${item.impact} 的长期原始信息。
- 发布时间：${item.time}
- 可信度备注：${item.credibility}；用于长期逻辑复核，不直接生成今日动作。`)
    .join("\n\n");

  return `# Sources - ${data.report_date}

> 生成时间：${toChinaString(data.generated_at)} CST
> 数据模型：${data.model_version}

## 实时执行过滤器

${liveBlocks}

## 正式净值复核

${officialBlocks}

## 原始信息层 - 近期信息

${recentInfoBlocks || "- 本次未抓到可写入近期信息的官方事件。"}

## 原始信息层 - 长期信息

${longTermInfoBlocks || "- 本次未抓到可写入长期信息的官方事件。"}

## 本次数据质量

- 状态：${data.data_quality?.label ?? "未知"}
- 可信度：${data.data_quality?.confidence_pct ?? "未知"}%
- 说明：${data.data_quality?.reason ?? "未知"}
`;
}

async function main() {
  const inputPath = getArg("--input", DEFAULT_INPUT);
  const reportPath = getArg("--report", DEFAULT_REPORT);
  const sourcesPath = getArg("--sources", DEFAULT_SOURCES);

  const raw = await readFile(inputPath, "utf8");
  const data = JSON.parse(raw);

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${reportHtml(data)}\n`, "utf8");
  await writeFile(sourcesPath, `${sourcesMarkdown(data)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
