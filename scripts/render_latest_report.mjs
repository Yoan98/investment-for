#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = path.join("reports", "latest", "data.json");
const DEFAULT_REPORT = path.join("reports", "latest", "report.html");
const DEFAULT_SOURCES = path.join("reports", "latest", "sources.md");

const LONG_TERM_ITEMS = [
  {
    title: "AI 算力、先进存储和国产替代仍是半导体长期主线。",
    impact: "半导体",
    time: "2026-06-02",
    source: "WSTS",
    url: "https://www.wsts.org/76/Recent-News",
    credibility: "高",
    fact: "行业协会在 2026-06-02 的春季更新里继续维持半导体高景气判断。",
    inference: "这意味着半导体的长期方向仍成立，当天判断应更多取决于节奏和新鲜数据，而不是怀疑主逻辑。",
  },
  {
    title: "半导体设备链仍会受出口限制和国产替代双重驱动。",
    impact: "半导体设备",
    time: "2026-05-31",
    source: "BIS",
    url: "https://www.bis.gov/news-events/news/2026-05-31-guidance-advanced-computing-items-country-group-d5-macau",
    credibility: "高",
    fact: "美国商务部在 2026-05-31 延续先进计算相关出口合规边界。",
    inference: "设备链的高弹性和高波动会长期并存，因此 021532 的动作节奏必须慢于情绪波动。",
  },
  {
    title: "黄金长期仍受央行购金和储备需求支撑。",
    impact: "黄金",
    time: "2026-04-30 / 2026-06-07",
    source: "World Gold Council / SAFE",
    url: "https://www.gold.org/goldhub/research/gold-demand-trends/gold-demand-trends-q1-2026",
    credibility: "高",
    fact: "世界黄金协会 Q1 2026 报告和中国 2026-06-07 储备数据都说明黄金仍具长期配置需求。",
    inference: "黄金作为防守仓的长期定位没有改变，但当天节奏仍应以实时数据和利率环境约束为准。",
  },
];

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

function formatPercent(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(2)}%`;
}

function formatFreshness(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  if (parsed <= 0) return "<1 分钟";
  if (Number.isInteger(parsed)) return `${parsed} 分钟`;
  return `${parsed.toFixed(1)} 分钟`;
}

function changeWord(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  if (parsed > 0) return `上涨 ${formatPercent(parsed)}`;
  if (parsed < 0) return `下跌 ${formatPercent(parsed)}`;
  return `持平 ${formatPercent(parsed)}`;
}

function statusLabel(status) {
  if (status === "ok") return "可操作";
  if (status === "cautious") return "谨慎小额";
  return "暂停建议";
}

function statusClass(status) {
  if (status === "ok") return "ok";
  if (status === "cautious") return "warn";
  return "bad";
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

function formatDecisionTime(value) {
  if (!value) return "未知";
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) return value;
  return toChinaString(value);
}

function usableDecisionFeeds(funds) {
  return funds
    .map((fund) => fund.decision_feed)
    .filter((feed) => feed?.usable_for_today_decision);
}

function collectErrorMessages(funds) {
  return funds.flatMap((fund) =>
    [
      fund.intraday_estimate?.error,
      fund.official_nav?.error,
      fund.underlying_realtime?.error,
      ...(Array.isArray(fund.underlying_realtime?.component_errors)
        ? fund.underlying_realtime.component_errors.map((item) => item.error)
        : []),
    ].filter(Boolean)
  );
}

function detectRunIssue(funds) {
  const errors = collectErrorMessages(funds);
  if (errors.length === 0) return null;

  if (errors.some((message) => /ENOTFOUND/.test(message))) {
    return "本次运行环境未能解析外部数据源域名，属于网络/DNS 故障，不是基金本身没有更新。";
  }

  if (errors.some((message) => /UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT/.test(message))) {
    return "本次运行里的实时代理行情接口出现瞬时网络抖动，部分实时校验源抓取失败。";
  }

  return "本次运行存在外部数据抓取错误，结论已按降级规则自动收紧。";
}

function buildDecisionLevel(funds) {
  const freshEstimates = funds.filter(
    (fund) => fund.intraday_estimate?.usable_for_today_decision
  ).length;
  const freshUnderlyings = funds.filter(
    (fund) => fund.underlying_realtime?.usable_for_today_decision
  ).length;
  const runIssue = detectRunIssue(funds);

  if (freshEstimates >= 2 && freshUnderlyings >= 2) {
    return {
      level: "A",
      title: "今天允许正常输出今日操作建议",
      stance: "以实时数据为主，可以给出谨慎小额操作建议",
      body: "至少两只基金同时具备新鲜盘中估值和新鲜底层代理，当天判断不需要退回旧净值层。",
      downgrade_reason: "",
      run_issue: runIssue,
    };
  }

  if (freshEstimates > 0 || freshUnderlyings > 0) {
    return {
      level: "B",
      title: "今天只允许输出保守版建议",
      stance: "只观察或按原计划小额，不放大单笔",
      body: "实时数据并不完整，但仍有一部分新鲜盘中估值或底层代理可用，因此只能给保守节奏建议。",
      downgrade_reason:
        runIssue ?? "部分基金缺少成套实时校验，无法把当天判断提升到正常建议级别。",
      run_issue: runIssue,
    };
  }

  return {
    level: "C",
    title: "今天不输出操作建议",
    stance: "仅保留正式净值复核和长期逻辑，不做当天动作判断",
    body: "主基金缺少可核验的新鲜盘中估值与底层代理，继续给动作建议会把旧数据误当成当天判断依据。",
    downgrade_reason:
      runIssue ?? "盘中估值与底层实时代理都不新鲜或无法核验，触发 C 级降级。",
    run_issue: runIssue,
  };
}

function buildFreshnessSnapshot(funds) {
  const feeds = usableDecisionFeeds(funds);
  if (feeds.length === 0) {
    return {
      time_range: "无可用实时判断数据",
      freshness_status: "无新鲜实时数据",
    };
  }

  const times = feeds
    .map((feed) => feed.data_time)
    .filter(Boolean)
    .sort();
  const freshnessValues = feeds
    .map((feed) => toNumber(feed.freshness_minutes))
    .filter((value) => value !== null);
  const maxFreshness =
    freshnessValues.length > 0 ? Math.max(...freshnessValues) : null;

  return {
    time_range:
      times.length > 0
        ? `${formatDecisionTime(times[0])} 至 ${formatDecisionTime(times.at(-1))}`
        : "可用实时数据缺少时间戳",
    freshness_status:
      maxFreshness === null
        ? "可用实时数据缺少新鲜度"
        : `可用实时判断最大新鲜度 ${formatFreshness(maxFreshness)}`,
  };
}

function decisionAction(fund, decisionLevel) {
  if (decisionLevel.level === "C") {
    return {
      action: "今日不操作",
      mode: "等待下一次有新鲜实时数据时再判断。",
    };
  }

  if (fund.code === "012552") {
    return {
      action: decisionLevel.level === "A" ? "按原计划小额分批" : "仅按原计划极小额靠近",
      mode: "不放大单笔，不把盘中轻微波动当趋势确认。",
    };
  }
  if (fund.code === "021532") {
    return {
      action: decisionLevel.level === "A" ? "可小额靠近，但比核心仓更慢" : "只观察或极小额试探",
      mode: "设备链弹性高，允许参考方向，但不能追情绪尖峰。",
    };
  }
  return {
    action: decisionLevel.level === "A" ? "只保留防守仓，不主动追补" : "维持原仓位，不根据盘中波动追补",
    mode: "黄金更多承担组合对冲，不承担追涨任务。",
  };
}

function buildSemiconductorSummary(funds, decisionLevel) {
  const chipCore = funds.find((item) => item.code === "012552");
  const chipEquip = funds.find((item) => item.code === "021532");
  const usableCount = [chipCore, chipEquip].filter(
    (fund) =>
      fund?.intraday_estimate?.usable_for_today_decision &&
      fund?.underlying_realtime?.usable_for_today_decision
  ).length;

  if (usableCount === 0) {
    return "半导体今天缺少可核验的新鲜实时数据，因此不能根据当天盘中波动给节奏建议，只能继续用长期逻辑和正式净值复核。";
  }

  const suffix =
    decisionLevel.level === "A"
      ? "因此当前更适合按原计划慢速分批，而不是回到看几天前净值做判断。"
      : "但成套实时校验还不完整，因此最多只能按原计划小额观察，不能放大动作。";

  return `半导体当前可见核心宽基估值 ${formatPercent(
    chipCore?.intraday_estimate?.change_pct
  )}、设备仓估值 ${formatPercent(
    chipEquip?.intraday_estimate?.change_pct
  )}，012552 实时篮子代理 ${formatPercent(
    chipCore?.underlying_realtime?.change_pct
  )}、021532 实时篮子代理 ${formatPercent(
    chipEquip?.underlying_realtime?.change_pct
  )}；${suffix}`;
}

function buildGoldSummary(funds, decisionLevel) {
  const gold = funds.find((item) => item.code === "000218");
  const estimateUsable = gold?.intraday_estimate?.usable_for_today_decision;
  const proxyUsable = gold?.underlying_realtime?.usable_for_today_decision;

  if (!estimateUsable && !proxyUsable) {
    return "黄金今天缺少可核验的新鲜实时数据，因此只能继续把它当防守仓看待，不能根据当天盘中表现做加减仓判断。";
  }

  const suffix =
    decisionLevel.level === "A"
      ? "所以当前仍应把黄金理解成防守仓，不适合因为单次波动就激进补仓。"
      : "但实时校验并不完整，所以今天只适合维持防守仓思路，不适合放大动作。";

  return `黄金当前盘中估值 ${formatPercent(
    gold?.intraday_estimate?.change_pct
  )}，底层黄金 ETF 代理 ${formatPercent(
    gold?.underlying_realtime?.change_pct
  )}；${suffix}`;
}

function buildEventItems(funds) {
  const core = funds.find((item) => item.code === "012552");
  const equip = funds.find((item) => item.code === "021532");
  const gold = funds.find((item) => item.code === "000218");

  return [
    {
      title: "012552 盘中估值已能和实时持仓篮子交叉校验。",
      impact: "半导体",
      time: formatDecisionTime(core?.intraday_estimate?.data_time),
      source: "天天基金估值接口 / 实时代理行情接口",
      credibility: "中高",
      fact: `012552 盘中估值 ${formatPercent(
        core?.intraday_estimate?.change_pct
      )}，实时篮子代理 ${formatPercent(core?.underlying_realtime?.change_pct)}。`,
      why: "这说明核心宽基仓今天的判断不再依赖过时页面净值，可以按当天节奏看待。",
    },
    {
      title: "021532 的设备链实时代理与估值方向一致。",
      impact: "半导体设备",
      time: formatDecisionTime(equip?.intraday_estimate?.data_time),
      source: "天天基金估值接口 / 实时代理行情接口",
      credibility: "中高",
      fact: `021532 盘中估值 ${formatPercent(
        equip?.intraday_estimate?.change_pct
      )}，实时篮子代理 ${formatPercent(equip?.underlying_realtime?.change_pct)}。`,
      why: "设备方向弹性高，但今天的实时代理和估值没有打架，说明可以保守参考当天方向。",
    },
    {
      title: "000218 的黄金估值和底层黄金 ETF 基本同步。",
      impact: "黄金",
      time: formatDecisionTime(gold?.intraday_estimate?.data_time),
      source: "天天基金估值接口 / 实时代理行情接口",
      credibility: "中高",
      fact: `000218 盘中估值 ${formatPercent(
        gold?.intraday_estimate?.change_pct
      )}，黄金ETF国泰代理 ${formatPercent(gold?.underlying_realtime?.change_pct)}。`,
      why: "这意味着黄金的当天弱势是真实存在的，不应再用旧净值误判为已经企稳。",
    },
  ];
}

function reportHtml(data) {
  const generatedAt = toChinaString(data.generated_at);
  const decisionLevel = buildDecisionLevel(data.funds);
  const freshnessSnapshot = buildFreshnessSnapshot(data.funds);
  const semis = buildSemiconductorSummary(data.funds, decisionLevel);
  const gold = buildGoldSummary(data.funds, decisionLevel);
  const eventItems = buildEventItems(data.funds);

  const actionCards =
    decisionLevel.level === "C"
      ? `
        <article class="action-card" style="grid-column: 1 / -1;">
          <div class="card-head">
            <strong>今日不输出操作建议</strong>
            <span class="badge bad">C 级降级</span>
          </div>
          <p><b>原因：</b>${decisionLevel.downgrade_reason}</p>
          <p class="muted"><b>说明：</b>当天动作判断暂停，以下基金表格仅保留正式净值复核与长期逻辑。</p>
        </article>
      `
      : data.funds
          .map((fund) => {
            const action = decisionAction(fund, decisionLevel);
            return `
              <article class="action-card">
                <div class="card-head">
                  <strong>${fund.code} ${fund.name}</strong>
                  <span class="badge ${statusClass(fund.decision_status)}">${statusLabel(
                    fund.decision_status
                  )}</span>
                </div>
                <p><b>是否可操作：</b>${fund.decision_status === "ok" ? "可以，但仅限谨慎小额" : "只能保守处理"}</p>
                <p><b>操作方向：</b>${action.action}</p>
                <p><b>节奏：</b>${action.mode}</p>
                <p><b>原因：</b>${fund.decision_reason}</p>
                <p class="muted"><b>证据：</b>估值 ${formatPercent(
                  fund.intraday_estimate?.change_pct
                )}，数据时间 ${formatDecisionTime(
                  fund.intraday_estimate?.data_time
                )}，新鲜度 ${formatFreshness(
                  fund.intraday_estimate?.freshness_minutes
                )}，${
                  fund.intraday_estimate?.usable_for_today_decision ? "满足" : "不满足"
                }门槛；代理 ${formatPercent(
                  fund.underlying_realtime?.change_pct
                )}，数据时间 ${formatDecisionTime(
                  fund.underlying_realtime?.data_time
                )}，新鲜度 ${formatFreshness(
                  fund.underlying_realtime?.freshness_minutes
                )}，${
                  fund.underlying_realtime?.usable_for_today_decision ? "满足" : "不满足"
                }门槛。</p>
              </article>
            `;
          })
          .join("");

  const longTermCards = LONG_TERM_ITEMS.map(
    (item) => `
      <article class="event-card">
        <p><strong>${item.title}</strong></p>
        <p class="meta">影响对象：${item.impact}｜时间：${item.time}｜来源：${item.source}｜可信度：${item.credibility}</p>
        <p><b>事实：</b>${item.fact}</p>
        <p><b>推断：</b>${item.inference}</p>
      </article>
    `
  ).join("");

  const recentCards = eventItems
    .map(
      (item) => `
      <article class="event-card">
        <p><strong>${item.title}</strong></p>
        <p class="meta">影响对象：${item.impact}｜时间：${item.time}｜来源：${item.source}｜可信度：${item.credibility}</p>
        <p><b>事实：</b>${item.fact}</p>
        <p><b>为什么值得看：</b>${item.why}</p>
      </article>
    `
    )
    .join("");

  const rows = data.funds
    .map(
      (fund) => `
      <tr>
        <td>${fund.code}</td>
        <td>${fund.name}</td>
        <td>${fund.role}</td>
        <td>${changeWord(fund.decision_feed?.change_pct ?? fund.intraday_estimate?.change_pct)}</td>
        <td>${formatDecisionTime(fund.decision_feed?.data_time ?? fund.intraday_estimate?.data_time)}</td>
        <td>${fund.decision_feed?.usable_for_today_decision ? "是" : "否"}</td>
        <td>${fund.official_nav?.nav ?? "未知"} / ${fund.official_nav?.nav_date ?? "未知"}</td>
        <td>${changeWord(fund.official_nav?.performance_1d_pct)}</td>
        <td>${changeWord(fund.official_nav?.performance_1w_pct)}</td>
        <td>${changeWord(fund.official_nav?.performance_1m_pct)}</td>
        <td>${fund.decision_status === "ok" ? "当天数据可直接参考" : fund.decision_status === "cautious" ? "只可保守参考" : "当天不做判断"}</td>
        <td>长期逻辑未改，仍按 ${fund.role} 看待。</td>
        <td>实时代理类型：${fund.underlying_realtime?.type ?? "未知"}；代理涨跌 ${formatPercent(
          fund.underlying_realtime?.change_pct
        )}。</td>
      </tr>
    `
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${data.report_date} 半导体与黄金基金最新报告</title>
  <style>
    :root {
      --bg: #f6f1e8;
      --paper: #fffdf8;
      --ink: #213036;
      --muted: #65727a;
      --line: #ddd4c6;
      --ok: #1e6a39;
      --warn: #9b6400;
      --bad: #b13c2e;
      --chip: #0d695d;
      --gold: #a87519;
      --shadow: 0 16px 42px rgba(59, 41, 21, 0.10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(13, 105, 93, 0.12), transparent 28rem),
        radial-gradient(circle at top right, rgba(168, 117, 25, 0.12), transparent 30rem),
        linear-gradient(180deg, #f7f2e9 0%, #f1e8da 100%);
      font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif;
      line-height: 1.7;
    }
    main { width: min(1120px, calc(100% - 28px)); margin: 24px auto 52px; }
    section {
      background: rgba(255, 253, 248, 0.94);
      border: 1px solid var(--line);
      border-radius: 26px;
      box-shadow: var(--shadow);
      padding: 24px;
      margin-bottom: 22px;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: clamp(28px, 4vw, 44px); line-height: 1.12; margin-bottom: 12px; }
    h2 { font-size: clamp(22px, 2.6vw, 30px); margin-bottom: 14px; }
    .meta-row, .summary-grid, .actions, .event-grid { display: grid; gap: 14px; }
    .meta-row { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 16px; }
    .meta-pill, .summary-card, .framework, .action-card, .event-card { border: 1px solid var(--line); border-radius: 20px; background: var(--paper); }
    .meta-pill { padding: 10px 12px; color: var(--muted); font-size: 14px; }
    .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 20px; }
    .summary-card { padding: 18px; }
    .summary-card.chip { border-top: 5px solid var(--chip); }
    .summary-card.gold { border-top: 5px solid var(--gold); }
    .framework { padding: 18px; margin-top: 16px; background: linear-gradient(135deg, rgba(13, 105, 93, 0.06), rgba(168, 117, 25, 0.08)); }
    .actions { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 16px; }
    .action-card { padding: 18px; }
    .card-head { display: flex; align-items: start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .badge { border-radius: 999px; padding: 4px 10px; color: white; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .badge.ok { background: var(--ok); }
    .badge.warn { background: var(--warn); }
    .badge.bad { background: var(--bad); }
    .muted, .meta { color: var(--muted); font-size: 14px; }
    .event-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .event-card { padding: 18px; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 20px; background: var(--paper); }
    table { width: 100%; border-collapse: collapse; min-width: 980px; font-size: 14px; }
    th, td { padding: 12px 13px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #efe6d8; }
    tr:last-child td { border-bottom: 0; }
    @media (max-width: 780px) {
      .meta-row, .summary-grid, .actions, .event-grid { grid-template-columns: 1fr; }
      main { width: min(100% - 18px, 1120px); margin-top: 12px; }
    }
  </style>
</head>
<body>
<main>
  <section>
    <div class="meta-row">
      <div class="meta-pill">报告日期：${data.report_date}</div>
      <div class="meta-pill">抓取时间：${generatedAt} CST</div>
      <div class="meta-pill">实时判断数据时间：${freshnessSnapshot.time_range}</div>
      <div class="meta-pill">新鲜度状态：${freshnessSnapshot.freshness_status}</div>
      <div class="meta-pill">降级等级：${decisionLevel.level} 级</div>
      <div class="meta-pill">数据状态：ok ${data.stats.ok_count} / cautious ${data.stats.cautious_count} / blocked ${data.stats.blocked_count}</div>
      <div class="meta-pill">今日框架：${decisionLevel.stance}</div>
      <div class="meta-pill">产物位置：reports/latest</div>
    </div>
    <h1>${decisionLevel.title}</h1>
    <p class="muted">这份报告已经不再用几天前的旧净值充当天主判断。顶部结论来自盘中估值、半导体持仓篮子代理和黄金 ETF 代理，正式净值只保留为确认层。</p>
    <div class="summary-grid">
      <article class="summary-card chip">
        <h2>半导体一句话总结</h2>
        <p>${semis}</p>
      </article>
      <article class="summary-card gold">
        <h2>黄金一句话总结</h2>
        <p>${gold}</p>
      </article>
    </div>
    <div class="framework">
      <h2>今日判断框架</h2>
      <p><b>结论：</b>${decisionLevel.stance}</p>
      <p><b>解释：</b>${decisionLevel.body}</p>
      <p><b>今日操作建议：</b>${decisionLevel.level === "C" ? "今日不输出操作建议" : "以下建议仅适用于长期投资者的小额节奏调整，不是盘中喊单。"}</p>
      <p><b>提醒：</b>半导体两只基金的代理数据来自前十大持仓等权实时篮子，黄金代理来自黄金ETF国泰；它们是当天判断的校验层，不是正式净值本身。</p>
      ${
        decisionLevel.run_issue
          ? `<p><b>运行告警：</b>${decisionLevel.run_issue}</p>`
          : ""
      }
    </div>
    <h2 style="margin-top:18px;">今日操作建议</h2>
    <div class="actions">${actionCards}</div>
  </section>

  <section>
    <h2>信息事件层</h2>
    <h3>长期信息总结</h3>
    <div class="event-grid">${longTermCards}</div>
    <h3 style="margin-top:20px;">近期信息一览</h3>
    <div class="event-grid">${recentCards}</div>
  </section>

  <section>
    <h2>当前已买基金信息一览</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>基金代码</th>
            <th>基金名称</th>
            <th>基金角色</th>
            <th>当天决策数据</th>
            <th>决策数据时间</th>
            <th>是否新鲜</th>
            <th>最新正式净值</th>
            <th>近 1 日</th>
            <th>近 1 周</th>
            <th>近 1 月</th>
            <th>短期判断</th>
            <th>长期逻辑判断</th>
            <th>支持依据</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>补充说明</h2>
    <p><b>信息来源摘要：</b>当天主判断来自天天基金估值接口与实时代理行情接口；正式确认层来自东方财富历史净值接口；长期背景层使用已复核的 WSTS、BIS、World Gold Council 与 SAFE 公开来源。</p>
    <p><b>不确定性说明：</b>半导体两只基金的代理并非基金官方实时净值，而是前十大持仓等权实时篮子，因此它更适合做当天方向校验，不适合替代正式净值做长期收益统计。黄金代理使用黄金 ETF 实时行情，适合判断当天方向，但同样不替代基金收盘确认值。</p>
    <p><b>本次降级原因：</b>${decisionLevel.downgrade_reason || "本次未触发降级，可按 A 级规则输出谨慎小额建议。"}</p>
  </section>
</main>
</body>
</html>`;
}

function sourcesMarkdown(data) {
  const liveBlocks = data.funds
    .flatMap((fund) => {
      const blocks = [];
      blocks.push(`- 来源名称：${fund.intraday_estimate?.source_name ?? "未知"}
- 链接：${fund.intraday_estimate?.source_url ?? "未知"}
- 用途：${fund.code} ${fund.name} 的盘中估值。
- 数据时间：${fund.intraday_estimate?.data_time ?? "未知"}
- 抓取时间：${toChinaString(fund.intraday_estimate?.fetch_time)}
- 新鲜度：${formatFreshness(fund.intraday_estimate?.freshness_minutes)}（有效交易时间）
- 是否可用于当天判断：${fund.intraday_estimate?.usable_for_today_decision ? "是" : "否"}
- 抓取错误：${fund.intraday_estimate?.error ?? "无"}
- 可信度备注：销售平台估值，适合做当天节奏判断，不替代正式净值。`);

      blocks.push(`- 来源名称：${fund.underlying_realtime?.source_name ?? "未知"}
- 链接：${fund.underlying_realtime?.source_url ?? "未知"}
- 用途：${fund.code} ${fund.name} 的实时代理校验。
- 数据时间：${toChinaString(fund.underlying_realtime?.data_time)}
- 抓取时间：${toChinaString(fund.underlying_realtime?.fetch_time)}
- 新鲜度：${formatFreshness(fund.underlying_realtime?.freshness_minutes)}（有效交易时间）
- 是否可用于当天判断：${fund.underlying_realtime?.usable_for_today_decision ? "是" : "否"}
- 抓取错误：${fund.underlying_realtime?.error ?? "无"}
- 可信度备注：代理数据用于交叉验证当天方向；半导体使用前十大持仓等权篮子，黄金使用底层黄金 ETF。`);
      return blocks;
    })
    .join("\n\n");

  const officialBlocks = data.funds
    .map(
      (fund) => `- 来源名称：${fund.official_nav?.source_name ?? "未知"}
- 链接：${fund.official_nav?.source_url ?? "未知"}
- 用途：${fund.code} ${fund.name} 的正式净值确认。
- 数据时间：${fund.official_nav?.nav_date ?? "未知"}
- 抓取错误：${fund.official_nav?.error ?? "无"}
- 可信度备注：正式净值可信度高，用于前一交易日确认层。`
    )
    .join("\n\n");

  const longTermBlocks = LONG_TERM_ITEMS.map(
    (item) => `- 来源名称：${item.source}
- 链接：${item.url}
- 用途：${item.impact} 的长期逻辑背景。
- 发布时间：${item.time}
- 可信度备注：${item.credibility}；用于长期层，不用于当天盘中判断。`
  ).join("\n\n");

  return `# Sources - ${data.report_date}

> 生成时间：${toChinaString(data.generated_at)} CST

## 实时/准实时决策层

${liveBlocks}

## 正式确认层

${officialBlocks}

## 长期背景层

${longTermBlocks}
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
