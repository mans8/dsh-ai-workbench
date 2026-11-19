/**
 * AI 工作台账 · AI Workbench — Client 半体（浏览器）。
 *
 * 注册两个槽位：
 *   - sidebar.panellist / id = ai-workbench  → 左侧全局面板图标
 *   - main / key = ai-workbench              → 中央整页工作台
 *
 * 六个分页：今日 / 待办 / 项目 / 工时 / 报表 / 统计（设置是右上角的齿轮弹层）。
 * 所有数据都来自 Host 半体的 /ai-workbench/api；本文件只负责呈现与交互，
 * **不重复计算任何口径**（完成率、达成率、缺口都由 Host 算好）。
 * 样式只用 --dsw-alias-* 主题令牌（产品品牌色除外），明暗主题自动跟随。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/ai-workbench/api';
    const PANEL_ID = 'ai-workbench';

    /** 产品品牌色（美术用色，不跟随主题）。 */
    const BRAND = {
      ink: '#0F1A24',
      jade: '#2E7D6F',
      jadeLight: '#3FA88F',
      gold: '#C9A227',
      cinnabar: '#C0392B',
    };

    const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

    /**
     * 优先级含义。
     * 这套定义同时用在：新建待办的下拉选项、行内徽标的悬浮说明、表单一行的图例，
     * 以及 workbench_todo 工具的描述里 —— 只有这一处权威定义。
     */
    const PRIORITY_INFO = {
      P0: { short: '紧急', full: 'P0 紧急 —— 立刻做：线上故障、阻塞别人的事、当天必须交付' },
      P1: { short: '高', full: 'P1 高 —— 尽快做：本周内要交付，或别人在等你的产出' },
      P2: { short: '中', full: 'P2 中 —— 正常排期（默认）：按计划推进即可' },
      P3: { short: '低', full: 'P3 低 —— 有空再做：想做的优化、可延期的杂事' },
    };

    /** 构建标记：设置弹层底部会显示，用来确认 DSH 到底加载了哪一版。 */
    const BUILD = 'v1.0.0 · 2026-11-19';

    /** 每个分页的页标题（对应参考稿里的「Main Dashboard」）。 */
    const TAB_TITLE = { today: '今天', projects: '项目', hours: '工时', reports: '报表', stats: '统计' };

    /** 可切换的皮肤。horizon 是 Pixso 参考稿那套；其余三套之前做过。 */
    const SKINS = [
      { id: 'horizon', label: 'Horizon' },
      { id: 'lido', label: '暖滩' },
      { id: 'dusk', label: '暮色' },
      { id: 'jade', label: '青玉' },
    ];
    const SKIN_KEY = 'aw-skin';
    function readSkin(explicit) {
      // 显式指定（URL 参数）优先，其次才是上次记住的那套，最后回落到 Dusk
      if (SKINS.some((skin) => skin.id === explicit)) return explicit;
      try {
        const saved = window.localStorage && window.localStorage.getItem(SKIN_KEY);
        if (SKINS.some((skin) => skin.id === saved)) return saved;
      } catch (error) {
        /* 读不到就用默认 */
      }
      return 'horizon';
    }

    /** 单条工单的工时上限（与宿主 MAX_TICKET_HOURS 一致）。 */
    const MAX_TICKET_HOURS = 300;

    /** 「历史完成」先露多少条，其余点「展开全部」。 */
    const HISTORY_PAGE = 8;

    /** 工单类型的默认候选项（与宿主 lib/state.js 的 TICKET_TYPES 保持一致）。 */
    const TICKET_TYPES = ['任务', '其他'];

    /** 表单一行的图例文案。 */
    const PRIORITY_LEGEND = PRIORITIES.map((value) => `${value} ${PRIORITY_INFO[value].short}`).join(' · ');

    /** 四个优先级的完整说明，用作悬浮提示。 */
    const PRIORITY_TIP = PRIORITIES.map((value) => PRIORITY_INFO[value].full).join('\n');
    // 优先级只决定一个语义类，颜色由当前皮肤给（P0 最急，P3 最轻）
    const PRIORITY_CLASS = { P0: 'is-p0', P1: 'is-p1', P2: 'is-p2', P3: 'is-p3' };

    /* ================= 工具函数 ================= */

    /** 浏览器本地日期 YYYY-MM-DD。 */
    function localToday() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    /** 月份键 YYYY-MM。 */
    function monthOf(key) {
      return String(key).slice(0, 7);
    }

    /** 月份平移。 */
    function shiftMonth(ym, delta) {
      const [y, m] = String(ym).split('-').map(Number);
      const total = y * 12 + (m - 1) + delta;
      return `${Math.floor(total / 12)}-${String(((total % 12) + 12) % 12 + 1).padStart(2, '0')}`;
    }

    /** 日期平移。 */
    function shiftDay(key, delta) {
      const [y, m, d] = String(key).split('-').map(Number);
      const dt = new Date(y, m - 1, d, 12);
      dt.setDate(dt.getDate() + delta);
      const p = (n) => String(n).padStart(2, '0');
      return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
    }

    /** 星期中文。 */
    const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

    /** ISO 时间戳 → 本地 HH:MM。 */
    function timeOf(iso) {
      const dt = new Date(iso);
      if (Number.isNaN(dt.getTime())) return '--:--';
      return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    }

    /** 小时数格式化。 */
    function fmtHours(value) {
      const n = Math.round((Number(value) || 0) * 100) / 100;
      if (Number.isInteger(n)) return `${n}h`;
      return `${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}h`;
    }

    /** 百分比。 */
    function pctText(value) {
      return `${Math.round((Number(value) || 0) * 10) / 10}%`;
    }

    /** 项目色（无项目时的兜底）。 */
    function projectColor(list, id) {
      const hit = (list || []).find((item) => item.id === id);
      return hit?.color || BRAND.jadeLight;
    }

    /* ================= 样式 ================= */

const CSS = `
/* Hallmark · shape: app screen · genre: modern-minimal · theme: Horizon (Pixso reference) · redesign: full
 * paper: #F4F7FE 淡紫灰 · card: #FFFFFF · ink: #1B2559 海军蓝 · muted: #A3AED0 · accent: #4318FF 靛蓝 · accent-2: #6AD2FF 浅青
 * nav: 左侧 rail，选中=靛蓝文字 + 图标 + 右缘 3px 指示条 · signature: 白卡台账（20px 圆角 + 极柔阴影）· states: full, empty, loading, error
 * axes: horizon/indigo-cyan/white-card · posture: committed · contrast: pass · skins: horizon(默认), lido, dusk, jade · v5.0.0
 * build: v1.0.0 · A52 设置改回弹窗（面板唯一框，一行一项，分组，删除单列）· A51 曾改整页 · A50 描边照抄 · A49 Pixso 校准 · A47 design.md 契约
 * sweep: 4 FAIL (gate 40, 输入框描边 1.26:1) — 用户明确要求照抄参考稿的 #E0E5F2，属有意偏离，非漏改
 * 其余 0 REFLEX · 0 WARN (app scope, 20 route×skin) · copy: verbatim · 可读性由「字段上方标签 + 占位符」承担
 * 与参考的偏差：参考用紫蓝渐变做「Upgrade to PRO」卡与柱图，这里一律用实色靛蓝（Hallmark 2a 禁紫蓝渐变） */
/* Hallmark · pre-emit critique: P4 H5 E4 S4 R4 V4 · weakest: P (这是模板化的后台语言) — 用「今日待办」做唯一的大数字、把工时缺口放进侧栏，让首屏仍回答「今天做什么」 */

/* ── 皮肤：颜色只在这些块里出现 ─────────────────────────────── */
.aw-page[data-skin="horizon"]{
  --paper:oklch(96.5% 0.012 265); --paper-2:oklch(100% 0 0); --paper-3:oklch(93.5% 0.018 265);
  --ink:oklch(28% 0.075 275); --ink-2:oklch(42% 0.06 275); --muted:oklch(52% 0.05 275);
  --rule:#e9edf7; --rule:oklch(94% 0.012 265);
  --rule-2:#dfe5f5; --rule-2:oklch(90% 0.016 265);
  --field-line:#E0E5F2;   /* 按参考稿 1:1 照做：Secondary/Grey/500 */
  --accent:oklch(46% 0.29 274); --accent-hi:oklch(40% 0.29 274); --on-accent:oklch(100% 0 0);
  --accent-soft:oklch(92% 0.045 274); --accent-2:oklch(80% 0.10 230);
  --focus:oklch(46% 0.29 274);
  --danger:oklch(58% 0.20 25); --warn:oklch(70% 0.16 78); --ok:oklch(62% 0.15 165);
  --glass:oklch(100% 0 0 / 0.98); --glass-blur:8px;
  --glass-hi:0 0 0 1px oklch(100% 0 0 / 0.6) inset;
  --lit:oklch(100% 0 0 / 0.9);
  --shadow:0 18px 40px -18px oklch(45% 0.08 265 / 0.18), 0 2px 8px -4px oklch(45% 0.08 265 / 0.10);
  --shadow-soft:0 12px 28px -18px oklch(45% 0.08 265 / 0.16);
  --scrim:oklch(28% 0.075 275 / 0.35);
}
.aw-page[data-skin="lido"]{
  --paper:oklch(96% 0.012 75); --paper-2:oklch(98.5% 0.006 75); --paper-3:oklch(93% 0.012 75);
  --ink:oklch(24% 0.035 240); --ink-2:oklch(40% 0.026 235); --muted:oklch(50% 0.02 235);
  --rule:oklch(88% 0.01 75); --rule-2:oklch(79% 0.012 75); --field-line:oklch(58% 0.02 235);
  --accent:oklch(46% 0.098 230); --accent-hi:oklch(38% 0.098 230); --on-accent:oklch(97% 0.008 75);
  --accent-soft:oklch(91% 0.032 220); --accent-2:oklch(42% 0.095 220);
  --focus:oklch(46% 0.098 230);
  --danger:oklch(48% 0.18 27); --warn:oklch(48% 0.11 60); --ok:oklch(44% 0.10 165);
  --glass:oklch(98.5% 0.006 75 / 0.94); --glass-blur:10px;
  --glass-hi:inset 0 1px 0 oklch(100% 0 0 / 0.8), inset 0 0 0 1px oklch(24% 0.03 240 / 0.05);
  --lit:oklch(100% 0 0 / 0.85);
  --shadow:0 1px 2px oklch(24% 0.035 240 / 0.05), 0 18px 44px -22px oklch(24% 0.035 240 / 0.22);
  --shadow-soft:0 1px 2px oklch(24% 0.035 240 / 0.04), 0 8px 20px -12px oklch(24% 0.035 240 / 0.16);
  --scrim:oklch(24% 0.035 240 / 0.4);
}
.aw-page[data-skin="dusk"]{
  --paper:oklch(17.5% 0.014 268); --paper-2:oklch(21% 0.016 268); --paper-3:oklch(25% 0.017 268);
  --ink:oklch(96% 0.006 75); --ink-2:oklch(85% 0.010 262); --muted:oklch(70% 0.016 262);
  --rule:#2b2f3c; --rule:oklch(30% 0.016 266);
  --rule-2:#383d4d; --rule-2:oklch(38% 0.018 266);
  --field-line:#6b7183; --field-line:oklch(52% 0.020 266);
  --accent:oklch(77% 0.10 274); --accent-hi:oklch(84% 0.085 274); --on-accent:oklch(19% 0.035 274);
  --accent-soft:oklch(28% 0.045 274); --accent-2:oklch(83% 0.095 62);
  --focus:oklch(84% 0.085 274);
  --danger:oklch(72% 0.15 25); --warn:oklch(83% 0.095 62); --ok:oklch(80% 0.09 160);
  --glass:rgba(30,32,42,.80); --glass:oklch(22% 0.018 268 / 0.58); --glass-blur:18px;
  --glass-hi:inset 0 1px 0 rgba(255,255,255,.10), inset 0 0 0 1px rgba(255,255,255,.06);
  --lit:rgba(255,255,255,.14);
  --shadow:0 1px 0 rgba(255,255,255,.06) inset, 0 40px 80px -32px rgba(6,8,14,.7);
  --shadow-soft:var(--shadow);
  --scrim:rgba(10,12,20,.66);
}
.aw-page[data-skin="jade"]{
  --paper:oklch(99% 0.003 160); --paper-2:oklch(96.5% 0.005 165); --paper-3:oklch(93% 0.008 165);
  --ink:oklch(22% 0.015 200); --ink-2:oklch(38% 0.014 200); --muted:oklch(50% 0.012 200);
  --rule:#e6eae8; --rule:oklch(88% 0.006 165);
  --rule-2:#c3ccc9; --rule-2:oklch(78% 0.008 165);
  --field-line:#8a938f; --field-line:oklch(55% 0.012 165);
  --accent:oklch(48% 0.082 175); --accent-hi:oklch(40% 0.082 175); --on-accent:oklch(99% 0.004 175);
  --accent-soft:oklch(94% 0.022 175); --accent-2:oklch(52% 0.11 80);
  --focus:oklch(44% 0.09 175);
  --danger:oklch(50% 0.19 27); --warn:oklch(52% 0.11 75); --ok:oklch(46% 0.10 160);
  --glass:rgba(255,255,255,.94); --glass:oklch(99.5% 0.003 160 / 0.86); --glass-blur:14px;
  --glass-hi:inset 0 1px 0 rgba(255,255,255,.9), inset 0 0 0 1px rgba(20,30,40,.08);
  --lit:rgba(255,255,255,.9);
  --shadow:0 1px 0 rgba(255,255,255,.8) inset, 0 18px 44px -22px rgba(20,40,50,.24);
  --shadow-soft:0 8px 20px -12px oklch(30% 0.02 200 / 0.14);
  --scrim:rgba(30,40,50,.42);
}

/* ── 共用尺度 ───────────────────────────────────────────────── */
.aw-page{
  --fs-caption:12px; --fs-meta:13px; --fs-body:14px; --fs-title:15px; --fs-head:26px; --fs-figure:24px; --fs-display:32px;
  --lh-tight:1.35; --lh-body:1.6;
  --r-ctl:999px; --r-card:20px; --r-panel:20px; --r-inner:12px; --r-input:16px; --r-check:2px; --ctl-h:50px;
  height:100%;overflow:hidden;display:flex;
  background:var(--paper);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",ui-sans-serif,system-ui,sans-serif;
  font-size:var(--fs-body);line-height:var(--lh-body);font-variant-numeric:tabular-nums;
  -webkit-font-smoothing:antialiased;
}
.aw-page,.aw-page *{box-sizing:border-box}
.aw-page ::selection{background:var(--accent);color:var(--on-accent)}

/* ── 外壳：左 rail + 右内容 ─────────────────────────────────── */
.aw-shell{display:flex;flex:1 1 auto;min-width:0;min-height:0}
.aw-rail{flex:0 0 232px;display:flex;flex-direction:column;gap:6px;padding:26px 18px 22px;min-height:0}
.aw-brand{display:flex;align-items:center;gap:10px;padding:0 10px 20px}
.aw-brand-name{font-size:17px;font-weight:600;letter-spacing:-.01em;line-height:1.2}
.aw-brand-sub{font-size:11.5px;color:var(--muted);margin-top:2px}
.aw-tabs{display:flex;flex-direction:column;gap:4px;position:relative}
.aw-tab{appearance:none;border:0;cursor:pointer;background:transparent;font:inherit;font-size:var(--fs-body);font-weight:500;
  color:var(--muted);display:flex;align-items:center;gap:12px;height:46px;padding:0 14px;border-radius:14px;
  position:relative;white-space:nowrap;transition:color 120ms linear,background 120ms linear;text-align:left}
.aw-tab svg{flex:0 0 auto;opacity:.9}
.aw-tab:hover{color:var(--ink-2);background:color-mix(in srgb,var(--ink) 4%,transparent)}
.aw-tab.is-on{color:var(--accent);font-weight:600;background:transparent}
.aw-tab.is-on::after{content:'';position:absolute;right:-18px;top:12px;bottom:12px;width:3px;border-radius:3px 0 0 3px;background:var(--accent)}
.aw-tab:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.aw-promo{margin-top:auto;background:var(--accent);color:var(--on-accent);border-radius:var(--r-card);padding:18px 16px;
  display:flex;flex-direction:column;gap:10px}
.aw-promo-label{font-size:11.5px;font-weight:500;opacity:.85}
.aw-promo-value{font-size:22px;font-weight:600;letter-spacing:-.02em;line-height:1.15}
.aw-promo-bar{height:6px;border-radius:999px;background:color-mix(in srgb,var(--on-accent) 28%,transparent);overflow:hidden}
.aw-promo-bar>i{display:block;height:100%;border-radius:999px;background:var(--on-accent)}
.aw-promo-note{font-size:11.5px;opacity:.9;display:flex;justify-content:space-between;gap:8px}

.aw-main{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column}
.aw-inner{flex:1 1 auto;min-height:0;overflow-y:auto;width:100%;max-width:1180px;padding:26px 28px 72px;display:flex;flex-direction:column;gap:20px}
@media (max-width:1080px){
  .aw-shell{flex-direction:column}
  .aw-rail{flex:0 0 auto;flex-direction:row;align-items:center;gap:8px;padding:12px 16px;overflow-x:auto;
    border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:8;background:var(--paper);width:100%}
  .aw-brand{padding:0 12px 0 0}
  .aw-brand-sub{display:none}
  .aw-tabs{flex-direction:row;gap:4px}
  .aw-tab{height:36px;padding:0 14px;border-radius:999px}
  .aw-tab.is-on{background:var(--accent);color:var(--on-accent)}
  .aw-tab.is-on::after{display:none}
  .aw-promo{display:none}
  .aw-inner{padding:18px 16px 56px;gap:16px}
}

/* ── 页头：面包屑 + 标题 + 动作 ────────────────────────────── */
.aw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:0}
.aw-crumb{font-size:11.5px;color:var(--muted);margin-bottom:6px}
.aw-title{display:flex;align-items:center;gap:10px;font-size:var(--fs-head);font-weight:600;letter-spacing:-.02em;line-height:1.15;color:var(--ink)}
.aw-title small{font-size:12.5px;font-weight:400;color:var(--muted);letter-spacing:0;padding-left:10px;border-left:1px solid var(--rule-2)}
.aw-ledger{font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}
.aw-ledger b{color:var(--ink);font-weight:600}
.aw-ledger .is-quiet{color:var(--accent)}
.aw-ledger .is-danger{color:var(--danger);font-weight:500}

/* ── 首屏 ───────────────────────────────────────────────────── */
.aw-dayhead{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px 24px;padding:2px 0}
@media (max-width:700px){.aw-dayhead{grid-template-columns:minmax(0,1fr)}}
.aw-dayhead-date{font-size:var(--fs-display);font-weight:600;letter-spacing:-.025em;line-height:1.1;color:var(--ink);margin:0}
.aw-dayhead-week{font-size:var(--fs-meta);color:var(--muted);margin-top:6px;display:flex;gap:14px;flex-wrap:wrap}
.aw-dayhead-fig{display:flex;align-items:baseline;gap:12px;justify-self:end}
@media (max-width:700px){.aw-dayhead-fig{justify-self:start}}
.aw-dayhead-num{font-size:var(--fs-display);font-weight:600;letter-spacing:-.03em;line-height:1;color:var(--accent)}
.aw-dayhead-label{font-size:var(--fs-meta);color:var(--muted)}
.aw-caption{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;font-size:var(--fs-meta);color:var(--muted)}
.aw-caption .num{color:var(--ink);font-weight:600}
.aw-caption .is-danger{color:var(--danger);font-weight:600}
.aw-caption .is-warn{color:var(--warn);font-weight:600}
.aw-daybar{grid-column:1/-1;height:8px;border-radius:999px;background:var(--paper-3);overflow:hidden;margin-top:10px}
.aw-daybar>i{display:block;height:100%;border-radius:999px;background:var(--accent);transition:width 220ms linear}

/* ── 卡片：白底 + 20px 圆角 + 极柔阴影 ─────────────────────── */
.aw-board,.aw-card{background:var(--paper-2);border:0;border-radius:var(--r-card);box-shadow:var(--shadow-soft);position:relative}
.aw-board{box-shadow:var(--shadow);overflow:hidden}
.aw-card{padding:22px 24px}
.aw-sec{border-top:1px solid var(--rule);padding:18px 24px 20px}
.aw-sec.is-first{border-top:0;padding-top:22px}
.aw-sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.aw-sec-title{font-size:var(--fs-title);font-weight:600;color:var(--ink);display:inline-flex;align-items:baseline;gap:8px;min-width:0;letter-spacing:-.01em}
.aw-sec-title b{color:var(--ink);font-size:var(--fs-meta);font-weight:600;background:var(--paper-3);border-radius:999px;padding:1px 9px}
.aw-sec-title .aw-note{font-weight:400}
.aw-sec-extra{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:var(--fs-caption);color:var(--muted)}
.aw-sec-body{display:flex;flex-direction:column;gap:10px}
.aw-card-title{font-size:var(--fs-title);font-weight:600;color:var(--ink);display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap;letter-spacing:-.01em}
.aw-card-title b{color:var(--ink);font-size:var(--fs-meta);font-weight:600;background:var(--paper-3);border-radius:999px;padding:1px 9px}
.aw-grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.aw-composer .aw-field{max-width:520px}

/* ── 台账行 ─────────────────────────────────────────────────── */
.aw-list{display:flex;flex-direction:column}
.aw-list>.aw-row+.aw-row{border-top:1px solid var(--rule)}
.aw-row{display:flex;align-items:center;gap:12px;padding:10px 10px;min-height:46px;border-radius:var(--r-inner);overflow:hidden;transition:background 120ms linear}
.aw-row:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}
.aw-row-title{font-weight:500;font-size:var(--fs-body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;line-height:var(--lh-tight);color:var(--ink)}
.aw-row-main{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:12px}
.aw-row-meta{display:flex;align-items:center;gap:12px;font-size:var(--fs-caption);color:var(--muted);flex:0 1 auto;min-width:0;white-space:nowrap}
.aw-row-main>.aw-row-meta{justify-content:flex-end}
.aw-row-acts{display:flex;align-items:center;gap:2px;flex-shrink:0}
.aw-row.is-done .aw-row-title{color:var(--muted)}
.aw-row .is-danger,.aw-row-meta .is-danger{color:var(--danger)}
.aw-row .is-warn,.aw-row-meta .is-warn{color:var(--warn)}
.aw-check{appearance:none;width:20px;height:20px;flex:0 0 auto;border-radius:var(--r-check);border:2px solid var(--rule-2);
  background:var(--paper-2);cursor:pointer;position:relative;
  transition:background 120ms linear,border-color 120ms linear,box-shadow 120ms linear}
.aw-check:hover{border-color:var(--accent)}
.aw-check:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.aw-check:checked{background:var(--accent);border-color:var(--accent)}
.aw-check:checked::after{content:'';position:absolute;left:5.5px;top:1.5px;width:5px;height:10px;
  border:solid var(--on-accent);border-width:0 2.2px 2.2px 0;transform:rotate(42deg)}
.aw-check-done{width:20px;height:20px;flex:0 0 auto;border-radius:var(--r-check);background:var(--accent);color:var(--on-accent);
  display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;line-height:1}
.aw-note{color:var(--muted);font-size:var(--fs-caption)}
.aw-dot{width:7px;height:7px;border-radius:999px;flex:0 0 auto;display:inline-block;background:var(--accent-2)}
.aw-spacer{flex:1 1 auto}
.aw-split-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.aw-empty{padding:36px 20px;text-align:center;color:var(--muted);font-size:var(--fs-meta)}

/* ── 统计卡：白底小卡，数字大 ───────────────────────────────── */
.aw-metrics{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(186px,1fr))}
.aw-metric{background:var(--paper-2);border-radius:var(--r-card);box-shadow:var(--shadow-soft);padding:16px 18px;
  display:flex;align-items:center;gap:12px;min-width:0}
.aw-metric-tile{flex:0 0 auto;width:48px;height:48px;border-radius:999px;background:var(--accent-soft);color:var(--accent);
  display:inline-flex;align-items:center;justify-content:center}
.aw-metric.is-danger .aw-metric-tile{background:color-mix(in srgb,var(--danger) 12%,var(--paper-2));color:var(--danger)}
.aw-metric-body{min-width:0}
.aw-metric-label{font-size:var(--fs-caption);color:var(--muted);font-weight:400;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.aw-metric-value{font-size:var(--fs-figure);font-weight:600;letter-spacing:-.025em;line-height:1.2;margin-top:2px;white-space:nowrap;color:var(--ink)}
.aw-metric-value small{font-size:var(--fs-caption);font-weight:500;color:var(--muted);margin-left:3px;letter-spacing:0}
.aw-metric.is-danger .aw-metric-value{color:var(--danger)}
.aw-metric.is-ok .aw-metric-value{color:var(--accent)}
@media (max-width:760px){.aw-metrics{gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.aw-metric{padding:14px 16px}.aw-metric-tile{display:none}}

/* ── 控件 ───────────────────────────────────────────────────── */
.aw-btn{appearance:none;cursor:pointer;font:inherit;font-size:var(--fs-meta);font-weight:600;height:var(--ctl-h);padding:0 18px;
  border-radius:999px;border:0;background:var(--paper-2);color:var(--ink-2);box-shadow:var(--shadow-soft);
  display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;
  transition:background 120ms linear,color 120ms linear,box-shadow 120ms linear}
.aw-btn:hover:not(:disabled){background:var(--paper-3);color:var(--ink)}
.aw-btn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.aw-btn:disabled{opacity:.45;cursor:not-allowed}
.aw-btn.is-primary{background:var(--accent);color:var(--on-accent)}
.aw-btn.is-primary:hover:not(:disabled){background:var(--accent-hi);color:var(--on-accent)}
.aw-btn.is-ghost{background:transparent;color:var(--ink-2);box-shadow:none}
.aw-btn.is-ghost:hover:not(:disabled){background:var(--paper-3);color:var(--ink)}
.aw-btn.is-danger{background:transparent;color:var(--danger);box-shadow:none}
.aw-btn.is-danger:hover:not(:disabled){background:color-mix(in srgb,var(--danger) 8%,transparent)}
.aw-btn.is-gold{background:transparent;color:var(--warn);box-shadow:none}
.aw-btn.is-on{background:var(--accent);color:var(--on-accent);box-shadow:none}
.aw-btn.is-small{height:32px;padding:0 14px;font-size:var(--fs-caption);font-weight:600}

.aw-input,.aw-select,.aw-textarea{font:inherit;font-size:var(--fs-body);letter-spacing:-.02em;height:var(--ctl-h);padding:0 24px;border-radius:var(--r-input);
  border:1px solid var(--field-line);background:var(--paper-2);color:var(--ink);min-width:0;
  transition:border-color 120ms linear,box-shadow 120ms linear}
.aw-select{appearance:none;padding-right:48px;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 25px) calc(50% - 2px),calc(100% - 20px) calc(50% - 2px);
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;color:var(--ink-2)}
.aw-input[type=date],.aw-input[type=number]{height:var(--ctl-h)}
.aw-input::placeholder,.aw-textarea::placeholder{color:var(--muted)}
.aw-input:hover,.aw-select:hover,.aw-textarea:hover{border-color:var(--accent-2)}
.aw-input:focus-visible,.aw-select:focus-visible,.aw-textarea:focus-visible{
  outline:2px solid var(--focus);outline-offset:0;border-color:var(--accent)}
.aw-textarea{width:100%;height:auto;padding:14px 24px;resize:vertical;line-height:1.65;border-radius:var(--r-input);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.aw-form{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.aw-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.aw-field>label{font-size:var(--fs-caption);font-weight:500;color:var(--muted)}
/* 新建待办：一项一行、名称在上、控件全宽 */
.aw-form-vertical{display:flex;flex-direction:column;gap:14px}
.aw-form-vertical .aw-field{width:100%}
.aw-form-vertical .aw-input,.aw-form-vertical .aw-select{width:100%}
.aw-form-vertical .aw-weekdays{display:flex;gap:6px;flex-wrap:wrap}
.aw-form-vertical .aw-submit-wrap{width:100%}
.aw-form-vertical .aw-submit-wrap .aw-btn{width:100%}
.aw-modal-confirm{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;order:-1;
  border-radius:var(--r-input);background:var(--paper-3);color:var(--ink-2);font-size:var(--fs-meta)}

.aw-icon-btn{appearance:none;cursor:pointer;width:30px;height:30px;padding:0;border-radius:999px;
  border:0;background:transparent;color:var(--muted);
  display:inline-flex;align-items:center;justify-content:center;transition:background 120ms linear,color 120ms linear}
.aw-icon-btn:hover:not(:disabled){background:var(--paper-3);color:var(--ink)}
.aw-icon-btn:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.aw-icon-btn.is-danger:hover:not(:disabled){color:var(--danger)}
.aw-icon-btn:disabled{opacity:.4;cursor:not-allowed}

/* ── 表 ─────────────────────────────────────────────────────── */
.aw-table{width:100%;border-collapse:collapse;font-size:var(--fs-meta)}
.aw-table th{text-align:left;font-size:var(--fs-caption);font-weight:500;color:var(--muted);padding:0 12px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}
.aw-table td{padding:12px;border-bottom:1px solid var(--rule);vertical-align:middle;color:var(--ink-2)}
.aw-table tbody tr:last-child td{border-bottom:0}
.aw-table tbody tr:hover td{background:color-mix(in srgb,var(--accent) 4%,transparent)}
.aw-table .is-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--ink);font-weight:500}
.aw-table .is-link{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-table a{color:var(--accent);text-decoration:none;font-weight:500}
.aw-table a:hover{text-decoration:underline}
.aw-scroll{max-height:380px;overflow-y:auto}

.aw-bar{height:8px;border-radius:999px;background:var(--paper-3);overflow:hidden}
.aw-bar>i{display:block;height:100%;border-radius:999px;background:var(--accent);transition:width 220ms linear}
.aw-bar.is-gold>i{background:var(--warn)}
.aw-bar.is-danger>i{background:var(--danger)}

.aw-prio{font-size:var(--fs-caption);font-weight:600;color:var(--muted);display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.aw-prio-label{font-weight:400;opacity:.9}
.aw-prio.is-p0{color:var(--danger)}
.aw-prio.is-p1{color:var(--warn)}
.aw-prio.is-p2,.aw-prio.is-p3{color:var(--muted)}
.aw-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 12px;border-radius:999px;font-size:var(--fs-caption);font-weight:500;
  background:var(--paper-3);border:0;color:var(--ink-2);white-space:nowrap}
.aw-chip strong{color:var(--ink);font-weight:600}
.aw-chip.is-brand{background:var(--accent);color:var(--on-accent)}
.aw-chip.is-brand strong{color:var(--on-accent)}
/* 徽标文字用「语义色向正文色靠」的深版，保证 4.5:1（浅色底上的纯绿/纯金不够深） */
.aw-chip.is-warn{background:color-mix(in srgb,var(--warn) 16%,var(--paper-2));color:color-mix(in oklab,var(--warn) 50%,var(--ink))}
.aw-chip.is-danger{background:color-mix(in srgb,var(--danger) 12%,var(--paper-2));color:color-mix(in oklab,var(--danger) 78%,var(--ink))}
.aw-chip.is-ok{background:color-mix(in srgb,var(--ok) 14%,var(--paper-2));color:color-mix(in oklab,var(--ok) 62%,var(--ink))}
.aw-chip.is-gold{background:color-mix(in srgb,var(--warn) 14%,var(--paper-2));color:color-mix(in oklab,var(--warn) 58%,var(--ink))}
.aw-chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

.aw-fold{margin-top:8px;border-top:1px solid var(--rule);padding-top:10px}
.aw-fold-head{appearance:none;border:0;background:transparent;font:inherit;font-size:var(--fs-meta);font-weight:500;color:var(--muted);
  cursor:pointer;display:flex;align-items:center;justify-content:space-between;width:100%;min-height:var(--ctl-h);padding:0;gap:8px}
.aw-fold-head:hover{color:var(--ink)}
.aw-fold-head:focus-visible{outline:2px solid var(--focus);outline-offset:2px}

.aw-heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,1fr);gap:3px}
.aw-heat-cell{width:11px;height:11px;border-radius:4px;background:var(--paper-3)}
.aw-heat-cell.l1{background:color-mix(in oklab,var(--accent) 16%,var(--paper-3))}
.aw-heat-cell.l2{background:color-mix(in oklab,var(--accent) 36%,var(--paper-3))}
.aw-heat-cell.l3{background:color-mix(in oklab,var(--accent) 62%,var(--paper-3))}
.aw-heat-cell.l4{background:var(--accent)}

.aw-flash{position:sticky;top:0;z-index:20;margin:0;padding:12px 18px;border-radius:999px;font-size:var(--fs-meta);font-weight:500;
  background:var(--paper-2);border:1px solid var(--rule-2);color:var(--ink);box-shadow:var(--shadow-soft);animation:xwIn 220ms linear}
@keyframes xwIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.aw-flash.is-error{border-color:var(--danger);color:var(--danger)}
.aw-flash.is-warn{border-color:var(--warn);color:var(--warn)}
.aw-flash.is-roll{border-color:var(--accent)}
@media (prefers-reduced-motion: reduce){.aw-flash{animation:none}.aw-bar>i,.aw-daybar>i{transition:none}}

.aw-backdrop{position:fixed;inset:0;background:var(--scrim);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:60;
  display:flex;align-items:flex-start;justify-content:center;padding:64px 18px 24px;overflow-y:auto}
.aw-modal{background:var(--paper-2);border-radius:24px;padding:28px;width:100%;max-width:660px;
  box-shadow:0 32px 64px -24px oklch(30% 0.06 265 / 0.4);display:flex;flex-direction:column;gap:18px}
.aw-modal h3{margin:0;font-size:20px;font-weight:600;letter-spacing:-.02em;color:var(--ink)}
.aw-modal-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.aw-modal-close{flex:0 0 auto;font-size:22px;line-height:1}
@media (max-width:520px){.aw-modal{padding:20px 16px;border-radius:18px}.aw-form-vertical{gap:12px}}

/* ── 设置弹窗：面板本身就是唯一的框，里面不再套卡片 ─────────── */
/* 一行一项：左名称、右控件；分组有标题，组间大留白、组内小留白。 */
.aw-modal.is-settings{max-width:820px;max-height:min(84vh,860px);overflow:hidden}
.aw-set-body{overflow-y:auto;min-height:0;padding-right:6px}
.aw-set-group{margin-top:40px}
.aw-set-group:first-of-type{margin-top:4px}
.aw-set-group-title{margin:0 0 2px;font-size:13px;font-weight:600;color:var(--ink);letter-spacing:0}
.aw-set-group.is-danger .aw-set-group-title{color:var(--danger)}
.aw-set-rows{border-top:1px solid var(--rule-2);margin-top:6px}
.aw-set-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,360px);gap:24px;align-items:center;
  padding:10px 0;border-bottom:1px solid var(--rule-2)}
.aw-set-row.is-wide{grid-template-columns:1fr;align-items:start;gap:6px}
.aw-set-row.is-stacked{grid-template-columns:1fr;align-items:start;gap:10px}
.aw-set-row.is-stacked>.aw-set-ctl{max-width:none;justify-content:flex-start;flex-direction:column;align-items:stretch;gap:8px}
.aw-set-label{display:flex;flex-direction:column;gap:3px;min-width:0}
.aw-set-label>span:first-child{font-size:var(--fs-body);color:var(--ink)}
.aw-set-hint{font-size:12px;color:var(--muted);line-height:1.4}
.aw-set-ctl{display:flex;justify-content:flex-end;align-items:center;gap:8px;min-width:0;max-width:360px;justify-self:end;width:100%}
.aw-set-ctl>.aw-input,.aw-set-ctl>.aw-select{width:100%}
.aw-set-ctl>.aw-btn{flex:0 0 auto}
.aw-set-ctl>.aw-input[type=date]{width:auto}
.aw-set-note{font-size:12px;color:var(--muted);line-height:1.6}
.aw-set-note+.aw-set-note{margin-top:4px}
.aw-set-figs{display:flex;gap:18px;flex-wrap:wrap;justify-content:flex-end}
.aw-set-fig{display:flex;align-items:baseline;gap:5px}
.aw-set-fig b{font-size:18px;font-weight:600;letter-spacing:-.02em;color:var(--ink)}
.aw-set-fig span{font-size:12px;color:var(--muted)}
.aw-set-foot{display:flex;align-items:center;gap:10px;border-top:1px solid var(--rule-2);margin-top:44px;padding-top:18px;flex-wrap:wrap}
.aw-set-meta{flex:1 1 240px;font-size:11.5px;color:var(--muted);line-height:1.5}
@media (max-width:760px){
  .aw-set-row{grid-template-columns:1fr;gap:8px;align-items:start}
  .aw-set-ctl{justify-self:start;max-width:none;justify-content:flex-start}
  .aw-set-figs{justify-content:flex-start}
}

.aw-ticket-form{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px;align-items:end}
.aw-ticket-form .aw-field>label{white-space:nowrap}
.aw-ticket-form .aw-btn{height:var(--ctl-h)}
@media (max-width:860px){.aw-ticket-form{grid-template-columns:repeat(4,minmax(0,1fr))}.aw-ticket-form .aw-field{grid-column:span 4!important}}

.aw-rep{display:flex;align-items:baseline;gap:12px;padding:14px 12px;border-radius:var(--r-inner);cursor:pointer;border:0;background:transparent;
  border-top:1px solid var(--rule);width:100%;text-align:left;font:inherit;color:inherit}
.aw-rep:first-child{border-top:0}
.aw-rep:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}
.aw-rep.is-on{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.aw-rep:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.aw-rep-main{flex:1 1 auto;min-width:0}
.aw-rep-title{font-weight:500;font-size:var(--fs-body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:var(--lh-tight);color:var(--ink)}

.aw-md{font-size:var(--fs-body);line-height:1.75;color:var(--ink-2)}
.aw-md h1{font-size:18px;font-weight:600;margin:4px 0 12px;letter-spacing:-.02em;color:var(--ink)}
.aw-md h2{font-size:var(--fs-body);font-weight:600;margin:22px 0 8px;color:var(--ink)}
.aw-md h3{font-size:var(--fs-meta);font-weight:600;margin:16px 0 6px;color:var(--ink-2)}
.aw-md ul{margin:4px 0;padding-left:20px}
.aw-md li{margin:2px 0}
.aw-md blockquote{margin:4px 0 4px 2px;padding-left:12px;border-left:3px solid var(--paper-3);color:var(--muted);font-size:var(--fs-meta)}
.aw-md code{background:var(--paper-3);padding:2px 7px;border-radius:6px;font-size:12px;color:var(--accent)}
.aw-md hr{border:0;border-top:1px solid var(--rule);margin:18px 0}
.aw-split{display:grid;grid-template-columns:1fr;gap:18px}
@media(min-width:1080px){.aw-split.has-preview{grid-template-columns:minmax(300px,360px) minmax(0,1fr)}}

.aw-trend{display:flex;align-items:flex-end;gap:8px;height:110px;padding-top:6px;border-bottom:1px solid var(--rule)}
.aw-trend-col{flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:8px;height:100%;justify-content:flex-end}
.aw-trend-bar{width:100%;max-width:26px;border-radius:999px;background:var(--paper-3);min-height:4px}
.aw-trend-col.is-current .aw-trend-bar{background:var(--accent)}
`;

    /* ================= 状态仓库 ================= */

    function createStore() {
      let snapshot = {
        ready: false,
        loading: false,
        error: null,
        busy: null,
        flash: null,
        boot: null,
        viewName: 'today',
        viewParams: {},
        view: null,
        today: localToday(),
      };
      const listeners = new Set();
      const emit = () => {
        for (const fn of Array.from(listeners)) fn();
      };
      const set = (patch) => {
        snapshot = { ...snapshot, ...patch };
        emit();
      };
      let flashTimer = null;
      // 视图请求的序号：只有最新那次的结果能落地，避免慢响应覆盖新数据
      let viewSeq = 0;

      /**
       * 取「此刻的今天」，并顺手把仓库里的 today 对齐。
       *
       * 以前是直接用 snapshot.today —— 那个值只在 store 创建时算过一次。
       * 面板挂着过夜（或 DSH 页面一直没关）之后，它还是昨天的日期，
       * 于是所有请求都带着昨天去问；而状态早被推到今天，今日待办自然查出来是空的。
       */
      function syncToday() {
        const now = localToday();
        if (now !== snapshot.today) set({ today: now });
        return now;
      }

      /** 顶部提示条。 */
      function flash(kind, text, ttl = 3200) {
        const seq = Date.now() + Math.random();
        set({ flash: { kind, text, seq } });
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          if (snapshot.flash && snapshot.flash.seq === seq) set({ flash: null });
        }, ttl);
      }

      async function request(method, url, body) {
        const response = await fetch(url, {
          method,
          headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || data.ok !== true) {
          throw new Error((data && data.error) || `请求失败（HTTP ${response.status}）`);
        }
        return data;
      }

      /** 把顺延小结变成一条提示条。 */
      function announceRollover(rollover) {
        if (!rollover || !rollover.days) return false;
        const bits = [`自动顺延 ${rollover.days} 天`];
        if (rollover.moved > 0) bits.push(`${rollover.moved} 项未完成被推进`);
        if (rollover.created > 0) bits.push(`开出 ${rollover.created} 条重复任务`);
        if (rollover.missed > 0) bits.push(`${rollover.missed} 项到期作废`);
        const detail = (rollover.entries || [])
          .map((item) => `${item.title} ${String(item.from).slice(5)}→${String(item.to).slice(5)}`)
          .join(' · ');
        flash('roll', `🔄 ${bits.join('，')}${detail ? `｜${detail}` : ''}`, 5600);
        return true;
      }

      /** 拉取启动快照（右上角的口径摘要）。 */
      async function refreshBoot() {
        try {
          const data = await request('GET', `${ROUTE}?view=bootstrap&today=${syncToday()}`);
          set({ boot: data.view });
        } catch (error) {
          /* 启动快照失败不阻塞主视图 */
        }
      }

      /** 打开一个视图（切换分页或改筛选条件时调用）。 */
      async function open(viewName, params = {}) {
        const seq = ++viewSeq;
        const query = new URLSearchParams({ view: viewName, today: syncToday() });
        for (const [key, value] of Object.entries(params)) {
          if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
        }
        // 注意：这里**不**提前提交 viewName。view 与 viewName 必须同时落地，
        // 否则切换分页的那一帧会出现「新分页组件 + 上一个分页的数据」，直接崩。
        set({ loading: true, ready: true });
        try {
          const data = await request('GET', `${ROUTE}?${query.toString()}`);
          // 期间又发了更新的请求 —— 这次的结果已经过期，丢掉，否则会把新数据盖回旧的
          if (seq !== viewSeq) return;
          set({ view: data.view, viewName, viewParams: params, loading: false, error: null });
          announceRollover(data.rollover);
        } catch (error) {
          if (seq !== viewSeq) return;
          set({ loading: false, error: String((error && error.message) || error) });
        }
      }

      /** 重新载入当前视图。 */
      function reload() {
        return open(snapshot.viewName, snapshot.viewParams);
      }

      /** 发一个写操作；响应里带回刷新后的当前视图。 */
      async function send(action, payload) {
        const seq = ++viewSeq;
        set({ busy: action });
        try {
          const data = await request('POST', ROUTE, {
            action,
            today: syncToday(),
            view: snapshot.viewName,
            viewParams: snapshot.viewParams,
            ...(payload || {}),
          });
          // 只有最新一次请求能写 view：期间切了分页就让分页自己的请求说了算
          if (seq === viewSeq && data.view) set({ view: data.view });
          set({ busy: null });
          if (!data.result || data.result.ok !== true) {
            flash('error', `⚠️ ${(data.result && data.result.error) || '操作失败'}`);
            return { ok: false, error: data.result && data.result.error };
          }
          if (data.result.message) flash('info', data.result.message);
          announceRollover(data.rollover);
          refreshBoot();
          return data.result;
        } catch (error) {
          set({ busy: null });
          flash('error', `⚠️ ${String((error && error.message) || error)}`);
          return { ok: false, error: String((error && error.message) || error) };
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        open,
        reload,
        send,
        refreshBoot,
        flash,
        /** 允许页面切分页时重置提示条。 */
        clearFlash: () => set({ flash: null }),
      };
    }

    /** 订阅仓库快照的 hook。 */
    function useSnapshot(store) {
      const [snap, setSnap] = React.useState(store.getSnapshot());
      React.useEffect(() => store.subscribe(() => setSnap(store.getSnapshot())), [store]);
      return snap;
    }

    /* ================= 原子组件 ================= */

    function Card(props) {
      return h(
        'div',
        { className: `aw-card${props.className ? ` ${props.className}` : ''}`, style: props.style },
        props.title
          ? h(
              'div',
              { className: 'aw-card-title' },
              h('span', null, props.title),
              props.extra ? h('span', { className: 'aw-split-row' }, props.extra) : null,
            )
          : null,
        props.children,
      );
    }

    /** 一整块面板：内部各节用分割线区分，不再一节套一个边框。 */
    function Board(props) {
      return h('div', { className: 'aw-board', style: props.style }, props.children);
    }

    /**
     * 面板里的一节。
     * 节与节之间只靠一条细分割线（.aw-sec 的 border-top）隔开，不各自成框。
     */
    function Sec(props) {
      return h(
        'section',
        { className: `aw-sec${props.first ? ' is-first' : ''}` },
        props.title
          ? h(
              'div',
              { className: 'aw-sec-head' },
              h('span', { className: 'aw-sec-title' }, props.title),
              props.extra ? h('span', { className: 'aw-sec-extra' }, props.extra) : null,
            )
          : null,
        h('div', { className: 'aw-sec-body' }, props.children),
      );
    }

    function Chip(props) {
      return h(
        'span',
        {
          className: `aw-chip${props.tone ? ` is-${props.tone}` : ''}`,
          title: props.title,
          style: props.onClick ? { cursor: 'pointer' } : null,
          onClick: props.onClick,
        },
        props.children,
      );
    }

    /** 左栏导航图标（16px 线性图标）。 */
    const NAV_ICONS = {
      today: ['M3 7.5 8 3l5 4.5', 'M4.5 7v6.5h7V7', 'M6.5 13.5v-3.2h3v3.2'],
      projects: ['M2.8 4.6h4l1.2 1.6h5.2v6.2H2.8z'],
      hours: ['M8 2.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 8 2.8z', 'M8 5.2V8l2 1.3'],
      reports: ['M4 2.8h6l2.2 2.2v8.2H4z', 'M9.6 2.9v2.4h2.4', 'M6 8h4', 'M6 10.4h4'],
      stats: ['M3 12.8V8.2', 'M6.3 12.8V4.8', 'M9.6 12.8V7', 'M12.9 12.8v-6'],
    };

    function NavIcon(props) {
      const paths = NAV_ICONS[props.name] || NAV_ICONS.today;
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        paths.map((d, index) => h('path', { key: index, d })),
      );
    }

    /**
     * 纯图标按钮。图标本身没有文字，所以必须带 aria-label / title ——
     * 「不许有空按钮」那条测试是按 aria-label 兜底的。
     */
    function IconBtn(props) {
      const paths =
        props.icon === 'edit'
          ? [['a', 'M11.2 2.6l2.2 2.2L5.1 13.1H2.9V10.9z'], ['b', 'M9.9 3.9l2.2 2.2']]
          : [['a', 'M2.9 4.3h10.2'], ['b', 'M6.2 4.3V2.7h3.6v1.6'], ['c', 'M4.4 4.3l.6 9h6l.6-9']];
      return h(
        'button',
        {
          type: 'button',
          className: `aw-icon-btn${props.tone ? ` is-${props.tone}` : ''}`,
          title: props.title,
          'aria-label': props.title,
          disabled: props.disabled,
          onClick: props.onClick,
        },
        h(
          'svg',
          { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
          paths.map(([key, d]) => h('path', { key, d })),
        ),
      );
    }

    function Btn(props) {
      return h(
        'button',
        {
          type: 'button',
          className: `aw-btn${props.tone ? ` is-${props.tone}` : ''}${props.small ? ' is-small' : ''}${props.on ? ' is-on' : ''}`,
          disabled: props.disabled,
          title: props.title,
          onClick: props.onClick,
        },
        props.children,
      );
    }

    function Bar(props) {
      const ratio = Math.max(0, Math.min(1, Number(props.ratio) || 0));
      return h(
        'div',
        { className: `aw-bar${props.tone ? ` is-${props.tone}` : ''}`, style: props.style },
        h('i', { style: { width: `${(ratio * 100).toFixed(1)}%` } }),
      );
    }

    /** 统计卡里的小图标。 */
    const METRIC_ICONS = {
      done: ['M3.4 8.4 6.3 11.2 12.6 4.9'],
      alert: ['M8 3.4 13.2 12.6H2.8z', 'M8 6.9v2.6', 'M8 11.2v.1'],
      clock: ['M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3z', 'M8 5.6V8.2l1.9 1.2'],
      draft: ['M4.2 2.8h5.4l2.2 2.2v8.2H4.2z', 'M9.4 2.9v2.3h2.3'],
      backlog: ['M2.9 5.2h10.2', 'M4.4 5.2v7.3h7.2V5.2', 'M6.4 8.2h3.2'],
      chart: ['M2.8 13.2h10.4', 'M4.4 13.2V8.4', 'M8 13.2V4.6', 'M11.6 13.2v-3.4'],
    };

    /** 没显式给图标时，按标签猜一个，保证每张统计卡都有图标块。 */
    function iconForLabel(label) {
      const text = String(label || '');
      if (/率|缺口|差|节拍/.test(text)) return 'chart';
      if (/工时|小时/.test(text)) return 'clock';
      if (/逾期|超期/.test(text)) return 'alert';
      if (/草稿|报表/.test(text)) return 'draft';
      if (/积压|顺延/.test(text)) return 'backlog';
      return 'done';
    }

    function MetricIcon(props) {
      const paths = METRIC_ICONS[props.name] || METRIC_ICONS.done;
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        paths.map((d, index) => h('path', { key: index, d })),
      );
    }

    /** 统计卡：左侧一个圆底图标块，右侧标签 + 数字。 */
    function Metric(props) {
      return h(
        'div',
        { className: `aw-metric${props.tone ? ` is-${props.tone}` : ''}`, title: props.title },
        h('span', { className: 'aw-metric-tile' }, h(MetricIcon, { name: props.icon || iconForLabel(props.label) })),
        h(
          'div',
          { className: 'aw-metric-body' },
          h('div', { className: 'aw-metric-label' }, props.label),
          h(
            'div',
            { className: 'aw-metric-value' },
            props.value,
            props.unit ? h('small', null, props.unit) : null,
          ),
          props.hint ? h('div', { className: 'aw-note', style: { marginTop: 2 } }, props.hint) : null,
        ),
      );
    }

    function Prio(props) {
      const info = PRIORITY_INFO[props.value];
      return h(
        'span',
        {
          className: `aw-prio is-${(props.value || 'P2').toLowerCase()}`,
          title: info ? info.full : props.value,
        },
        props.value,
        props.withLabel && info ? h('span', { className: 'aw-prio-label' }, info.short) : null,
      );
    }

    function Field(props) {
      return h(
        'div',
        { className: 'aw-field', style: props.style },
        props.label ? h('label', null, props.label) : null,
        props.children,
      );
    }

    function Modal(props) {
      if (!props.open) return null;
      // closable 是可选开关：只有「新增待办」这类需要明确关闭入口的弹层才显示右上角 ×。
      // 不开时保留原结构（标题仍是 .aw-modal 的直接子节点），不影响其它编辑器弹窗。
      const head = props.closable
        ? h(
            'div',
            { className: 'aw-modal-head' },
            props.title ? h('h3', null, props.title) : null,
            h(
              'button',
              { type: 'button', className: 'aw-icon-btn aw-modal-close', title: '关闭', 'aria-label': '关闭', onClick: props.onClose },
              '×',
            ),
          )
        : props.title
          ? h('h3', null, props.title)
          : null;
      return h(
        'div',
        {
          className: 'aw-backdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h('div', { className: `aw-modal${props.className ? ` ${props.className}` : ''}` }, head, props.children),
      );
    }

    function Empty(props) {
      return h('div', { className: 'aw-empty' }, props.children);
    }

    /** 极简 Markdown 渲染（标题 / 列表 / 引用 / 粗体 / 行内代码 / 分隔线）。 */
    function Markdown(props) {
      const lines = String(props.text || '').split('\n');
      const out = [];
      let items = null;
      // 连续的普通正文行攒成一段，行间用 <br> 保留换行 ——
      // 周报是「一行一件事」的纯文本，按标准 Markdown 把单换行当空格会把格式吃掉。
      let para = [];
      const flushPara = () => {
        if (para.length === 0) return;
        const children = [];
        para.forEach((text, index) => {
          if (index > 0) children.push(h('br', { key: `br${index}` }));
          children.push(...inline(text, `p${index}`));
        });
        out.push(h('p', { key: `p${out.length}`, style: { margin: '4px 0' } }, children));
        para = [];
      };
      const flush = () => {
        flushPara();
        if (items) {
          out.push(h('ul', { key: `ul${out.length}` }, items));
          items = null;
        }
      };
      const inline = (text, key) => {
        const parts = [];
        const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
        let last = 0;
        let match;
        let i = 0;
        while ((match = regex.exec(text)) !== null) {
          if (match.index > last) parts.push(text.slice(last, match.index));
          const token = match[0];
          if (token.startsWith('**')) parts.push(h('strong', { key: `${key}i${i++}` }, token.slice(2, -2)));
          else parts.push(h('code', { key: `${key}i${i++}` }, token.slice(1, -1)));
          last = match.index + token.length;
        }
        if (last < text.length) parts.push(text.slice(last));
        return parts;
      };

      lines.forEach((raw, index) => {
        const line = raw.replace(/\s+$/, '');
        const key = `l${index}`;
        if (/^###\s+/.test(line)) {
          flush();
          out.push(h('h3', { key }, inline(line.replace(/^###\s+/, ''), key)));
        } else if (/^##\s+/.test(line)) {
          flush();
          out.push(h('h2', { key }, inline(line.replace(/^##\s+/, ''), key)));
        } else if (/^#\s+/.test(line)) {
          flush();
          out.push(h('h1', { key }, inline(line.replace(/^#\s+/, ''), key)));
        } else if (/^>\s?/.test(line)) {
          flush();
          out.push(h('blockquote', { key }, inline(line.replace(/^>\s?/, ''), key)));
        } else if (/^[-*]\s+/.test(line)) {
          flushPara(); // 段落不能和列表粘在一起
          if (!items) items = [];
          items.push(h('li', { key }, inline(line.replace(/^[-*]\s+/, ''), key)));
        } else if (/^---+$/.test(line)) {
          flush();
          out.push(h('hr', { key }));
        } else if (line === '') {
          flush();
        } else {
          para.push(line);
        }
      });
      flush();
      return h('div', { className: 'aw-md' }, out);
    }

    /* ================= 图标 ================= */

    function ShuIcon(props) {
      const active = props.active === true;
      const color = active ? 'currentColor' : 'currentColor';
      return h(
        'svg',
        { width: 26, height: 26, viewBox: '0 0 32 32', 'aria-hidden': true, fill: 'none' },
        h('path', {
          d: 'M16 4.5 26 10.3v11.4L16 27.5 6 21.7V10.3Z',
          fill: color,
          fillOpacity: active ? 0.2 : 0.12,
          stroke: color,
          strokeWidth: 1.9,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M16 4.5v6.9M16 11.4 6 10.3M16 11.4l10-1.1M16 11.4v9.3M16 20.7 6 21.7M16 20.7l10 1',
          stroke: color,
          strokeWidth: 1.2,
          strokeOpacity: 0.8,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M22 25.4c2.3 0 3.6-1.3 3.6-2.9 0-1.5-1.1-2.4-2.4-2.4',
          stroke: color,
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      );
    }

    /* ================= 今日（已合并原「待办」页） ================= */

    /**
     * 今日页 = 每天真正会用的那一屏，只有三节：
     *   1. 今日待办（积压折叠在它下面，不单独占节）
     *   2. 新增待办（含重复任务模板的管理）
     *   3. 本周完成（绿色打勾）
     * 工时相关的一切都不在这里 —— 那是「工时」页的事。
     */
    function TodayTab(props) {
      const api = props.api;
      const view = props.view;
      const busy = props.busy;
      const [showBacklog, setShowBacklog] = React.useState(false);
      const [showAllHistory, setShowAllHistory] = React.useState(false);
      const [editing, setEditing] = React.useState(null);
      // 新增待办改成弹层：入口在「今日待办」节头上
      const [adding, setAdding] = React.useState(false);
      // 关闭确认：脏数据标记由 TodoCreator 回填，只有这一个弹层用
      const [todoDirty, setTodoDirty] = React.useState(false);
      const [confirmTodoClose, setConfirmTodoClose] = React.useState(false);

      if (!view || !view.stats || !Array.isArray(view.todos)) return h(Empty, null, '加载中…');
      const projects = view.projects || [];
      const send = api.send;
      const banner = view.warnings || [];
      // 历史完成：宿主给最近一批，这里默认只露 HISTORY_PAGE 条
      const historyDone = Array.isArray(view.historyDone) ? view.historyDone : [];
      const historyTotal = Number(view.historyTotal ?? historyDone.length) || 0;
      const historyList = showAllHistory ? historyDone : historyDone.slice(0, HISTORY_PAGE);
      // 顶部一排统计卡（与参考稿的 5 张卡同构）
      const boot = props.boot;
      const statCards = [
        { label: '本周完成', value: String(view.stats.weekDoneCount), unit: '项', icon: 'done' },
        {
          label: '逾期',
          value: String(view.stats.overdueCount),
          unit: '项',
          icon: 'alert',
          tone: view.stats.overdueCount > 0 ? 'danger' : undefined,
        },
        boot
          ? {
              label: `已录工时 · ${boot.hours.label}`,
              value: fmtHours(boot.hours.loggedHours),
              unit: `/ ${fmtHours(boot.hours.requiredHours)}`,
              hint: `达成 ${pctText(boot.hours.achievement)}`,
              icon: 'clock',
            }
          : null,
        boot && boot.counts.draftReports > 0
          ? { label: '待归档草稿', value: String(boot.counts.draftReports), unit: '份', icon: 'draft' }
          : { label: '积压', value: String(view.stats.backlogCount), unit: '项', icon: 'backlog' },
      ].filter(Boolean);

      // × 与点遮罩走同一条关闭路径：脏表单先确认，干净的直接关
      const closeTodo = () => {
        if (todoDirty) {
          setConfirmTodoClose(true);
          return;
        }
        setAdding(false);
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },

        // ── 今天：先把「要做什么」说清楚，再谈别的 ──
        h(
          'section',
          { className: 'aw-dayhead' },
          h(
            'div',
            null,
            h('h2', { className: 'aw-dayhead-date' }, `${view.date} 周${view.weekday}`),
            h(
              'div',
              { className: 'aw-dayhead-week' },
              h('span', null, view.weekLabel),
              banner.filter((item) => !(item.level === 'danger' && /项已逾期/.test(item.text))).length > 0
                ? h(
                    'span',
                    { className: 'is-warn' },
                    banner
                      .filter((item) => !(item.level === 'danger' && /项已逾期/.test(item.text)))
                      .map((item) => item.text)
                      .join('；'),
                  )
                : null,
            ),
          ),
          h(
            'div',
            { className: 'aw-dayhead-fig' },
            h('span', { className: 'aw-dayhead-label' }, '今日待办'),
            h('span', { className: 'aw-dayhead-num' }, String(view.stats.plannedCount)),
          ),
          h('div', { className: 'aw-daybar', title: '今天的完成比例' }, h('i', { style: { width: `${Math.min(100, Number(view.stats.progress) || 0)}%` } })),
        ),

        // 一排统计卡：本周完成 / 逾期 / 本月已录 / 草稿或积压
        h(
          'div',
          { className: 'aw-metrics' },
          statCards.map((card) =>
            h(Metric, {
              key: card.label,
              label: card.label,
              value: card.value,
              unit: card.unit,
              hint: card.hint,
              tone: card.tone,
              icon: card.icon,
            }),
          ),
        ),

        h(
          Board,
          null,

          // ── 1. 今日待办 ──
          h(
            Sec,
            {
              first: true,
              title: h('span', null, '今日待办'),
              extra: h(Btn, { small: true, tone: 'primary', disabled: busy, onClick: () => { setTodoDirty(false); setConfirmTodoClose(false); setAdding(true); } }, '新增'),
            },
            view.todos.length === 0
              ? h(Empty, null, '今天没有待办 —— 要么清空了，要么还没建。')
              : h(
                  'div',
                  { className: 'aw-list' },
                  view.todos.map((todo) =>
                    h(TodoRow, {
                      key: todo.id,
                      todo,
                      busy,
                      onComplete: () => send('todo_complete', { id: todo.id }),
                      onUndo: () => send('todo_undo', { id: todo.id }),
                      onReschedule: (payload) => send('todo_reschedule', { id: todo.id, ...payload }),
                      onDrop: () => send('todo_drop', { id: todo.id, reason: '不做' }),
                      onDelete: () => send('todo_delete', { id: todo.id }),
                      onProgress: (progress) => send('todo_update', { id: todo.id, progress }),
                      onEdit: () => setEditing(todo),
                    }),
                  ),
                ),
            // 积压折叠在这一节里 —— 它只是「今天没排上」的另一种状态，不值得单独占一节
            view.backlog.length > 0
              ? h(
                  'div',
                  { className: 'aw-fold' },
                  h(
                    'button',
                    { type: 'button', className: 'aw-fold-head', onClick: () => setShowBacklog(!showBacklog) },
                    h('span', null, `积压 ${view.backlog.length} 项`),
                    h('span', null, showBacklog ? '收起' : '展开'),
                  ),
                  showBacklog
                    ? h(
                        'div',
                        { className: 'aw-list aw-scroll', style: { marginTop: 8 } },
                        view.backlog.map((todo) =>
                          h(TodoRow, {
                            key: todo.id,
                            todo,
                            busy,
                            onComplete: () => send('todo_complete', { id: todo.id }),
                            onReschedule: (payload) => send('todo_reschedule', { id: todo.id, ...payload }),
                            onDrop: () => send('todo_drop', { id: todo.id, reason: '不做' }),
                            onDelete: () => send('todo_delete', { id: todo.id }),
                            onProgress: (progress) => send('todo_update', { id: todo.id, progress }),
                            onEdit: () => setEditing(todo),
                          }),
                        ),
                      )
                    : null,
                )
              : null,
          ),

          // ── 2. 本周完成 ──
          h(
            Sec,
            {
              title: h('span', null, '本周完成 ', h('b', null, String(view.weekDone.length))),
              extra: h(
                'span',
                { className: 'aw-note' },
                `${view.week.from} ~ ${view.week.to}${view.stats.doneCount > 0 ? ` · 今天 ${view.stats.doneCount} 项` : ''}`,
              ),
            },
            view.weekDone.length === 0
              ? h('div', { className: 'aw-note' }, '本周还没有完成的事。')
              : h(
                  'div',
                  { className: 'aw-list' },
                  view.weekDone.map((todo) =>
                    h(
                      'div',
                      { className: 'aw-row is-done', key: todo.id },
                      h('span', { className: 'aw-check-done', title: `已完成 · ${todo.completedDate}`, 'aria-label': '已完成' }, '✓'),
                      h(
                        'div',
                        { className: 'aw-row-main' },
                        h('div', { className: 'aw-row-title' }, todo.title),
                        h(
                          'div',
                          { className: 'aw-row-meta' },
                          h('span', null, String(todo.completedDate).slice(5)),
                          todo.projectName
                            ? h(
                                'span',
                                null,
                                h('span', { className: 'aw-dot', style: { background: todo.projectColor || BRAND.jadeLight, marginRight: 4 } }),
                                `${todo.projectEmoji || '📁'}${todo.projectName}`,
                              )
                            : null,
                          todo.carried ? h('span', null, `顺延 ${todo.rolloverCount} 天后完成`) : null,
                        ),
                      ),
                      todo.note ? h('span', { className: 'aw-note', title: todo.note }, '备注') : null,
                      h(
                        'div',
                        { className: 'aw-row-acts' },
                        h(Btn, { small: true, tone: 'ghost', disabled: busy, title: '修改标题 / 项目 / 备注…', onClick: () => setEditing(todo) }, '编辑'),
                        h(Btn, { small: true, tone: 'ghost', disabled: busy, onClick: () => send('todo_undo', { id: todo.id }) }, '撤销'),
                      ),
                    ),
                  ),
                ),
          ),

          // ── 4. 历史完成（本周之前的，默认折叠一屏） ──
          h(
            Sec,
            {
              title: h('span', null, '历史完成 ', h('b', null, String(historyTotal))),
              extra: h(
                'span',
                { className: 'aw-note' },
                historyTotal > 0 ? `本周之前 · 最近 ${historyList.length} 条` : '还没有更早的完成记录',
              ),
            },
            historyTotal === 0
              ? h('div', { className: 'aw-note' }, '本周之前还没有完成过的事。')
              : h(
                  'div',
                  { className: 'aw-list' },
                  historyList.map((todo) =>
                    h(
                      'div',
                      { className: 'aw-row is-done', key: todo.id },
                      h('span', { className: 'aw-check-done', title: `已完成 · ${todo.completedDate}`, 'aria-label': '已完成' }, '✓'),
                      h(
                        'div',
                        { className: 'aw-row-main' },
                        h('div', { className: 'aw-row-title' }, todo.title),
                        h(
                          'div',
                          { className: 'aw-row-meta' },
                          h('span', null, String(todo.completedDate).slice(5)),
                          todo.projectName
                            ? h(
                                'span',
                                null,
                                h('span', { className: 'aw-dot', style: { background: todo.projectColor || BRAND.jadeLight, marginRight: 4 } }),
                                `${todo.projectEmoji || '📁'}${todo.projectName}`,
                              )
                            : null,
                        ),
                      ),
                      todo.note ? h('span', { className: 'aw-note', title: todo.note }, '备注') : null,
                    ),
                  ),
                  historyTotal > HISTORY_PAGE
                    ? h(
                        'div',
                        { style: { display: 'flex', justifyContent: 'center', paddingTop: 6 } },
                        h(
                          Btn,
                          { small: true, tone: 'ghost', onClick: () => setShowAllHistory(!showAllHistory) },
                          showAllHistory ? '收起' : `展开全部 ${historyTotal} 条`,
                        ),
                      )
                    : null,
                ),
          ),
        ),

        h(
          Modal,
          { open: adding, closable: true, title: '新增待办', onClose: closeTodo },
          h(TodoCreator, {
            api,
            projects,
            busy,
            onDirtyChange: setTodoDirty,
            onDone: () => { setTodoDirty(false); setAdding(false); },
          }),
          h(TemplatesList, { api, busy }),
          // 放最后但用 order:-1 视觉置顶：子节点位置稳定，重渲染不会让 TodoCreator 换位丢草稿
          confirmTodoClose
            ? h(
                'div',
                { className: 'aw-modal-confirm' },
                h('span', null, '已填写的内容尚未保存，确认放弃填写？'),
                h(
                  Btn,
                  {
                    small: true,
                    tone: 'danger',
                    onClick: () => { setConfirmTodoClose(false); setTodoDirty(false); setAdding(false); },
                  },
                  '放弃填写',
                ),
                h(Btn, { small: true, tone: 'ghost', onClick: () => setConfirmTodoClose(false) }, '继续填写'),
              )
            : null,
        ),

        h(TodoEditor, { api, todo: editing, projects, busy, onClose: () => setEditing(null) }),
      );
    }

    function dayStatusText(status) {
      return { normal: '正常', leave: '请假', 'half-leave': '半天假', overtime: '加班' }[status] || status;
    }

    /** 单条待办行。 */
    function TodoRow(props) {
      const todo = props.todo;
      const [openMenu, setOpenMenu] = React.useState(false);
      // 删除是两步的：先点「删除」，再点「确认删除」。待办删掉之后界面上就找不回来了，值得多一次确认。
      const [confirmDel, setConfirmDel] = React.useState(false);
      // null = 不在编辑；字符串 = 正在输入的完成度
      const [progressDraft, setProgressDraft] = React.useState(null);
      const done = todo.status === 'done';

      /** 保存完成度（0~100 取整）。 */
      const commitProgress = () => {
        const value = Math.max(0, Math.min(100, Math.round(Number(progressDraft) || 0)));
        setProgressDraft(null);
        setOpenMenu(false);
        if (value !== todo.progress) props.onProgress(value);
      };

      const meta = [
        h(Prio, { key: 'p', value: todo.priority, withLabel: true }),
        todo.projectName
          ? h(
              'span',
              { key: 'pj' },
              h('span', { className: 'aw-dot', style: { background: todo.projectColor || BRAND.jadeLight, marginRight: 4 } }),
              `${todo.projectEmoji || '📁'}${todo.projectName}`,
            )
          : h('span', { key: 'pj' }, '非项目事务'),
        todo.carried
          ? h(
              'span',
              {
                key: 'carry',
                className: todo.carriedLevel === 'high' ? 'is-danger' : todo.carriedLevel === 'mid' ? 'is-warn' : undefined,
                style: { fontWeight: todo.carriedLevel === 'high' ? 600 : 400 },
              },
              `顺延 ${todo.rolloverCount} 天`,
            )
          : null,
        todo.estimateHours ? h('span', { key: 'est' }, `预估 ${fmtHours(todo.estimateHours)}`) : null,
        todo.progress > 0 && todo.progress < 100
          ? h('span', { key: 'prog', title: '完成度（用于周报）' }, `${todo.progress}%`)
          : null,
        todo.dueDate
          ? h(
              'span',
              { key: 'due', style: todo.overdue ? { color: 'var(--aw-danger)', fontWeight: 600 } : null },
              `${todo.dueDate}${todo.overdue ? ' 逾期' : ' 截止'}`,
            )
          : null,
        todo.repeatLabel ? h('span', { key: 'rep' }, todo.repeatLabel) : null,
        todo.tags.length > 0 ? h('span', { key: 'tags' }, todo.tags.map((tag) => `#${tag}`).join(' ')) : null,
        todo.note ? h('span', { key: 'note', title: todo.note, style: { cursor: 'help' } }, '备注') : null,
      ].filter(Boolean);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h(
          'div',
          { className: 'aw-row' },
          h('input', {
            className: 'aw-check',
            type: 'checkbox',
            checked: done,
            disabled: props.busy,
            onChange: () => (done ? props.onUndo && props.onUndo() : props.onComplete()),
          }),
          h(
            'div',
            { className: 'aw-row-main' },
            h('div', { className: 'aw-row-title', title: todo.title }, todo.title),
            h('div', { className: 'aw-row-meta' }, meta),
          ),
          h(
            'div',
            { className: 'aw-row-acts' },
            done
              ? h(Btn, { small: true, tone: 'ghost', disabled: props.busy, onClick: props.onUndo }, '撤销')
              : h(
                  Btn,
                  {
                    small: true,
                    tone: 'ghost',
                    disabled: props.busy,
                    title: '改期 / 转积压 / 放弃 / 删除',
                    onClick: () => {
                      setOpenMenu(!openMenu);
                      setConfirmDel(false);
                      setProgressDraft(null);
                    },
                  },
                  '⋯',
                ),
          ),
        ),
        openMenu && !done
          ? h(
              'div',
              { className: 'aw-row-acts', style: { flexWrap: 'wrap', justifyContent: 'flex-end' } },
              // 点了「删除」不立刻删，整排换成一句确认 —— 待办删掉之后界面上就找不回来了
              progressDraft !== null
                ? [
                    h('span', { key: 'label', className: 'aw-note' }, '完成度'),
                    h('input', {
                      key: 'input',
                      className: 'aw-input',
                      style: { width: 68 },
                      type: 'number',
                      min: 0,
                      max: 100,
                      step: 5,
                      value: progressDraft,
                      onChange: (event) => setProgressDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') commitProgress();
                        if (event.key === 'Escape') setProgressDraft(null);
                      },
                    }),
                    h('span', { key: 'pct', className: 'aw-note' }, '%'),
                    h(Btn, { key: 'save', small: true, tone: 'primary', disabled: props.busy, onClick: commitProgress }, '保存'),
                    h(Btn, { key: 'cancel', small: true, tone: 'ghost', onClick: () => setProgressDraft(null) }, '取消'),
                  ]
              : confirmDel
                ? [
                    h('span', { key: 'hint', className: 'aw-note' }, `确认删除「${todo.title}」？`),
                    h(
                      Btn,
                      {
                        key: 'confirm',
                        small: true,
                        tone: 'danger',
                        disabled: props.busy,
                        title: '会从列表里移除，历史流水保留',
                        onClick: () => {
                          setConfirmDel(false);
                          setOpenMenu(false);
                          props.onDelete();
                        },
                      },
                      '确认删除',
                    ),
                    h(Btn, { key: 'cancel', small: true, tone: 'ghost', onClick: () => setConfirmDel(false) }, '取消'),
                  ]
                : [
                    h(
                      Btn,
                      {
                        key: 'edit',
                        small: true,
                        tone: 'ghost',
                        disabled: props.busy,
                        title: '修改标题 / 项目 / 备注 / 计划日…',
                        onClick: () => {
                          setOpenMenu(false);
                          props.onEdit();
                        },
                      },
                      '编辑',
                    ),
                    h(
                      Btn,
                      {
                        key: 'progress',
                        small: true,
                        tone: 'ghost',
                        disabled: props.busy,
                        title: '设置完成度（用于周报里的「（30%）」）',
                        onClick: () => {
                          setProgressDraft(String(todo.progress));
                          setConfirmDel(false);
                        },
                      },
                      '进度',
                    ),
                    h(Btn, { key: 'tomorrow', small: true, disabled: props.busy, onClick: () => props.onReschedule({ deltaDays: 1 }) }, '推到明天'),
                    h(Btn, { key: 'today', small: true, disabled: props.busy, onClick: () => props.onReschedule({ toToday: true }) }, '今天做'),
                    h(Btn, { key: 'backlog', small: true, disabled: props.busy, onClick: () => props.onReschedule({ toBacklog: true }) }, '转积压'),
                    h(Btn, { key: 'drop', small: true, tone: 'danger', disabled: props.busy, onClick: props.onDrop }, '放弃'),
                    h(
                      Btn,
                      {
                        key: 'delete',
                        small: true,
                        tone: 'ghost',
                        disabled: props.busy,
                        title: '删除这条待办（从列表移除，历史流水保留）',
                        onClick: () => setConfirmDel(true),
                      },
                      '删除',
                    ),
                  ],
            )
          : null,
      );
    }

    /**
     * 待办编辑器：未完成和已完成共用同一个弹层。
     * 已完成的条目「完成度」是只读的 —— 做完了就按 100% 计入周报，不看这个字段。
     */
    function TodoEditor(props) {
      const { api, todo, projects, busy, onClose } = props;
      const [editing, setEditing] = React.useState({ id: null, draft: null });

      if (!todo) return null;

      /** 打开某条待办时的初始草稿。 */
      const initialDraft = (item) => ({
        title: item.title,
        note: item.note || '',
        projectId: item.projectId || '',
        priority: item.priority || 'P2',
        estimateHours: item.estimateHours === null || item.estimateHours === undefined ? '' : String(item.estimateHours),
        plannedDate: item.plannedDate || '',
        dueDate: item.dueDate || '',
        progress: String(item.progress ?? 0),
        rollover: item.rollover === 'inherit' ? 'inherit' : item.rollover,
      });

      // 换了另一条待办就重新取初始值；同一帧内即可用，不依赖 effect 触发重渲染
      const draft = editing.id === todo.id && editing.draft ? editing.draft : initialDraft(todo);
      const done = todo.status === 'done';
      const set = (patch) => setEditing({ id: todo.id, draft: { ...draft, ...patch } });

      const save = () => {
        const title = draft.title.trim();
        if (!title) return;
        const payload = {
          id: todo.id,
          title,
          note: draft.note,
          projectId: draft.projectId,
          priority: draft.priority,
          estimateHours: draft.estimateHours === '' ? null : Number(draft.estimateHours),
          dueDate: draft.dueDate,
          rollover: draft.rollover,
        };
        if (draft.plannedDate) payload.plannedDate = draft.plannedDate;
        if (!done) payload.progress = draft.progress === '' ? 0 : Number(draft.progress);
        api.send('todo_update', payload).then((result) => {
          if (result.ok) onClose();
        });
      };

      return h(
        'div',
        {
          className: 'aw-backdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'aw-modal' },
          h('h3', null, done ? '修改已完成的任务' : '修改待办'),
          h(
            Field,
            { label: '标题' },
            h('input', {
              className: 'aw-input',
              value: draft.title,
              autoFocus: true,
              onChange: (event) => set({ title: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') save();
                if (event.key === 'Escape') onClose();
              },
            }),
          ),
          h(
            Field,
            { label: '备注' },
            h('textarea', {
              className: 'aw-textarea',
              rows: 2,
              placeholder: '做了什么、卡在哪…',
              value: draft.note,
              onChange: (event) => set({ note: event.target.value }),
            }),
          ),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 } },
            h(
              Field,
              { label: '项目' },
              h(
                'select',
                { className: 'aw-select', value: draft.projectId, onChange: (event) => set({ projectId: event.target.value }) },
                h('option', { value: '' }, '无项目'),
                projects.map((project) => h('option', { key: project.id, value: project.id }, `${project.emoji}${project.name}`)),
              ),
            ),
            h(
              Field,
              { label: '优先级' },
              h(
                'select',
                { className: 'aw-select', value: draft.priority, title: PRIORITY_TIP, onChange: (event) => set({ priority: event.target.value }) },
                PRIORITIES.map((value) => h('option', { key: value, value, title: PRIORITY_INFO[value].full }, `${value} · ${PRIORITY_INFO[value].short}`)),
              ),
            ),
            h(
              Field,
              { label: '顺延策略' },
              h(
                'select',
                { className: 'aw-select', value: draft.rollover, onChange: (event) => set({ rollover: event.target.value }) },
                h('option', { value: 'inherit' }, '跟随全局（默认）'),
                h('option', { value: 'always' }, '一律顺延'),
                h('option', { value: 'backlog' }, '顺延进积压'),
                h('option', { value: 'never' }, '到期作废'),
              ),
            ),
            h(
              Field,
              { label: '计划日' },
              h('input', {
                className: 'aw-input',
                type: 'date',
                value: draft.plannedDate,
                onChange: (event) => set({ plannedDate: event.target.value }),
              }),
            ),
            h(
              Field,
              { label: '截止日' },
              h('input', {
                className: 'aw-input',
                type: 'date',
                value: draft.dueDate,
                onChange: (event) => set({ dueDate: event.target.value }),
              }),
            ),
            h(
              Field,
              { label: '预估工时' },
              h('input', {
                className: 'aw-input',
                type: 'number',
                min: 0,
                max: 24,
                step: 0.5,
                placeholder: '—',
                value: draft.estimateHours,
                onChange: (event) => set({ estimateHours: event.target.value }),
              }),
            ),
            h(
              Field,
              { label: done ? '完成度（已完成固定 100%）' : '完成度 %' },
              h('input', {
                className: 'aw-input',
                type: 'number',
                min: 0,
                max: 100,
                step: 5,
                value: done ? '100' : draft.progress,
                disabled: done,
                onChange: (event) => set({ progress: event.target.value }),
              }),
            ),
          ),
          h(
            'div',
            { className: 'aw-form', style: { justifyContent: 'flex-end' } },
            h(Btn, { tone: 'ghost', onClick: onClose }, '取消'),
            h(Btn, { tone: 'primary', disabled: busy || !draft.title.trim(), onClick: save }, '保存'),
          ),
          h(
            'div',
            { className: 'aw-note' },
            done
              ? '这条已经完成：改标题 / 项目 / 备注都会同步到周报与统计。'
              : '完成度会写进周报的「1.事项名（30%）」；不填就按 30% 计。',
          ),
        ),
      );
    }

    /* ================= 今日页复用：新建表单 / 重复任务 ================= */

    function TodoCreator(props) {
      const api = props.api;
      const busy = props.busy;
      const [draft, setDraft] = React.useState({
        title: '',
        projectId: '',
        priority: 'P2',
        estimateHours: '',
        plannedDate: localToday(),
        repeatOn: false,
        freq: 'workdays',
        weekdays: [],
        monthDays: '',
        rollover: 'inherit',
      });
      const set = (patch) => {
        setDraft({ ...draft, ...patch });
        // 任何一次编辑都算「已填写」；提交成功 / 放弃填写时由上层清零
        if (props.onDirtyChange) props.onDirtyChange(true);
      };

      const submit = () => {
        const repeat = draft.repeatOn
          ? {
              freq: draft.freq,
              ...(draft.freq === 'weekly' ? { weekdays: draft.weekdays } : {}),
              ...(draft.freq === 'monthly'
                ? { monthDays: String(draft.monthDays || '')
                    .split(/[,\s]+/)
                    .map(Number)
                    .filter((n) => n >= 1 && n <= 31) }
                : {}),
            }
          : null;
        api
          .send('todo_create', {
            title: draft.title,
            projectId: draft.projectId || null,
            priority: draft.priority,
            estimateHours: draft.estimateHours === '' ? null : Number(draft.estimateHours),
            plannedDate: draft.plannedDate,
            repeat,
            rollover: draft.rollover,
          })
          .then((result) => {
            if (result.ok) {
              set({ title: '' });
              if (props.onDone) props.onDone();
            }
          });
      };

      return h(
        'div',
        { className: 'aw-form-vertical' },
        h(
          Field,
          { label: '待办标题' },
          h('input', {
            className: 'aw-input',
            placeholder: '待办标题',
            value: draft.title,
            onChange: (event) => set({ title: event.target.value }),
          }),
        ),
        h(
          Field,
          { label: '所属项目' },
          h(
            'select',
            { className: 'aw-select', value: draft.projectId, onChange: (event) => set({ projectId: event.target.value }) },
            h('option', { value: '' }, '无项目'),
            (props.projects || []).map((project) => h('option', { key: project.id, value: project.id }, `${project.emoji}${project.name}`)),
          ),
        ),
        h(
          Field,
          { label: '优先级' },
          h(
            'select',
            { className: 'aw-select', value: draft.priority, title: PRIORITY_TIP, onChange: (event) => set({ priority: event.target.value }) },
            PRIORITIES.map((value) => h('option', { key: value, value }, `${value} · ${PRIORITY_INFO[value].short}`)),
          ),
        ),
        h(
          Field,
          { label: '预估工时' },
          h('input', {
            className: 'aw-input',
            type: 'number',
            min: 0,
            max: 24,
            step: 0.5,
            placeholder: '预估 h',
            value: draft.estimateHours,
            onChange: (event) => set({ estimateHours: event.target.value }),
          }),
        ),
        h(
          Field,
          { label: '计划日期' },
          h('input', {
            className: 'aw-input',
            type: 'date',
            value: draft.plannedDate,
            onChange: (event) => set({ plannedDate: event.target.value }),
          }),
        ),
        h(
          Field,
          { label: '重复任务' },
          h(
            'label',
            { className: 'aw-split-row', style: { gap: 6, fontSize: 12.5, fontWeight: 600 } },
            h('input', { className: 'aw-check', type: 'checkbox', checked: draft.repeatOn, onChange: (event) => set({ repeatOn: event.target.checked }) }),
            '开启',
          ),
        ),
        draft.repeatOn
          ? h(
              Field,
              { label: '重复频率' },
              h(
                'select',
                { className: 'aw-select', value: draft.freq, onChange: (event) => set({ freq: event.target.value }) },
                h('option', { value: 'daily' }, '每天'),
                h('option', { value: 'workdays' }, '每个法定工作日'),
                h('option', { value: 'weekdays' }, '周一至周五'),
                h('option', { value: 'weekly' }, '每周指定几天'),
                h('option', { value: 'monthly' }, '每月指定几号'),
              ),
            )
          : null,
        draft.repeatOn && draft.freq === 'weekly'
          ? h(
              Field,
              { label: '每周几' },
              h(
                'div',
                { className: 'aw-weekdays' },
                WEEKDAYS.map((name, index) =>
                  h(Btn,
                    {
                      key: name,
                      small: true,
                      on: draft.weekdays.includes(index),
                      onClick: () =>
                        set({ weekdays: draft.weekdays.includes(index) ? draft.weekdays.filter((d) => d !== index) : draft.weekdays.concat(index).sort() }),
                    },
                    name,
                  ),
                ),
              ),
            )
          : null,
        draft.repeatOn && draft.freq === 'monthly'
          ? h(
              Field,
              { label: '每月几号' },
              h('input', {
                className: 'aw-input',
                placeholder: '几号，如 1,15',
                value: draft.monthDays,
                onChange: (event) => set({ monthDays: event.target.value }),
              }),
            )
          : null,
        h(
          Field,
          { label: '顺延策略' },
          h(
            'select',
            { className: 'aw-select', value: draft.rollover, onChange: (event) => set({ rollover: event.target.value }), title: '没做完怎么办' },
            h('option', { value: 'inherit' }, '顺延（默认）'),
            h('option', { value: 'always' }, '一定顺延'),
            h('option', { value: 'backlog' }, '顺延进积压'),
            h('option', { value: 'never' }, '到期作废'),
          ),
        ),
        h(
          'div',
          { className: 'aw-submit-wrap' },
          h(Btn, { tone: 'primary', disabled: busy || !draft.title.trim(), onClick: submit }, '新建'),
        ),
        h('span', { className: 'aw-note', title: PRIORITY_TIP }, `优先级：${PRIORITY_LEGEND}`),
      );
    }

    function TemplatesList(props) {
      const api = props.api;
      const [rows, setRows] = React.useState([]);
      const [rev, setRev] = React.useState(0);
      React.useEffect(() => {
        let alive = true;
        fetch(`${ROUTE}?view=todos&templates=1&status=all&today=${localToday()}`)
          .then((response) => response.json())
          .then((data) => {
            if (alive && data && data.ok) setRows(data.view.todos.filter((item) => item.isTemplate));
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [rev]);

      if (rows.length === 0) return null; // 没有模板就什么都不显示，别白占一节
      return h(
        'div',
        { className: 'aw-list', style: { marginTop: 2 } },
        h('div', { className: 'aw-note' }, '已有的重复任务：'),
        rows.map((todo) =>
          h(
            'div',
            { className: 'aw-row', key: todo.id },
            h('div', { className: 'aw-row-main' },
              h('div', { className: 'aw-row-title' }, todo.title),
              h(
                'div',
                { className: 'aw-row-meta' },
                h('span', { key: 'r' }, todo.repeatLabel),
                todo.projectName ? h('span', { key: 'p' }, todo.projectName) : null,
                todo.priority ? h('span', { key: 'q' }, todo.priority) : null,
              )),
            h(Btn, {
              small: true,
              tone: 'ghost',
              disabled: props.busy,
              onClick: () => api.send('todo_update', { id: todo.id, enabled: false }).then(() => setRev((value) => value + 1)),
            }, '停用'),
            h(Btn, {
              small: true,
              tone: 'danger',
              disabled: props.busy,
              onClick: () => api.send('todo_delete', { id: todo.id }).then(() => setRev((value) => value + 1)),
            }, '删除'),
          ),
        ),
      );
    }

    /* ================= 项目 ================= */

    /**
     * 项目编辑器：新建之后随时能改名字 / 代号 / 负责人 / 说明 / 状态 / 起止日期。
     */
    function ProjectEditor(props) {
      const { api, project, busy, onClose } = props;
      const [editing, setEditing] = React.useState({ id: null, draft: null });

      if (!project) return null;

      const initial = (item) => ({
        name: item.name || '',
        description: item.description || '',
        status: item.status || 'active',
      });

      const draft = editing.id === project.id && editing.draft ? editing.draft : initial(project);
      const set = (patch) => setEditing({ id: project.id, draft: { ...draft, ...patch } });

      const save = () => {
        const name = draft.name.trim();
        if (!name) return;
        api
          .send('project_update', {
            id: project.id,
            name,
            description: draft.description,
            status: draft.status,
          })
          .then((result) => {
            if (result.ok) onClose();
          });
      };

      return h(
        'div',
        {
          className: 'aw-backdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'aw-modal' },
          h('h3', null, '修改项目'),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0,1fr))', gap: 10 } },
            h(Field, { label: '项目名', style: { gridColumn: 'span 8' } },
              h('input', { className: 'aw-input', value: draft.name, autoFocus: true, onChange: (event) => set({ name: event.target.value }) })),
            h(Field, { label: '状态', style: { gridColumn: 'span 4' } },
              h('select',
                { className: 'aw-select', value: draft.status, onChange: (event) => set({ status: event.target.value }) },
                h('option', { value: 'active' }, '进行中'),
                h('option', { value: 'paused' }, '暂停'),
                h('option', { value: 'archived' }, '已归档'))),
            h(Field, { label: '说明', style: { gridColumn: 'span 12' } },
              h('textarea', { className: 'aw-textarea', rows: 2, placeholder: '做什么的、边界在哪…', value: draft.description, onChange: (event) => set({ description: event.target.value }) })),
          ),
          h(
            'div',
            { className: 'aw-form', style: { justifyContent: 'flex-end' } },
            h(Btn, { tone: 'ghost', onClick: onClose }, '取消'),
            h(Btn, { tone: 'primary', disabled: busy || !draft.name.trim(), onClick: save }, '保存'),
          ),
          h('div', { className: 'aw-note' }, '改名不会影响已经挂在这个项目下的待办和工单，它们跟着 id 走。'),
        ),
      );
    }

    function ProjectsTab(props) {
      const api = props.api;
      const view = props.view;
      const busy = props.busy;
      const [draft, setDraft] = React.useState({ name: '' });
      const [editing, setEditing] = React.useState(null);

      if (!Array.isArray(view)) return h(Empty, null, '加载中…');

      const create = () =>
        api.send('project_create', { name: draft.name }).then((result) => {
          if (result.ok) setDraft({ name: '' });
        });

      const statusText = { active: '进行中', paused: '暂停', archived: '已归档' };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },

        // ── 新建项目：带字段名的栅格，不再是 placeholder 一排 ──
        h(Card, {
          title: '新建项目',
          children: h(
            'div',
            { className: 'aw-form aw-composer', style: { alignItems: 'flex-end' } },
            h(Field, { label: '项目名', style: { flex: '1 1 260px' } },
              h('input', {
                className: 'aw-input',
                placeholder: '例如：示例政务客户二期',
                value: draft.name,
                onChange: (event) => setDraft({ ...draft, name: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && draft.name.trim()) create();
                },
              })),
            h(Btn, { tone: 'primary', disabled: busy || !draft.name.trim(), onClick: create }, '新建'),
          ),
        }),

        view.length === 0
          ? h(Card, { children: h(Empty, null, '还没有项目。建一个，把待办和工单挂上去。') })
          : h(
              'div',
              { className: 'aw-grid' },
              view.map((project) =>
                h(Card, {
                  key: project.id,
                  title: h(
                    'span',
                    { className: 'aw-split-row', style: { flex: '1 1 auto', minWidth: 0 } },
                    h('span', { style: { fontWeight: 600 } }, `${project.emoji} ${project.name}`),
                    project.code ? h('span', { className: 'aw-note' }, project.code) : null,
                    h('span', { className: 'aw-spacer' }),
                    h(Chip, {
                      tone: project.status === 'active' ? 'ok' : project.status === 'archived' ? 'gold' : undefined,
                      children: statusText[project.status] || project.status,
                    }),
                  ),
                  children: h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                    project.owner ? h('div', { className: 'aw-note' }, `负责人：${project.owner}`) : null,

                    // 进度：条形 + 百分比，一眼看出做了多少
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h(
                        'div',
                        { className: 'aw-split-row' },
                        h('span', { className: 'aw-note' }, `完成 ${project.doneCount}/${project.totalCount}`),
                        h('span', { className: 'aw-spacer' }),
                        h('span', { style: { fontWeight: 600, fontSize: 'var(--aw-fs-meta)' } }, pctText(project.progress)),
                      ),
                      h(Bar, { ratio: project.progress / 100 }),
                    ),

                    // 指标用 chip 排，折行也不会溢出卡片
                    h(
                      'div',
                      { className: 'aw-chips' },
                      h(Chip, { children: `进行中 ${project.openCount}` }),
                      h(Chip, { children: `投入 ${fmtHours(project.hours)}` }),
                      project.carriedCount > 0 ? h(Chip, { tone: 'warn', children: `顺延 ${project.carriedCount}` }) : null,
                      project.overdueCount > 0 ? h(Chip, { tone: 'danger', children: `逾期 ${project.overdueCount}` }) : null,
                      project.lastActivity ? h(Chip, { children: `最近 ${project.lastActivity.slice(5)}` }) : null,
                    ),

                    project.nextTodos.length > 0
                      ? h(
                          'div',
                          { className: 'aw-list' },
                          project.nextTodos.slice(0, 3).map((todo) =>
                            h(
                              'div',
                              { className: 'aw-row', key: todo.id },
                              h('input', {
                                className: 'aw-check',
                                type: 'checkbox',
                                disabled: busy,
                                onChange: () => api.send('todo_complete', { id: todo.id }),
                              }),
                              h('div', { className: 'aw-row-main' }, h('div', { className: 'aw-row-title', style: { fontSize: 12.5 } }, todo.title)),
                              todo.carried ? h('span', { className: 'aw-note' }, `顺延 ${todo.rolloverCount} 天`) : null,
                            ),
                          ),
                          project.nextTodos.length > 3
                            ? h('div', { className: 'aw-note' }, `还有 ${project.nextTodos.length - 3} 条…`)
                            : null,
                        )
                      : h('div', { className: 'aw-note' }, '没有进行中的待办'),

                    h(
                      'div',
                      { className: 'aw-split-row' },
                      h(Btn, { small: true, tone: 'ghost', disabled: busy, onClick: () => setEditing(project) }, '编辑'),
                      h(Btn, { small: true, tone: 'ghost', disabled: busy, onClick: () => api.send('report_create', { type: 'project', projectId: project.id, ...monthParams() }) }, '项目月报'),
                      project.status === 'archived'
                        ? h(Btn, { small: true, tone: 'ghost', disabled: busy, onClick: () => api.send('project_update', { id: project.id, status: 'active' }) }, '恢复')
                        : h(Btn, { small: true, tone: 'ghost', disabled: busy, onClick: () => api.send('project_update', { id: project.id, status: 'archived' }) }, '归档'),
                    ),
                  ),
                }),
              ),
            ),

        h(ProjectEditor, { api, project: editing, busy, onClose: () => setEditing(null) }),
      );
    }

    function monthParams() {
      const today = localToday();
      return { date: today };
    }

    /* ================= 工时 ================= */

    function HoursTab(props) {
      const api = props.api;
      const view = props.view;
      const busy = props.busy;
      // 工单录入草稿（日期默认今天，小时留空 = 无工时）
      const [ticketDraft, setTicketDraft] = React.useState({ type: '', date: localToday(), projectId: '', url: '', title: '', hours: '', note: '' });
      // 工单行：哪一条正在二次确认删除 / 哪一条正在编辑
      const [ticketConfirm, setTicketConfirm] = React.useState(null);
      const [editingTicket, setEditingTicket] = React.useState(null);
      const month = props.month;
      const projects = (props.boot && props.boot.projects) || [];

      if (
        !view ||
        !Array.isArray(view.days) ||
        view.days.length === 0 ||
        !view.coverage ||
        !Array.isArray(view.trend) ||
        !Array.isArray(view.byProject) ||
        !Array.isArray(view.tickets)
      ) {
        return h(Empty, null, '加载中…');
      }

      /** 记一条工单；填了小时就会自动进工时台账。 */
      const addTicket = () => {
        if (!ticketDraft.title.trim()) return;
        api
          .send('ticket_add', {
            type: ticketDraft.type,
            date: ticketDraft.date || localToday(),
            projectId: ticketDraft.projectId || null,
            url: ticketDraft.url,
            title: ticketDraft.title,
            hours: ticketDraft.hours === '' ? null : Number(ticketDraft.hours),
            note: ticketDraft.note,
          })
          .then((result) => {
            if (result.ok) setTicketDraft({ ...ticketDraft, title: '', url: '', hours: '', note: '' });
          });
      };

      const leading = (view.days[0].weekday + 6) % 7;
      const cells = [];
      for (let i = 0; i < leading; i += 1) cells.push(null);
      for (const day of view.days) cells.push(day);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(Card, {
          title: h(
            'span',
            { className: 'aw-split-row' },
            h(Btn, { small: true, tone: 'ghost', onClick: () => props.onMonth(shiftMonth(month, -1)) }, '‹'),
            h('b', { style: { fontSize: 15, minWidth: 116, textAlign: 'center' } }, view.label),
            h(Btn, { small: true, tone: 'ghost', onClick: () => props.onMonth(shiftMonth(month, 1)) }, '›'),
            h(Btn, { small: true, tone: 'ghost', onClick: () => props.onMonth(monthOf(localToday())) }, '回到本月'),
          ),
          extra: h('span', { className: 'aw-note' }, `${view.gradeLabel} · 系数 ${view.gradeFactor} · 每日 ${fmtHours(view.dailyHours)}`),
          children: h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
            !view.coverage.complete
              ? h(
                  'div',
                  { className: 'aw-chip is-warn', style: { alignSelf: 'flex-start', whiteSpace: 'normal' } },
                  `⚠️ ${view.coverage.uncoveredYears.join('、')} 年的节假日安排尚未导入，这些日期按「周一~周五 = 工作日」估算，工时数字可能不准。`,
                )
              : null,
            h(
              'div',
              { className: 'aw-metrics' },
              h(Metric, { label: '法定工作日', value: String(view.workdays), unit: '天', hint: `已过 ${view.elapsedWorkdays} · 剩余 ${view.remainingWorkdays}` }),
              h(Metric, { label: '计划工时', value: fmtHours(view.planHours), hint: `${view.workdays} × ${fmtHours(view.dailyHours)}` }),
              h(Metric, { label: '必须工时', value: fmtHours(view.requiredHours), hint: `计划 × ${view.gradeFactor}`, tone: 'ok' }),
              h(Metric, { label: '已录工时', value: fmtHours(view.loggedHours), hint: view.leaveDays > 0 ? `请假 ${view.leaveDays} 天` : null }),
              h(Metric, {
                label: '达成率',
                value: pctText(view.achievement),
                tone: view.achievement >= 100 ? 'ok' : view.achievement >= 80 ? undefined : 'danger',
              }),
              h(Metric, { label: '缺口', value: fmtHours(view.gapHours) }),
            ),
            h(Bar, { ratio: view.achievement / 100, tone: view.achievement >= 100 ? undefined : 'gold' }),
            view.overtimeHours > 0 ? h('div', { className: 'aw-note' }, `其中加班 ${fmtHours(view.overtimeHours)}`) : null,
          ),
        }),

        // ── 本月工单（工时台账的「按单」视角）──
        h(Card, {
          title: h(
            'span',
            { className: 'aw-split-row' },
            '本月工单 ',
            h('b', null, String(view.tickets.length)),
            h('span', { className: 'aw-note' }, '带工时的工单自动计入已录工时'),
          ),
          extra: h(
            'span',
            { className: 'aw-note' },
            `${view.label}，应出勤 ${view.workdays} 天，100% 工时 ${fmtHours(view.planHours)}，110% 工时 ${fmtHours(view.requiredHours)}`,
          ),
          children: h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            // 录入区：两行、带字段名的栅格（12 栏），不再是一排控件乱折行
            h(
              'div',
              { className: 'aw-ticket-form' },
              h(Field, { label: '类型', style: { gridColumn: 'span 2' } },
                h(
                  'select',
                  { className: 'aw-select', value: ticketDraft.type, onChange: (event) => setTicketDraft({ ...ticketDraft, type: event.target.value }) },
                  h('option', { value: '' }, '未指定'),
                  TICKET_TYPES.map((value) => h('option', { key: value, value }, value)),
                )),
              h(Field, { label: '日期', style: { gridColumn: 'span 2' } },
                h('input', {
                  className: 'aw-input',
                  type: 'date',
                  value: ticketDraft.date,
                  onChange: (event) => setTicketDraft({ ...ticketDraft, date: event.target.value }),
                })),
              h(Field, { label: '项目', style: { gridColumn: 'span 2' } },
                h(
                  'select',
                  { className: 'aw-select', value: ticketDraft.projectId, onChange: (event) => setTicketDraft({ ...ticketDraft, projectId: event.target.value }) },
                  h('option', { value: '' }, '无项目'),
                  projects.map((project) => h('option', { key: project.id, value: project.id }, `${project.emoji}${project.name}`)),
                )),
              h(Field, { label: '小时', style: { gridColumn: 'span 2' } },
                h('input', {
                  className: 'aw-input',
                  type: 'number',
                  min: 0,
                  max: MAX_TICKET_HOURS,
                  step: 0.5,
                  placeholder: '—',
                  title: `留空表示「无工时」，最多 ${MAX_TICKET_HOURS}h`,
                  value: ticketDraft.hours,
                  onChange: (event) => setTicketDraft({ ...ticketDraft, hours: event.target.value }),
                })),
              h(Field, { label: '问题 / 任务', style: { gridColumn: 'span 4' } },
                h('input', {
                  className: 'aw-input',
                  placeholder: '这条单在做什么',
                  value: ticketDraft.title,
                  onChange: (event) => setTicketDraft({ ...ticketDraft, title: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') addTicket();
                  },
                })),
              h(Field, { label: '链接', style: { gridColumn: 'span 8' } },
                h('input', {
                  className: 'aw-input',
                  placeholder: 'https://issuetrack.example.com/issues/10001',
                  value: ticketDraft.url,
                  onChange: (event) => setTicketDraft({ ...ticketDraft, url: event.target.value }),
                })),
              h(Field, { label: '备注', style: { gridColumn: 'span 2' } },
                h('input', {
                  className: 'aw-input',
                  placeholder: '不改',
                  value: ticketDraft.note,
                  onChange: (event) => setTicketDraft({ ...ticketDraft, note: event.target.value }),
                })),
              h(Field, { label: '\u00a0', style: { gridColumn: 'span 2' } },
                h(Btn, { tone: 'primary', disabled: busy || !ticketDraft.title.trim(), onClick: addTicket }, '记工单')),
            ),
            view.tickets.length === 0
              ? h('div', { className: 'aw-note' }, '本月还没有工单。上面填一条，链接和小时都可以留空。')
              : h(
                  'div',
                  { className: 'aw-scroll', style: { maxHeight: 420 } },
                  h(
                    'table',
                    { className: 'aw-table' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', null, '日期'),
                        h('th', null, '类型'),
                        h('th', null, '项目'),
                        h('th', null, '链接'),
                        h('th', null, '问题/任务'),
                        h('th', { className: 'is-num' }, '小时'),
                        h('th', null, ''),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      view.tickets.map((ticket) => [
                        h(
                          'tr',
                          { key: ticket.id },
                          h('td', null, String(ticket.date).slice(5)),
                          h(
                            'td',
                            null,
                            ticket.type
                              ? h('span', { className: 'aw-chip', style: { padding: '1px 7px', fontSize: 11 } }, ticket.type)
                              : h('span', { className: 'aw-note' }, '—'),
                          ),
                          h(
                            'td',
                            null,
                            ticket.projectName
                              ? h(
                                  'span',
                                  null,
                                  h('span', { className: 'aw-dot', style: { background: ticket.projectColor || BRAND.jadeLight, marginRight: 4 } }),
                                  ticket.projectName,
                                )
                              : h('span', { className: 'aw-note' }, '未归类'),
                          ),
                          h(
                            'td',
                            { className: 'is-link' },
                            ticket.url
                              ? h('a', { href: ticket.url, target: '_blank', rel: 'noreferrer', title: ticket.url }, `🔗 ${ticket.url}`)
                              : h('span', { className: 'aw-note' }, '—'),
                          ),
                          h('td', null, ticket.title),
                          h(
                            'td',
                            { className: 'is-num' },
                            ticket.hours === null || ticket.hours === undefined
                              ? h('span', { className: 'aw-note' }, '无工时')
                              : `${fmtHours(ticket.hours)}${ticket.note ? `（${ticket.note}）` : ''}`,
                          ),
                          h(
                            'td',
                            null,
                            ticketConfirm === ticket.id
                              ? h(
                                  'div',
                                  { className: 'aw-row-acts', style: { justifyContent: 'flex-end' } },
                                  h(
                                    Btn,
                                    {
                                      small: true,
                                      tone: 'danger',
                                      disabled: busy,
                                      title: `确认删除「${ticket.title}」`,
                                      onClick: () => {
                                        api.send('ticket_remove', { id: ticket.id });
                                        setTicketConfirm(null);
                                      },
                                    },
                                    '确认删除',
                                  ),
                                  h(Btn, { small: true, tone: 'ghost', onClick: () => setTicketConfirm(null) }, '取消'),
                                )
                              : h(
                                  'div',
                                  { className: 'aw-row-acts', style: { justifyContent: 'flex-end' } },
                                  h(IconBtn, {
                                    icon: 'edit',
                                    title: '修改这张工单',
                                    disabled: busy,
                                    onClick: () => setEditingTicket(ticket),
                                  }),
                                  h(IconBtn, {
                                    icon: 'trash',
                                    tone: 'danger',
                                    title: '删除这张工单',
                                    disabled: busy,
                                    onClick: () => setTicketConfirm(ticket.id),
                                  }),
                                ),
                          ),
                        ),
                      ]),
                    ),
                  ),
                ),
            view.tickets.length > 0
              ? h(
                  'div',
                  { className: 'aw-row-meta' },
                  `工单合计 ${fmtHours(view.ticketHours)}`,
                  `· 本月已录 ${fmtHours(view.loggedHours)} / 必须 ${fmtHours(view.requiredHours)}`,
                  view.gapHours > 0 ? `· 还差 ${fmtHours(view.gapHours)}` : '· 已达标',
                )
              : null,
          ),
        }),

        h(TicketEditor, { api, ticket: editingTicket, projects, busy, onClose: () => setEditingTicket(null) }),

        view.byProject.length > 0
          ? h(Card, {
              title: '按项目分布',
              children: h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
                view.byProject.map((row) =>
                  h(
                    'div',
                    { key: row.projectId || 'none', style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                    h('div', { className: 'aw-split-row' }, h('span', { className: 'aw-dot', style: { background: row.color } }), h('span', { style: { fontWeight: 600 } }, `${row.emoji} ${row.name}`), h('span', { className: 'aw-spacer' }), h('span', { className: 'aw-note' }, fmtHours(row.hours))),
                    h(Bar, { ratio: view.loggedHours > 0 ? row.hours / view.loggedHours : 0, style: { height: 6 } }),
                  ),
                ),
              ),
            })
          : null,
      );
    }

    /** 工单编辑器：改类型 / 日期 / 项目 / 小时 / 问题 / 链接 / 备注。 */
    function TicketEditor(props) {
      const { api, ticket, projects, busy, onClose } = props;
      const [editing, setEditing] = React.useState({ id: null, draft: null });

      if (!ticket) return null;

      const initial = (item) => ({
        type: item.type || '',
        date: item.date || localToday(),
        projectId: item.projectId || '',
        hours: item.hours === null || item.hours === undefined ? '' : String(item.hours),
        title: item.title || '',
        url: item.url || '',
        note: item.note || '',
      });

      const draft = editing.id === ticket.id && editing.draft ? editing.draft : initial(ticket);
      const set = (patch) => setEditing({ id: ticket.id, draft: { ...draft, ...patch } });

      const save = () => {
        const title = draft.title.trim();
        if (!title) return;
        api
          .send('ticket_update', {
            id: ticket.id,
            type: draft.type,
            date: draft.date,
            projectId: draft.projectId,
            hours: draft.hours === '' ? null : Number(draft.hours),
            title,
            url: draft.url,
            note: draft.note,
          })
          .then((result) => {
            if (result.ok) onClose();
          });
      };

      return h(
        'div',
        {
          className: 'aw-backdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'aw-modal' },
          h('h3', null, '修改工单'),
          h(
            'div',
            { className: 'aw-ticket-form' },
            h(Field, { label: '类型', style: { gridColumn: 'span 2' } },
              h('select', { className: 'aw-select', value: draft.type, onChange: (event) => set({ type: event.target.value }) },
                h('option', { value: '' }, '未指定'),
                TICKET_TYPES.map((value) => h('option', { key: value, value }, value)))),
            h(Field, { label: '日期', style: { gridColumn: 'span 2' } },
              h('input', { className: 'aw-input', type: 'date', value: draft.date, onChange: (event) => set({ date: event.target.value }) })),
            h(Field, { label: '项目', style: { gridColumn: 'span 2' } },
              h('select', { className: 'aw-select', value: draft.projectId, onChange: (event) => set({ projectId: event.target.value }) },
                h('option', { value: '' }, '无项目'),
                projects.map((project) => h('option', { key: project.id, value: project.id }, `${project.emoji}${project.name}`)))),
            h(Field, { label: '小时', style: { gridColumn: 'span 2' } },
              h('input', { className: 'aw-input', type: 'number', min: 0, max: MAX_TICKET_HOURS, step: 0.5, placeholder: '—', title: `留空表示「无工时」，最多 ${MAX_TICKET_HOURS}h`, value: draft.hours, onChange: (event) => set({ hours: event.target.value }) })),
            h(Field, { label: '问题 / 任务', style: { gridColumn: 'span 4' } },
              h('input', { className: 'aw-input', value: draft.title, autoFocus: true, onChange: (event) => set({ title: event.target.value }), onKeyDown: (event) => { if (event.key === 'Enter') save(); } })),
            h(Field, { label: '链接', style: { gridColumn: 'span 8' } },
              h('input', { className: 'aw-input', value: draft.url, onChange: (event) => set({ url: event.target.value }) })),
            h(Field, { label: '备注', style: { gridColumn: 'span 4' } },
              h('input', { className: 'aw-input', placeholder: '不改', value: draft.note, onChange: (event) => set({ note: event.target.value }) })),
          ),
          h(
            'div',
            { className: 'aw-form', style: { justifyContent: 'flex-end' } },
            h(Btn, { tone: 'ghost', onClick: onClose }, '取消'),
            h(Btn, { tone: 'primary', disabled: busy || !draft.title.trim(), onClick: save }, '保存'),
          ),
          h('div', { className: 'aw-note' }, '改小时数 / 日期 / 项目时，对应的工时台账条目会跟着重算，不会重复计。'),
        ),
      );
    }

    /* ================= 报表 ================= */

    function ReportsTab(props) {
      const api = props.api;
      const view = props.view;
      const busy = props.busy;
      const [dimension, setDimension] = React.useState('time');
      const [type, setType] = React.useState('weekly');
      const [date, setDate] = React.useState(localToday());
      // 周报区间：null 表示跟着 date 走（周五~周四），有值表示用户改过
      const [weekCustom, setWeekCustom] = React.useState(null);
      const [projectId, setProjectId] = React.useState('');
      const [status, setStatus] = React.useState('all');
      const [q, setQ] = React.useState('');
      const [selected, setSelected] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [editing, setEditing] = React.useState(false);
      // 9：选中的周报文件（配置了多个时才有下拉）
      const [targetFile, setTargetFile] = React.useState('');

      React.useEffect(() => {
        api.open('reports', { status, q });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [status, q]);

      const projects = (view && view.projects) || props.boot?.projects || [];
      const reportFiles = (props.boot && props.boot.settings && props.boot.settings.reportFiles) || [];
      const currentFile = targetFile && reportFiles.includes(targetFile) ? targetFile : reportFiles[0] || '';
      const shortName = (key) => String(key).split('/').pop();

      /** 打开一份报表并载入正文。 */
      const openReport = async (id) => {
        try {
          const response = await fetch(`${ROUTE}?view=report&id=${encodeURIComponent(id)}&today=${localToday()}`);
          const data = await response.json();
          if (data && data.ok) {
            setSelected(data.view);
            setDraft(data.view.content);
            setEditing(false);
          }
        } catch (error) {
          api.flash('error', `载入报表失败：${String(error.message || error)}`);
        }
      };

      // 只有「编辑中且和已保存的正文不一致」才需要保存按钮
      const dirty = Boolean(editing && selected && draft !== selected.content);

      const saveDraft = () =>
        api.send('report_save', { id: selected.id, content: draft }).then((result) => result.ok && openReport(selected.id));

      /** 把正文写进本机的周报汇总文件；有未保存的改动就先存下来，避免文件里是旧内容。 */
      const appendToFile = async () => {
        const target = currentFile;
        if (!target) return;
        if (dirty) {
          const saved = await api.send('report_save', { id: selected.id, content: draft });
          if (!saved || !saved.ok) return;
        }
        await api.send('report_append_file', { id: selected.id, path: target });
      };

      const generate = () => {
        const week = weekCustom ?? reportWeek(date);
        const payload =
          dimension === 'project'
            ? { type: 'project', projectId, date }
            : type === 'weekly' && weekCustom
              ? { type, date, from: week.from, to: week.to }
              : { type, date };
        if (dimension === 'project' && !projectId) {
          api.flash('warn', '项目维度需要先选一个项目');
          return;
        }
        api.send('report_create', payload).then((result) => {
          if (result.ok && result.data && result.data.id) openReport(result.data.id);
        });
      };

      if (!view || !Array.isArray(view.reports)) return h(Empty, null, '加载中…');
      // counts 只是三个计数：宿主万一没给，就从列表自己数，不要让整页卡在「加载中…」
      const counts = view.counts || {
        draft: view.reports.filter((item) => item.status === 'draft').length,
        final: view.reports.filter((item) => item.status === 'final').length,
        archived: view.reports.filter((item) => item.status === 'archived').length,
      };

      const statusTone = { archived: 'gold', final: 'ok', draft: undefined };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(Card, {
          title: '生成报表',
          extra: h(
            'span',
            { className: 'aw-split-row' },
            h(Btn, { small: true, on: dimension === 'time', onClick: () => setDimension('time') }, '时间维度'),
            h(Btn, { small: true, on: dimension === 'project', onClick: () => setDimension('project') }, '项目维度'),
          ),
          children: h(
            'div',
            { className: 'aw-form' },
            dimension === 'time'
              ? h(
                  'select',
                  { className: 'aw-select', value: type, onChange: (event) => setType(event.target.value) },
                  h('option', { value: 'weekly' }, '周报'),
                  h('option', { value: 'monthly' }, '月报'),
                  h('option', { value: 'yearly' }, '年报'),
                )
              : h(
                  'select',
                  { className: 'aw-select', value: projectId, onChange: (event) => setProjectId(event.target.value) },
                  h('option', { value: '' }, '选择项目…'),
                  projects.map((project) => h('option', { key: project.id, value: project.id }, `${project.emoji}${project.name}`)),
                ),
            dimension === 'time' && type === 'weekly'
              ? [
                  h('input', {
                    key: 'wf',
                    className: 'aw-input',
                    style: { width: 150 },
                    type: 'date',
                    value: (weekCustom ?? reportWeek(date)).from,
                    title: '周报区间起点（默认周五）',
                    onChange: (event) =>
                      setWeekCustom({ from: event.target.value, to: (weekCustom ?? reportWeek(date)).to }),
                  }),
                  h('span', { key: 'sep', className: 'aw-note' }, '~'),
                  h('input', {
                    key: 'wt',
                    className: 'aw-input',
                    style: { width: 150 },
                    type: 'date',
                    value: (weekCustom ?? reportWeek(date)).to,
                    title: '周报区间终点（默认周四）',
                    onChange: (event) =>
                      setWeekCustom({ to: event.target.value, from: (weekCustom ?? reportWeek(date)).from }),
                  }),
                  weekCustom
                    ? h(
                        Btn,
                        {
                          key: 'reset',
                          small: true,
                          tone: 'ghost',
                          onClick: () => setWeekCustom(null),
                          title: '回到「上周五 ~ 本周四」',
                        },
                        '回到默认',
                      )
                    : null,
                ]
              : h('input', {
                  className: 'aw-input',
                  type: 'date',
                  value: date,
                  onChange: (event) => {
                    setDate(event.target.value);
                    setWeekCustom(null);
                  },
                  title: dimension === 'time' ? '以这一天定位所在周 / 月 / 年' : '以这一天定位所在月',
                }),
            h(Btn, { tone: 'primary', disabled: busy, onClick: generate }, '生成草稿'),
            dimension === 'time' && type === 'weekly'
              ? h('span', { className: 'aw-note' }, '默认是「上周五 ~ 本周四」，可以自己改。')
              : h('span', { className: 'aw-note' }, '草稿从真实流水汇总而来；facts 会冻结进报表，之后补录不影响它。'),
          ),
        }),

        h(Card, {
          title: h(
            'span',
            { className: 'aw-split-row' },
            '报表库 ',
            h(Chip, { children: `草稿 ${counts.draft}` }),
            h(Chip, { tone: 'ok', children: `已定稿 ${counts.final}` }),
            h(Chip, { tone: 'gold', children: `已归档 ${counts.archived}` }),
          ),
          extra: h(
            'span',
            { className: 'aw-split-row' },
            h(
              'select',
              { className: 'aw-select', value: status, onChange: (event) => setStatus(event.target.value) },
              h('option', { value: 'all' }, '全部状态'),
              h('option', { value: 'draft' }, '草稿'),
              h('option', { value: 'final' }, '已定稿'),
              h('option', { value: 'archived' }, '已归档'),
            ),
            h('input', {
              className: 'aw-input',
              style: { width: 150 },
              placeholder: '搜索…',
              value: q,
              onChange: (event) => setQ(event.target.value),
            }),
            h(Btn, { small: true, tone: 'ghost', disabled: busy, onClick: () => api.send('report_archive_stale').then((result) => result.ok && api.reload()) }, '归档所有过期草稿'),
          ),
          children:
            view.reports.length === 0
              ? h(Empty, null, '还没有报表。上面选个范围点「生成草稿」。')
              : h(
                  'div',
                  { className: 'aw-list' },
                  view.reports.map((item) =>
                    h(
                      'div',
                      { className: `aw-rep${selected && selected.id === item.id ? ' is-on' : ''}`, key: item.id, onClick: () => openReport(item.id) },
                      h(
                        'div',
                        { className: 'aw-rep-main' },
                        h('div', { className: 'aw-rep-title' }, item.title),
                        h(
                          'div',
                          { className: 'aw-row-meta' },
                          h(Chip, { tone: statusTone[item.status], children: { draft: '草稿', final: '已定稿', archived: '已归档' }[item.status] }),
                          item.revision > 1 ? h('span', null, `v${item.revision}`) : null,
                          h('span', null, `${item.from} ~ ${item.to}`),
                          item.totals ? h('span', null, `${item.totals.done} 项 / ${fmtHours(item.totals.hours)}`) : null,
                          item.projectName ? h('span', null, item.projectName) : null,
                        ),
                      ),
                      h(Btn, { small: true, tone: 'ghost', onClick: (event) => { event.stopPropagation(); openReport(item.id); } }, '查看'),
                    ),
                  ),
                ),
        }),

        selected
          ? h(Card, {
              title: h(
                'span',
                { className: 'aw-split-row' },
                h('b', null, selected.title),
                h(Chip, { tone: statusTone[selected.status], children: { draft: '草稿', final: '已定稿', archived: '已归档' }[selected.status] }),
                selected.revision > 1 ? h(Chip, { children: `v${selected.revision}` }) : null,
              ),
              extra: h(
                'span',
                { className: 'aw-split-row' },
                h(Btn, { small: true, on: editing, onClick: () => setEditing(!editing), disabled: !selected.editable }, editing ? '预览' : '编辑'),
                // 保存只在「改了还没存」时出现，平时不占位置
                dirty
                  ? h(Btn, { small: true, tone: 'primary', disabled: busy, onClick: saveDraft }, '保存')
                  : null,
                reportFiles.length > 1
                  ? h(
                      'select',
                      { className: 'aw-select', title: '选要写进哪个周报文件', value: currentFile, onChange: (event) => setTargetFile(event.target.value) },
                      reportFiles.map((item) => h('option', { key: item, value: item }, shortName(item))),
                    )
                  : null,
                h(
                  Btn,
                  {
                    small: true,
                    tone: 'ghost',
                    disabled: busy || !selected.content || reportFiles.length === 0,
                    title: reportFiles.length === 0 ? '先到「设置」里配置周报文件（.md / .txt 绝对路径）' : `插入 ${shortName(currentFile)} 的最前面`,
                    onClick: appendToFile,
                  },
                  // 多个文件时左边有下拉选，按钮上就不重复文件名了
                  reportFiles.length === 1 ? `添加进周报文件 · ${shortName(currentFile)}` : '添加进周报文件',
                ),
                h(Btn, { small: true, tone: 'gold', disabled: busy || selected.status === 'archived', onClick: () => api.send('report_archive', { id: selected.id }).then((result) => result.ok && openReport(selected.id)) }, '归档'),
                h(Btn, {
                  small: true,
                  tone: 'danger',
                  disabled: busy || !selected.editable,
                  onClick: () => api.send('report_delete', { id: selected.id }).then((result) => { if (result.ok) setSelected(null); }),
                }, '删除'),
                h(Btn, { small: true, tone: 'ghost', onClick: () => setSelected(null) }, '关闭'),
              ),
              children: h(
                'div',
                { className: `aw-split${editing ? ' has-preview' : ''}` },
                editing
                  ? h('textarea', {
                      className: 'aw-textarea',
                      style: { minHeight: 380 },
                      value: draft,
                      onChange: (event) => setDraft(event.target.value),
                    })
                  : null,
                h('div', { className: 'aw-scroll', style: { maxHeight: 460 } }, h(Markdown, { text: editing ? draft : selected.content })),
              ),
            })
          : null,
      );
    }

    /* ================= 统计 ================= */

    /** 把 Date 变成 YYYY-MM-DD（本地时区，别用 toISOString 会串天）。 */
    function keyOf(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    /**
     * 周报的默认区间：「上周五 ~ 本周四」，也就是**已经过完的那一周**。
     * 终点取 key 当天或之前最近的周四，起点再往前推 6 天（与宿主 resolveReportRange 一致）。
     */
    function reportWeek(key) {
      const base = new Date(`${key}T00:00:00`);
      const safe = Number.isNaN(base.getTime()) ? new Date() : base;
      const back = (safe.getDay() - 4 + 7) % 7; // 0=周日 … 4=周四
      const to = new Date(safe);
      to.setDate(to.getDate() - back);
      const from = new Date(to);
      from.setDate(from.getDate() - 6);
      return { from: keyOf(from), to: keyOf(to) };
    }

    /** 本月的自然月起止（YYYY-MM-01 ~ 月末）。 */
    function thisMonthRange() {
      const today = localToday();
      const year = Number(today.slice(0, 4));
      const month = Number(today.slice(5, 7));
      const days = new Date(year, month, 0).getDate();
      return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${String(days).padStart(2, '0')}` };
    }

    function StatsTab(props) {
      const api = props.api;
      const view = props.view;
      const [dim, setDim] = React.useState('month');
      // 默认落在「本月」：进来先看这个月的完成情况，想看全年再点「本年」
      const [range, setRange] = React.useState(() => thisMonthRange());
      const [preset, setPreset] = React.useState('month');

      const applyPreset = (name) => {
        const today = localToday();
        const year = today.slice(0, 4);
        const month = today.slice(0, 7);
        const map = {
          month: thisMonthRange(),
          year: { from: `${year}-01-01`, to: `${year}-12-31` },
          days30: { from: shiftDay(today, -29), to: today },
          quarter: (() => {
            const q = Math.floor((Number(month.slice(5, 7)) - 1) / 3);
            const startMonth = String(q * 3 + 1).padStart(2, '0');
            const endMonth = String(q * 3 + 3).padStart(2, '0');
            const endDays = new Date(Number(year), q * 3 + 3, 0).getDate();
            return { from: `${year}-${startMonth}-01`, to: `${year}-${endMonth}-${String(endDays).padStart(2, '0')}` };
          })(),
        };
        setPreset(name);
        setRange(map[name] || map.year);
      };

      React.useEffect(() => {
        api.open('stats', { dim, from: range.from, to: range.to, heatmap: dim === 'year' ? '1' : '' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [dim, preset, range.from, range.to]);

      if (!view || !view.totals || !view.legs || !Array.isArray(view.buckets) || !Array.isArray(view.byProject)) {
        return h(Empty, null, '加载中…');
      }

      const peak = Math.max(1, ...view.buckets.map((bucket) => bucket.done));
      const totals = view.totals;
      const legs = view.legs;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(Card, {
          title: '范围',
          extra: h(
            'span',
            { className: 'aw-split-row' },
            h(Btn, { small: true, on: dim === 'day', onClick: () => setDim('day') }, '按天'),
            h(Btn, { small: true, on: dim === 'month', onClick: () => setDim('month') }, '按月'),
            h(Btn, { small: true, on: dim === 'year', onClick: () => setDim('year') }, '按年'),
          ),
          children: h(
            'div',
            { className: 'aw-form' },
            h(Btn, { small: true, on: preset === 'month', onClick: () => applyPreset('month') }, '本月'),
            h(Btn, { small: true, on: preset === 'quarter', onClick: () => applyPreset('quarter') }, '本季度'),
            h(Btn, { small: true, on: preset === 'year', onClick: () => applyPreset('year') }, '本年'),
            h(Btn, { small: true, on: preset === 'days30', onClick: () => applyPreset('days30') }, '近 30 天'),
            h('input', {
              className: 'aw-input',
              type: 'date',
              value: range.from,
              onChange: (event) => {
                const next = { ...range, from: event.target.value };
                setRange(next);
                setPreset('custom');
                api.open('stats', { dim, from: next.from, to: next.to, heatmap: dim === 'year' ? '1' : '' });
              },
            }),
            h('span', { className: 'aw-note' }, '~'),
            h('input', {
              className: 'aw-input',
              type: 'date',
              value: range.to,
              onChange: (event) => {
                const next = { ...range, to: event.target.value };
                setRange(next);
                setPreset('custom');
                api.open('stats', { dim, from: next.from, to: next.to, heatmap: dim === 'year' ? '1' : '' });
              },
            }),
          ),
        }),

        h(Card, {
          title: '汇总',
          children: h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h(
              'div',
              { className: 'aw-metrics' },
              h(Metric, { label: '完成', value: String(totals.done), unit: '项' }),
              h(Metric, { label: '新建', value: String(totals.created), unit: '项' }),
              h(Metric, { label: '完成率', value: pctText(totals.completionRate), tone: totals.completionRate >= 80 ? 'ok' : 'danger' }),
              h(Metric, { label: '按时完成率', value: pctText(totals.onTimeRate), tone: totals.onTimeRate >= 80 ? 'ok' : undefined }),
              h(Metric, { label: '顺延次数', value: String(totals.rolledOut) }),
              h(Metric, { label: '漏做 / 放弃', value: `${totals.missed} / ${totals.dropped}` }),
              h(Metric, { label: '投入工时', value: fmtHours(legs.loggedHours) }),
              h(Metric, { label: '必须工时', value: fmtHours(legs.requiredHours), hint: `法定工作日 ${legs.workdays} 天` }),
              h(Metric, { label: '工时达成率', value: pctText(legs.achievement), tone: legs.achievement >= 100 ? 'ok' : legs.achievement >= 80 ? undefined : 'danger' }),
            ),
            h(Bar, { ratio: legs.achievement / 100, tone: legs.achievement >= 100 ? undefined : 'gold' }),
          ),
        }),

        h(Card, {
          title: '完成数分布',
          children: h(
            'div',
            null,
            h(
              'div',
              { className: 'aw-trend', style: { height: 110 } },
              view.buckets.map((bucket) =>
                h(
                  'div',
                  { className: 'aw-trend-col', key: bucket.key, title: `${bucket.label}\n完成 ${bucket.done} · 计划 ${bucket.planned} · 完成率 ${bucket.completionRate}%\n工时 ${fmtHours(bucket.hours)}` },
                  h('div', { className: 'aw-note', style: { fontSize: 'var(--aw-fs-caption)' } }, bucket.done > 0 ? String(bucket.done) : ''),
                  h('div', { className: 'aw-trend-bar', style: { height: `${Math.max(2, (bucket.done / peak) * 100)}%` } }),
                  h('div', { className: 'aw-note', style: { fontSize: 'var(--aw-fs-caption)', whiteSpace: 'nowrap' } }, view.dim === 'day' ? bucket.label.slice(0, 5) : bucket.label),
                ),
              ),
            ),
          ),
        }),

        view.heatmap
          ? h(Card, {
              title: '热力图（颜色越深，当天完成越多）',
              children: h(
                'div',
                { style: { display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 4 } },
                h('div', { style: { display: 'grid', gridTemplateRows: 'repeat(7,11px)', gap: 2.5, paddingTop: 0 } },
                  ['一', '二', '三', '四', '五', '六', '日'].map((name) => h('div', { key: name, className: 'aw-note', style: { fontSize: 9, lineHeight: '11px' } }, name))),
                h(
                  'div',
                  { className: 'aw-heat' },
                  (() => {
                    const cells = [];
                    const lead = (view.heatmap[0].weekday + 6) % 7;
                    for (let i = 0; i < lead; i += 1) cells.push(h('div', { key: `p${i}`, className: 'aw-heat-cell', style: { visibility: 'hidden' } }));
                    for (const cell of view.heatmap) {
                      cells.push(
                        h('div', {
                          key: cell.date,
                          className: `aw-heat-cell${cell.level > 0 ? ` l${cell.level}` : ''}`,
                          title: `${cell.date} 完成 ${cell.count} 项 · ${fmtHours(cell.hours)}`,
                        }),
                      );
                    }
                    return cells;
                  })(),
                ),
              ),
            })
          : null,

        view.byProject.length > 0
          ? h(Card, {
              title: '按项目分布（工时）',
              children: h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
                view.byProject.map((row) =>
                  h(
                    'div',
                    { key: row.projectId || 'none', style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                    h('div', { className: 'aw-split-row' }, h('span', { className: 'aw-dot', style: { background: row.color } }), h('span', { style: { fontWeight: 600 } }, `${row.emoji} ${row.name}`), h('span', { className: 'aw-spacer' }), h('span', { className: 'aw-note' }, fmtHours(row.hours))),
                    h(Bar, { ratio: legs.loggedHours > 0 ? row.hours / legs.loggedHours : 0, style: { height: 6 } }),
                  ),
                ),
              ),
            })
          : null,
      );
    }

    /* ================= 设置 ================= */

    /** 把启动快照里的设置投影成可编辑草稿。 */
    function bootToDraft(boot) {
      if (!boot || !boot.settings) return null;
      return {
        dailyHours: String(boot.settings.dailyHours),
        gradeLabel: boot.settings.gradeLabel,
        gradeFactor: String(boot.settings.gradeFactor),
        rolloverPolicy: boot.settings.rolloverPolicy,
        recurringRollover: boot.settings.recurringRollover,
        reportFooter: boot.settings.reportFooter || '',
        reportFiles: (boot.settings.reportFiles || []).join('\n'),
        reportSignature: boot.settings.reportSignature ?? '',
        reportTemplate: boot.settings.reportTemplate || '',
      };
    }

    /**
     * 设置弹窗的内容：一行一项，左边名称、右边控件；分组标题 + 组间大留白。
     * 外框由 Modal 承担，这里只放内容，不再套一层卡片。
     */
    function SettingsModal(props) {
      const { api, boot, skin, onSkin, onClose, styleOk } = props;
      const [draft, setDraft] = React.useState(() => bootToDraft(boot));
      const [override, setOverride] = React.useState({ date: '', kind: 'holiday' });

      React.useEffect(() => {
        setDraft(bootToDraft(boot));
      }, [boot]);

      if (!draft) return h(Empty, null, '加载中…');
      const overrides = (boot && boot.settings.holidayOverrides) || {};
      const holiday = boot && boot.holiday;
      const save = () =>
        api
          .send('settings_update', {
            settings: {
              dailyHours: Number(draft.dailyHours),
              gradeLabel: draft.gradeLabel,
              gradeFactor: Number(draft.gradeFactor),
              rolloverPolicy: draft.rolloverPolicy,
              recurringRollover: draft.recurringRollover,
              reportFooter: draft.reportFooter,
              reportFiles: draft.reportFiles
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
              reportSignature: draft.reportSignature,
              reportTemplate: draft.reportTemplate,
            },
          })
          .then((result) => result.ok && api.reload());

      const clearAll = () => {
        const keys = Object.keys(overrides);
        if (keys.length === 0) return;
        Promise.all(keys.map((key) => api.send('holiday_override_clear', { date: key }))).then(() => api.reload());
      };

      return h(
        'div',
        { className: 'aw-set-body' },

        /* ── 外观 ── */
        h(
          SetGroup,
          { title: '外观' },
          h(
            SetRow,
            { label: '皮肤', hint: '切换整套配色，立即生效' },
            h(
              'select',
              { className: 'aw-select', 'aria-label': '皮肤', value: skin, onChange: (event) => onSkin(event.target.value) },
              SKINS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
            ),
          ),
        ),

        /* ── 工时口径 ── */
        h(
          SetGroup,
          { title: '工时口径' },
          h(
            SetRow,
            { label: '每日工时', hint: '一个法定工作日的标准工时' },
            h('input', {
              className: 'aw-input',
              type: 'number',
              min: 0.5,
              max: 24,
              step: 0.5,
              value: draft.dailyHours,
              onChange: (event) => setDraft({ ...draft, dailyHours: event.target.value }),
            }),
          ),
          h(
            SetRow,
            { label: '职级名称', hint: '只是显示用' },
            h('input', { className: 'aw-input', value: draft.gradeLabel, onChange: (event) => setDraft({ ...draft, gradeLabel: event.target.value }) }),
          ),
          h(
            SetRow,
            { label: '职级系数', hint: '必须工时 = 计划 × 系数' },
            h('input', {
              className: 'aw-input',
              type: 'number',
              min: 0.1,
              max: 5,
              step: 0.05,
              value: draft.gradeFactor,
              onChange: (event) => setDraft({ ...draft, gradeFactor: event.target.value }),
            }),
          ),
          h(
            SetRow,
            { wide: true },
            h(
              'div',
              { className: 'aw-set-note' },
              '口径说明：请假不扣减必须工时、上月盈亏不结转到下月 —— 必须工时永远等于「当月法定工作日 × 每日工时 × 职级系数」，稳定可预测。',
            ),
          ),
        ),

        /* ── 待办顺延 ── */
        h(
          SetGroup,
          { title: '待办顺延' },
          h(
            SetRow,
            { label: '未完成待办默认顺延策略' },
            h(
              'select',
              { className: 'aw-select', value: draft.rolloverPolicy, onChange: (event) => setDraft({ ...draft, rolloverPolicy: event.target.value }) },
              h('option', { value: 'always' }, '一律顺延到明天'),
              h('option', { value: 'backlog' }, '顺延但转入积压'),
              h('option', { value: 'never' }, '到期作废'),
            ),
          ),
          h(
            SetRow,
            { label: '重复任务实例的策略' },
            h(
              'select',
              { className: 'aw-select', value: draft.recurringRollover, onChange: (event) => setDraft({ ...draft, recurringRollover: event.target.value }) },
              h('option', { value: 'always' }, '一律顺延（当前选择）'),
              h('option', { value: 'never' }, '当天没做就算漏做'),
            ),
          ),
        ),

        /* ── 报表 ── */
        h(
          SetGroup,
          { title: '报表' },
          h(
            SetRow,
            { label: '报表落款 / 附加说明', hint: '渲染到报表末尾' },
            h('input', { className: 'aw-input', value: draft.reportFooter, onChange: (event) => setDraft({ ...draft, reportFooter: event.target.value }) }),
          ),
          h(
            SetRow,
            { label: '追加时的署名', hint: '写在日期后面，留空则不写' },
            h('input', {
              className: 'aw-input',
              placeholder: '团队',
              value: draft.reportSignature,
              onChange: (event) => setDraft({ ...draft, reportSignature: event.target.value }),
            }),
          ),
          h(
            SetRow,
            {
              wide: true,
              label: '自定义报表模板',
              hint: '留空用内置版式；支持 {{title}} / {{weeklyCompleted}} / {{nextWeek}} / {{completed}} / {{hours}} 等占位符',
              stacked: true,
            },
            h('textarea', {
              className: 'aw-textarea',
              rows: 5,
              placeholder: '本周完成：\n{{weeklyCompleted}}\n\n下周待办：\n{{nextWeek}}',
              value: draft.reportTemplate,
              onChange: (event) => setDraft({ ...draft, reportTemplate: event.target.value }),
            }),
          ),
          h(
            SetRow,
            { label: '周报汇总文件', hint: '每行一个绝对路径，.md 或 .txt', stacked: true },
            h('textarea', {
              className: 'aw-textarea',
              rows: 3,
              placeholder: '/Users/you/personal/0-日周月/周报.md',
              value: draft.reportFiles,
              onChange: (event) => setDraft({ ...draft, reportFiles: event.target.value }),
            }),
            h('div', { className: 'aw-set-note' }, '点报表里的「添加进周报文件」会把正文插到这些文件的最前面一条之前。'),
          ),
        ),

        /* ── 节假日与调休 ── */
        h(
          SetGroup,
          { title: '节假日与调休' },
          holiday
            ? h(
                SetRow,
                { label: '内置日历', stacked: true },
                h(
                  'div',
                  { className: 'aw-set-figs' },
                  h('div', { className: 'aw-set-fig' }, h('b', null, String(holiday.holidayCount)), h('span', null, '个法定节假日')),
                  h('div', { className: 'aw-set-fig' }, h('b', null, String(holiday.workdayCount)), h('span', null, '个调休上班日')),
                  h('div', { className: 'aw-set-fig is-range' }, h('b', null, `${holiday.minYear}–${holiday.maxYear}`), h('span', null, '年内置覆盖')),
                ),
              )
            : null,
          holiday && holiday.error ? h(SetRow, { wide: true }, h('div', { className: 'aw-set-note', style: { color: 'var(--danger)' } }, `数据加载异常：${holiday.error}`)) : null,
          h(
            SetRow,
            { label: '添加覆盖', hint: '公司额外放假 / 特殊作息' },
            h('input', { className: 'aw-input', type: 'date', value: override.date, onChange: (event) => setOverride({ ...override, date: event.target.value }) }),
            h(
              'select',
              { className: 'aw-select', value: override.kind, onChange: (event) => setOverride({ ...override, kind: event.target.value }) },
              h('option', { value: 'holiday' }, '算放假'),
              h('option', { value: 'workday' }, '算上班'),
            ),
            h(
              Btn,
              { disabled: !override.date, onClick: () => api.send('holiday_override_set', { date: override.date, kind: override.kind }).then((result) => result.ok && api.reload()) },
              '添加',
            ),
          ),
          h(
            SetRow,
            { wide: true },
            h('div', { className: 'aw-set-note' }, '新年份的节假日安排发布后，替换插件目录下的 data/china-holidays.json 即可；未覆盖的年份会明确告警，不会静默估算。'),
          ),
        ),

        /* ── 危险操作：删除类单独一组 ── */
        h(
          SetGroup,
          { title: '危险操作', tone: 'danger' },
          h(
            SetRow,
            { label: '已覆盖的日期', hint: Object.keys(overrides).length > 0 ? '点 × 逐条删除' : '还没有手工覆盖', stacked: true },
            Object.keys(overrides).length > 0
              ? h(
                  'div',
                  { className: 'aw-chips' },
                  Object.entries(overrides).map(([key, value]) =>
                    h(Chip, {
                      key,
                      tone: value === 'holiday' ? 'danger' : 'warn',
                      children: [
                        h('span', { key: 't' }, `${key} ${value === 'holiday' ? '放假' : '上班'}`),
                        h(
                          'span',
                          {
                            key: 'x',
                            title: '删除这条覆盖',
                            style: { marginLeft: 4, cursor: 'pointer' },
                            onClick: () => api.send('holiday_override_clear', { date: key }).then((result) => result.ok && api.reload()),
                          },
                          '×',
                        ),
                      ],
                    }),
                  ),
                )
              : null,
          ),
          h(
            SetRow,
            { label: '清除全部覆盖', hint: '删除所有手工设置的节假日 / 调休' },
            h(Btn, { tone: 'danger', disabled: Object.keys(overrides).length === 0, onClick: clearAll }, '清除全部'),
          ),
        ),

        /* 底部：版本 + 关闭 / 保存 */
        h(
          'div',
          { className: 'aw-set-foot' },
          h('div', { className: 'aw-set-meta' }, `界面版本 ${BUILD} · 样式${styleOk === null ? '未知' : styleOk ? '已生效' : '未生效'} · 如果样式不对，先完全退出 DSH 再打开`),
          h(Btn, { tone: 'ghost', onClick: onClose }, '关闭'),
          h(Btn, { tone: 'primary', onClick: save }, '保存设置'),
        ),
      );
    }

    /** 设置页的一组：标题 + 若干行。组间大留白，组内靠行本身撑开。 */
    function SetGroup(props) {
      return h(
        'section',
        { className: `aw-set-group${props.tone === 'danger' ? ' is-danger' : ''}` },
        h('h4', { className: 'aw-set-group-title' }, props.title),
        h('div', { className: 'aw-set-rows' }, props.children),
      );
    }

    /** 设置页的一行：左名称、右控件。 */
    function SetRow(props) {
      const className = `aw-set-row${props.wide ? ' is-wide' : ''}${props.stacked ? ' is-stacked' : ''}`;
      return h(
        'div',
        { className },
        h(
          'div',
          { className: 'aw-set-label' },
          h('span', null, props.label || ''),
          props.hint ? h('span', { className: 'aw-set-hint' }, props.hint) : null,
        ),
        props.label || props.hint ? h('div', { className: 'aw-set-ctl' }, props.children) : props.children,
      );
    }

    /* ================= 整页 ================= */

    const STYLE_ID = 'ai-workbench-style';

    /**
     * 把样式表挂到两个地方：
     *   1. document.head —— 常规情形；
     *   2. 面板自己的根节点 —— 面板万一渲染在 shadow root 里，或 React 把 <style> 提升走了，
     *      只有挂在根节点里的这一份才会生效。
     * 同一个 id 只建一次，重复调用只是同步文本。
     */
    function ensureStyle(root) {
      if (typeof document === 'undefined') return;
      const install = (parent) => {
        if (!parent) return;
        let node = parent.querySelector(`#${STYLE_ID}`);
        if (!node) {
          node = document.createElement('style');
          node.id = STYLE_ID;
          parent.appendChild(node);
        }
        if (node.textContent !== CSS) node.textContent = CSS;
      };
      install(document.head);
      install(root);
    }

    function WorkPage(props) {
      const api = props.api;
      const snap = useSnapshot(api);
      // initialTab 只有本地渲染台（test/browser）会传，用来给每个分页一个可截图的 URL；
      // DSH 里不传，行为与以前一致。
      const [tab, setTab] = React.useState(props.initialTab || 'today');
      const [month, setMonth] = React.useState(monthOf(localToday()));
      // initialSettings 同样只有本地渲染台会传：?settings=1 直接打开设置弹层，
      // 好让设置页也有一个可截图的 URL。
      const [settingsOpen, setSettingsOpen] = React.useState(!!props.initialSettings);
      // 皮肤放在最后：不改动前面 hooks 的下标，测试里靠下标预设状态的那些用例不受影响。
      const [skin, setSkin] = React.useState(() => readSkin(props.initialSkin));
      React.useEffect(() => {
        try {
          if (window.localStorage) window.localStorage.setItem(SKIN_KEY, skin);
        } catch (error) {
          /* 存不了就只在本次会话生效 */
        }
      }, [skin]);
      const pageRef = React.useRef(null);
      const [styleOk, setStyleOk] = React.useState(null);

      // 首次挂载：拉启动快照（分页内容由下面的 tab effect 负责）。
      React.useEffect(() => {
        api.refreshBoot();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [api]);

      // 分页切换时按需拉取。
      React.useEffect(() => {
        if (tab === 'today') api.open('today');
        else if (tab === 'projects') api.open('projects');
        else if (tab === 'hours') api.open('hours', { month });
        else if (tab === 'reports') api.open('reports', { status: 'all' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab]);

      // 跨零点时自动把「今天」推到新的一天。
      React.useEffect(() => {
        const timer = setInterval(() => {
          const now = localToday();
          if (now !== snap.today) {
            api.flash('warn', '跨天了，已切换到新的一天');
            // 以前是整页 reload；现在请求本身会带上新的 today，重新拉一次就够，不用丢滚动位置
            api.refreshBoot();
            api.reload();
          }
        }, 60000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [snap.today]);

      // 放在所有 hook 之后：不改动前面 use* 的下标
      React.useEffect(() => {
        const root = pageRef.current;
        ensureStyle(root);
        // 自检：面板底色到底有没有被样式表接管（没接管就是透明的）
        try {
          const bg = root ? getComputedStyle(root).backgroundColor : '';
          setStyleOk(Boolean(bg) && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent');
        } catch (error) {
          setStyleOk(null);
        }
      }, [skin]);

      const boot = snap.boot;
      const view = snap.viewName === tab ? snap.view : null;
      const tabs = [
        { id: 'today', label: '今日' },
        { id: 'projects', label: '项目' },
        { id: 'hours', label: '工时' },
        { id: 'reports', label: '报表' },
        { id: 'stats', label: '统计' },
      ];

      const flash = snap.flash;

      return h(
        'div',
        { className: 'aw-page', 'data-skin': skin, ref: pageRef },
        // 用 dangerouslySetInnerHTML 塞样式文本：React 对 <style> 的子节点处理在各版本里不一样，
        // 有的会做转义、有的会做 hoist/dedupe，一旦被丢掉整页就变成裸文字。
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'div',
          { className: 'aw-shell' },

          /* 左栏：品牌 + 导航 + 本月工时卡 */
          h(
            'aside',
            { className: 'aw-rail' },
            h(
              'div',
              { className: 'aw-brand' },
              h(ShuIcon, { active: true }),
              h(
                'div',
                null,
                h('div', { className: 'aw-brand-name' }, 'AI 工作台账'),
                h('div', { className: 'aw-brand-sub' }, '待办 · 工时 · 报表'),
              ),
            ),
            h(
              'nav',
              { className: 'aw-tabs', 'aria-label': '分页' },
              tabs.map((item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    className: `aw-tab${tab === item.id ? ' is-on' : ''}`,
                    'aria-current': tab === item.id ? 'page' : undefined,
                    onClick: () => setTab(item.id),
                  },
                  h(NavIcon, { name: item.id }),
                  h('span', null, item.label),
                ),
              ),
            ),
            boot
              ? h(
                  'div',
                  { className: 'aw-promo', title: '本月工时：已录 / 必须' },
                  h('div', { className: 'aw-promo-label' }, boot.hours.label),
                  h('div', { className: 'aw-promo-value' }, `${fmtHours(boot.hours.loggedHours)} / ${fmtHours(boot.hours.requiredHours)}`),
                  h('div', { className: 'aw-promo-bar' }, h('i', { style: { width: `${Math.min(100, Number(boot.hours.achievement) || 0)}%` } })),
                  h(
                    'div',
                    { className: 'aw-promo-note' },
                    h('span', null, `达成 ${pctText(boot.hours.achievement)}`),
                    boot.counts.draftReports > 0 ? h('span', null, `草稿 ${boot.counts.draftReports}`) : null,
                  ),
                  !boot.hours.coverage.complete
                    ? h('div', { className: 'aw-promo-note' }, `${boot.hours.coverage.uncoveredYears.join('、')} 年日历缺失`)
                    : null,
                )
              : null,
          ),

          /* 右侧内容 */
          h(
            'div',
            { className: 'aw-main' },
            h(
              'div',
              { className: 'aw-inner' },
              flash ? h('div', { className: `aw-flash is-${flash.kind}` }, flash.text) : null,

              h(
                'div',
                { className: 'aw-head' },
                h(
                  'div',
                  null,
                  h('div', { className: 'aw-crumb' }, `AI 工作台账 / ${(tabs.find((item) => item.id === tab) || tabs[0]).label}`),
                  // 今日页的标题就是那天本身（在 dayhead 里），这里不再重复一次
                  tab === 'today'
                    ? null
                    : h('div', { className: 'aw-title' }, h('span', null, TAB_TITLE[tab] || '今天')),
                ),
                h(
                  'div',
                  { className: 'aw-split-row' },
                  h('button', { type: 'button', className: 'aw-btn is-ghost', onClick: () => setSettingsOpen(true), title: '设置' }, '设置'),
                ),
              ),

                        snap.error
            ? h(Card, { children: h('div', { style: { color: 'var(--aw-danger)', fontWeight: 600 } }, `${snap.error}`) })
            : null,

          // 只把「确实属于当前分页」的视图喂给分页组件。切换分页时新数据还没到，
          // view 就是 null，各分页会退化成「加载中…」，而不是拿错数据崩掉。
          tab === 'today'
            ? h(TodayTab, { api, view, busy: snap.busy, boot, onGoHours: () => setTab('hours') })
              : tab === 'projects'
                ? h(ProjectsTab, { api, view, busy: snap.busy })
                : tab === 'hours'
                  ? h(HoursTab, {
                      api,
                      view,
                      busy: snap.busy,
                      boot,
                      month,
                      onMonth: (next) => {
                        setMonth(next);
                        api.open('hours', { month: next });
                      },
                    })
                  : tab === 'reports'
                    ? h(ReportsTab, { api, view, busy: snap.busy, boot })
                    : h(StatsTab, { api, view, busy: snap.busy }),

              h(
                'div',
                { className: 'aw-note', style: { textAlign: 'center', paddingTop: 10 } },
                snap.loading ? '加载中…' : '工作台账 · 数据全部保存在本机 ~/ai-workbench/state.json',
              ),
            ),
          ),
        ),

        /* 设置是弹窗：面板自身是唯一的框，里面不再套卡片 */
        h(Modal, {
          open: settingsOpen,
          className: 'is-settings',
          title: '设置',
          onClose: () => setSettingsOpen(false),
          children: h(SettingsModal, {
            api,
            boot,
            skin,
            onSkin: setSkin,
            styleOk,
            onClose: () => setSettingsOpen(false),
          }),
        }),

      );
    }

    /* ================= 插件 ================= */

    return {
      inject: ['slots'],
      apply(ctx) {
        const store = createStore();
        // 面板只认这个对象，所以它必须满足面板用到的全部契约：
        // getSnapshot / subscribe 是 useSnapshot 的依赖，漏掉任意一个都会让整页白屏。
        const api = {
          getSnapshot: store.getSnapshot,
          subscribe: store.subscribe,
          open: store.open,
          reload: store.reload,
          send: store.send,
          refreshBoot: store.refreshBoot,
          flash: store.flash,
        };

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => 'AI 工作台账' }, ShuIcon)),
          'ai-workbench: sidebar.panellist',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ api }) }, WorkPage)),
          'ai-workbench: main panel',
        );
      },
    };
  },
});
