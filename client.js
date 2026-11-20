/**
 * AI 工作台账 · AI Workbench — Client 半体（浏览器）。
 *
 * 注册两个槽位：
 *   - sidebar.panellist / id = ai-workbench  → 左侧全局面板图标
 *   - main / key = ai-workbench              → 中央整页工作台
 *
 * 四个分页：今日 / 项目 / 简报 / 统计（设置是右上角的齿轮弹层）。
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
     * 优先级 = 四象限。
     * 这套定义同时用在：新建待办的下拉选项、行内徽标的悬浮说明、表单一行的图例、
     * 看板的象限标题与副标题，以及 workbench_todo 工具的描述里 —— 只有这一处权威定义。
     */
    const PRIORITY_INFO = {
      P0: { short: '重要且紧急', action: '立即做', full: 'P0 重要且紧急 —— 立即做：线上故障、阻塞别人的事、当天必须交付' },
      P1: { short: '重要不紧急', action: '排期做', full: 'P1 重要不紧急 —— 排期做：本周内要交付，或别人在等你的产出' },
      P2: { short: '紧急不重要', action: '委派或批量处理', full: 'P2 紧急不重要 —— 委派或批量处理：能交出去，或攒一批一起做' },
      P3: { short: '不重要不紧急', action: '删除或归档', full: 'P3 不重要不紧急 —— 删除或归档：想做但不做的优化、可清理的杂事' },
    };

    /** 构建标记：设置弹层底部会显示，用来确认 DSH 到底加载了哪一版。 */
    const BUILD = 'v1.0.7 · 2026-11-20 · A62 默认进入看板';

    /** 每个分页的页标题（对应参考稿里的「Main Dashboard」）。 */
    const TAB_TITLE = { board: '看板', today: '今天', projects: '项目', reports: '简报', stats: '统计' };

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

    /** 「历史完成」先露多少条，其余点「展开全部」。 */
    const HISTORY_PAGE = 8;

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
 * build: v1.0.2 · A57 简报（生成改弹窗 + 项目分类口径 + 新版周报 + 报表改名简报）· A56 待办说明（新增待办补多行说明；「备注」统一改称「说明」，字段仍是 note）· A55 计划日退场 · A54 今日页密度收紧（统计卡 67px / 台账行 40px / 页头 32px，去掉重复的「今日待办」卡）· A53 新增待办弹层 · A52 设置改回弹窗（面板唯一框，一行一项，分组，删除单列）· A51 曾改整页 · A50 描边照抄 · A49 Pixso 校准 · A47 design.md 契约
 * sweep: 4 FAIL (gate 40, 输入框描边 1.26:1) — 用户明确要求照抄参考稿的 #E0E5F2，属有意偏离，非漏改
 * 其余 0 REFLEX · 0 WARN (app scope, 20 route×skin) · copy: verbatim · 可读性由「字段上方标签 + 占位符」承担
 * 与参考的偏差：参考用紫蓝渐变做「Upgrade to PRO」卡与柱图，这里一律用实色靛蓝（Hallmark 2a 禁紫蓝渐变） */
/* Hallmark · pre-emit critique: P4 H5 E4 S4 R4 V4 · weakest: P (这是模板化的后台语言) — 用「今日待办」做唯一的大数字、把今日待办放进侧栏，让首屏仍回答「今天做什么」 */

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
  /* 四象限配色：重要且紧急=红 · 重要不紧急=蓝 · 紧急不重要=黄 · 不重要不紧急=灰 */
  --q0:oklch(58% 0.20 25); --q1:oklch(55% 0.17 258); --q2:oklch(74% 0.15 82); --q3:oklch(60% 0.012 265);
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
  --q0:oklch(48% 0.18 27); --q1:oklch(46% 0.13 245); --q2:oklch(58% 0.11 70); --q3:oklch(52% 0.015 235);
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
  --q0:oklch(74% 0.16 25); --q1:oklch(74% 0.13 258); --q2:oklch(85% 0.13 82); --q3:oklch(70% 0.015 262);
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
  --q0:oklch(52% 0.19 27); --q1:oklch(48% 0.14 250); --q2:oklch(62% 0.12 75); --q3:oklch(52% 0.012 200);
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
.aw-inner{flex:1 1 auto;min-height:0;overflow-y:auto;width:100%;max-width:1180px;padding:20px 24px 48px;display:flex;flex-direction:column;gap:16px}
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
  .aw-inner{padding:14px 16px 40px;gap:12px}
}

/* ── 页头：面包屑 + 标题 + 动作 ────────────────────────────── */
.aw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:0}
.aw-crumb{font-size:11.5px;color:var(--muted);margin-bottom:2px}
.aw-title{display:flex;align-items:center;gap:10px;font-size:var(--fs-head);font-weight:600;letter-spacing:-.02em;line-height:1.15;color:var(--ink)}
.aw-title small{font-size:12.5px;font-weight:400;color:var(--muted);letter-spacing:0;padding-left:10px;border-left:1px solid var(--rule-2)}
.aw-ledger{font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}
.aw-ledger b{color:var(--ink);font-weight:600}
.aw-ledger .is-quiet{color:var(--accent)}
.aw-ledger .is-danger{color:var(--danger);font-weight:500}

/* ── 首屏 ───────────────────────────────────────────────────── */
.aw-dayhead{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:4px 24px;padding:0}
@media (max-width:700px){.aw-dayhead{grid-template-columns:minmax(0,1fr)}}
.aw-dayhead-date{font-size:var(--fs-display);font-weight:600;letter-spacing:-.025em;line-height:1.1;color:var(--ink);margin:0}
.aw-dayhead-week{font-size:var(--fs-meta);color:var(--muted);margin-top:4px;display:flex;gap:12px;flex-wrap:wrap}
.aw-dayhead-fig{display:flex;align-items:baseline;gap:12px;justify-self:end}
@media (max-width:700px){.aw-dayhead-fig{justify-self:start}}
.aw-dayhead-num{font-size:var(--fs-display);font-weight:600;letter-spacing:-.03em;line-height:1;color:var(--accent)}
.aw-dayhead-label{font-size:var(--fs-meta);color:var(--muted)}
.aw-caption{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;font-size:var(--fs-meta);color:var(--muted)}
.aw-caption .num{color:var(--ink);font-weight:600}
.aw-caption .is-danger{color:var(--danger);font-weight:600}
.aw-caption .is-warn{color:var(--warn);font-weight:600}
.aw-daybar{grid-column:1/-1;height:8px;border-radius:999px;background:var(--paper-3);overflow:hidden;margin-top:8px}
.aw-daybar>i{display:block;height:100%;border-radius:999px;background:var(--accent);transition:width 220ms linear}

/* ── 卡片：白底 + 20px 圆角 + 极柔阴影 ─────────────────────── */
.aw-board,.aw-card{background:var(--paper-2);border:0;border-radius:var(--r-card);box-shadow:var(--shadow-soft);position:relative}
.aw-board{box-shadow:var(--shadow);overflow:hidden}
.aw-card{padding:22px 24px}
.aw-sec{border-top:1px solid var(--rule);padding:12px 20px 12px}
.aw-sec.is-first{border-top:0;padding-top:16px}
.aw-sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:6px;flex-wrap:wrap}
.aw-sec-title{font-size:var(--fs-title);font-weight:600;color:var(--ink);display:inline-flex;align-items:baseline;gap:8px;min-width:0;letter-spacing:-.01em}
.aw-sec-title b{color:var(--ink);font-size:var(--fs-meta);font-weight:600;background:var(--paper-3);border-radius:999px;padding:1px 9px}
.aw-sec-title .aw-note{font-weight:400}
.aw-sec-extra{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:var(--fs-caption);color:var(--muted)}
.aw-sec-body{display:flex;flex-direction:column;gap:8px}
.aw-card-title{font-size:var(--fs-title);font-weight:600;color:var(--ink);display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap;letter-spacing:-.01em}
.aw-card-title b{color:var(--ink);font-size:var(--fs-meta);font-weight:600;background:var(--paper-3);border-radius:999px;padding:1px 9px}
.aw-grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.aw-composer .aw-field{max-width:520px}

/* ── 台账行 ─────────────────────────────────────────────────── */
.aw-list{display:flex;flex-direction:column}
.aw-list>.aw-row+.aw-row{border-top:1px solid var(--rule)}
.aw-row{display:flex;align-items:center;gap:10px;padding:4px 8px;min-height:40px;border-radius:var(--r-inner);overflow:hidden;transition:background 120ms linear}
.aw-row:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}
.aw-row-title{font-weight:500;font-size:var(--fs-body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;line-height:var(--lh-tight);color:var(--ink)}
.aw-row-main{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:12px}
.aw-row-meta{display:flex;align-items:center;gap:10px;font-size:var(--fs-caption);color:var(--muted);flex:0 1 auto;min-width:0;white-space:nowrap}
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
.aw-empty{padding:24px 20px;text-align:center;color:var(--muted);font-size:var(--fs-meta)}

/* ── 统计卡：白底小卡，数字大 ───────────────────────────────── */
.aw-metrics{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
.aw-metric{background:var(--paper-2);border-radius:var(--r-card);box-shadow:var(--shadow-soft);padding:12px 16px;
  display:flex;align-items:center;gap:12px;min-width:0}
.aw-metric-tile{flex:0 0 auto;width:40px;height:40px;border-radius:999px;background:var(--accent-soft);color:var(--accent);
  display:inline-flex;align-items:center;justify-content:center}
.aw-metric.is-danger .aw-metric-tile{background:color-mix(in srgb,var(--danger) 12%,var(--paper-2));color:var(--danger)}
.aw-metric-body{min-width:0}
.aw-metric-label{font-size:var(--fs-caption);color:var(--muted);font-weight:400;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.aw-metric-value{font-size:var(--fs-figure);font-weight:600;letter-spacing:-.025em;line-height:1.15;margin-top:0;white-space:nowrap;color:var(--ink)}
.aw-metric-value small{font-size:var(--fs-caption);font-weight:500;color:var(--muted);margin-left:3px;letter-spacing:0}
.aw-metric.is-danger .aw-metric-value{color:var(--danger)}
.aw-metric.is-ok .aw-metric-value{color:var(--accent)}
@media (max-width:760px){.aw-metrics{gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.aw-metric{padding:12px 14px}.aw-metric-tile{display:none}}

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
/* 选中态不能被 hover 冲掉：鼠标停在选中的分段上时仍然是靛蓝实心（分隔段看图看不清状态） */
.aw-btn.is-on:hover:not(:disabled){background:var(--accent-hi);color:var(--on-accent)}
.aw-btn.is-small{height:32px;padding:0 12px;font-size:var(--fs-caption);font-weight:600}

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
/* 分段开关：选项平分整行、与输入框同高，竖排表单里不出现矮一档的控件 */
.aw-seg{display:flex;gap:8px}
.aw-seg .aw-btn{flex:1 1 0;height:var(--ctl-h)}
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

.aw-fold{margin-top:8px;border-top:1px solid var(--rule);padding-top:8px}
.aw-fold-head{appearance:none;border:0;background:transparent;font:inherit;font-size:var(--fs-meta);font-weight:500;color:var(--muted);
  cursor:pointer;display:flex;align-items:center;justify-content:space-between;width:100%;min-height:36px;padding:0;gap:8px}
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

/* ── 看板：四象限 ───────────────────────────────────────────── */
/* 卡片 38px、象限 16px 内边距、2×2 满高；象限内部滚动，页面本身不变长 */
.aw-kb{flex:1 1 auto;display:flex;flex-direction:column;gap:14px;min-height:0}
.aw-kb-scope{display:flex;gap:2px;padding:3px;border-radius:999px;background:var(--paper-3)}
.aw-kb-scope .aw-btn{height:30px;padding:0 16px;border-radius:999px;background:transparent;box-shadow:none;color:var(--ink-2)}
.aw-kb-scope .aw-btn:hover:not(:disabled){background:color-mix(in srgb,var(--ink) 7%,transparent);color:var(--ink)}
.aw-kb-scope .aw-btn.is-on,.aw-kb-scope .aw-btn.is-on:hover:not(:disabled){background:var(--accent);color:var(--on-accent)}
.aw-kb-grid{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:16px}
.aw-q{position:relative;display:flex;flex-direction:column;gap:12px;min-height:0;padding:16px;border-radius:var(--r-card);
  background:var(--paper-2);box-shadow:var(--shadow-soft);border:1px dashed transparent;
  transition:box-shadow 140ms linear}
.aw-q.is-over{box-shadow:0 14px 34px -20px color-mix(in srgb,var(--accent) 60%,transparent),var(--shadow-soft)}
.aw-q.is-over::after{content:'';position:absolute;inset:-4px;border-radius:calc(var(--r-card) + 4px);
  border:2px dashed var(--accent);pointer-events:none;animation:awPulse 1.2s ease-in-out infinite}
@keyframes awPulse{0%,100%{opacity:.4}50%{opacity:1}}
.aw-q-head{display:flex;align-items:flex-start;gap:10px}
.aw-q-dot{flex:0 0 auto;width:10px;height:10px;margin-top:6px;border-radius:999px;background:var(--muted)}
.aw-q.is-p0 .aw-q-dot{background:var(--q0)}
.aw-q.is-p1 .aw-q-dot{background:var(--q1)}
.aw-q.is-p2 .aw-q-dot{background:var(--q2)}
.aw-q.is-p3 .aw-q-dot{background:var(--q3)}
.aw-q-text{flex:1 1 auto;min-width:0}
.aw-q-title{font-size:var(--fs-title);font-weight:600;line-height:1.3;letter-spacing:-.01em;color:var(--ink)}
.aw-q-sub{font-size:11.5px;color:var(--muted);margin-top:1px}
.aw-q-badge{flex:0 0 auto;margin-top:2px;padding:2px 9px;border-radius:999px;background:var(--paper-3);
  font-size:11px;font-weight:600;color:var(--ink-2);white-space:nowrap}
.aw-q-add{flex:0 0 auto;appearance:none;cursor:pointer;width:26px;height:26px;border:0;border-radius:999px;
  background:var(--paper-3);color:var(--ink-2);font-size:16px;line-height:1;
  display:inline-flex;align-items:center;justify-content:center;
  transition:background 120ms linear,color 120ms linear}
.aw-q-add:hover{background:var(--accent);color:var(--on-accent)}
.aw-q-add:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.aw-q-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:1px 2px 1px 0}
.aw-q-empty{padding:20px 0 0;text-align:center;font-size:12px;color:var(--muted)}

.aw-kcard{position:relative;flex:0 0 auto;display:flex;align-items:center;gap:10px;height:38px;padding:0 12px 0 0;
  border-radius:8px;background:color-mix(in srgb,var(--paper-3) 52%,var(--paper-2));cursor:grab;user-select:none;touch-action:none;
  transition:background 120ms linear,box-shadow 140ms linear,transform 180ms cubic-bezier(.2,.7,.2,1)}
.aw-kcard:hover{background:color-mix(in srgb,var(--accent) 7%,var(--paper-2))}
.aw-kcard:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.aw-kcard.is-sel{background:color-mix(in srgb,var(--accent) 6%,var(--paper-2));box-shadow:0 0 0 2px var(--accent)}
.aw-kcard.is-drag{opacity:.28;cursor:grabbing}
.aw-kcard.is-landed{animation:awLand 200ms ease-out}
@keyframes awLand{0%{transform:scale(1.015)}100%{transform:scale(1)}}
.aw-kcard-bar{flex:0 0 auto;width:3px;height:18px;border-radius:0 3px 3px 0;background:var(--muted)}
.aw-q.is-p0 .aw-kcard-bar,.aw-kb-ghost.is-p0 .aw-kcard-bar{background:var(--q0)}
.aw-q.is-p1 .aw-kcard-bar,.aw-kb-ghost.is-p1 .aw-kcard-bar{background:var(--q1)}
.aw-q.is-p2 .aw-kcard-bar,.aw-kb-ghost.is-p2 .aw-kcard-bar{background:var(--q2)}
.aw-q.is-p3 .aw-kcard-bar,.aw-kb-ghost.is-p3 .aw-kcard-bar{background:var(--q3)}
.aw-kcard-title{flex:1 1 auto;min-width:0;font-size:13px;font-weight:500;color:var(--ink);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aw-kcard-due{flex:0 0 auto;font-size:11px;color:var(--muted);white-space:nowrap}
.aw-kcard-due.is-overdue{color:var(--danger);font-weight:600}
.aw-kcard-due.is-none{color:color-mix(in srgb,var(--muted) 62%,var(--paper-2))}
.aw-kcard-note{flex:0 0 auto;width:4px;height:4px;border-radius:999px;background:var(--muted);opacity:.75}
.aw-kcard-tip{position:absolute;left:8px;right:8px;top:calc(100% + 6px);z-index:32;padding:8px 10px;border-radius:10px;
  background:var(--paper-2);border:1px solid var(--rule-2);box-shadow:var(--shadow);color:var(--ink-2);
  font-size:11.5px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
  opacity:0;visibility:hidden;pointer-events:none;transition:opacity 120ms linear 400ms,visibility 0s linear 400ms}
.aw-kcard:hover .aw-kcard-tip{opacity:1;visibility:visible}
.aw-q-drop{flex:0 0 auto;height:38px;border-radius:8px;border:1px dashed var(--accent);
  background:color-mix(in srgb,var(--accent) 7%,transparent);color:var(--accent);
  font-size:11.5px;font-weight:500;display:flex;align-items:center;justify-content:center}
.aw-kb-ghost{position:fixed;z-index:80;pointer-events:none;display:flex;align-items:center;gap:10px;height:38px;
  padding-right:12px;border-radius:8px;overflow:hidden;background:var(--paper-2);transform:rotate(1deg);
  box-shadow:0 18px 36px -16px color-mix(in srgb,var(--ink) 38%,transparent),0 0 0 1px var(--rule-2)}
.aw-kb-toast{position:fixed;left:50%;bottom:26px;z-index:82;transform:translateX(-50%);display:flex;align-items:center;gap:10px;
  height:40px;padding:0 8px 0 14px;border-radius:10px;background:var(--ink);color:var(--paper-2);
  font-size:12px;box-shadow:var(--shadow);animation:awToastIn 180ms ease-out}
@keyframes awToastIn{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
.aw-kb-toast-check{flex:0 0 auto;width:16px;height:16px;border-radius:999px;background:var(--ok);
  color:var(--paper-2);font-size:10px;line-height:16px;text-align:center}
.aw-kb-undo{appearance:none;cursor:pointer;border:0;border-radius:6px;font:inherit;font-size:12px;font-weight:600;
  color:inherit;background:color-mix(in srgb,var(--paper-2) 18%,transparent);height:26px;padding:0 10px}
.aw-kb-undo:hover{background:color-mix(in srgb,var(--paper-2) 30%,transparent)}
.aw-kb-undo:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
@media (max-width:900px){
  .aw-kb-grid{grid-template-columns:1fr;grid-template-rows:none;gap:12px}
  .aw-q{min-height:170px}
}
@media (prefers-reduced-motion: reduce){.aw-kcard,.aw-q.is-over::after,.aw-kb-toast{animation:none;transition:none}}

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
      async function send(action, payload, options = {}) {
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
          // 拖拽 / 切口径这类高频操作用 silent：界面上已经有自己的反馈（落点提示、分段按钮），
          // 再弹一条全局提示只会吵。
          if (data.result.message && !options.silent) flash('info', data.result.message);
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
      board: ['M2.8 2.8h4.4v4.4H2.8z', 'M8.8 2.8h4.4v4.4H8.8z', 'M2.8 8.8h4.4v4.4H2.8z', 'M8.8 8.8h4.4v4.4H8.8z'],
      today: ['M3 7.5 8 3l5 4.5', 'M4.5 7v6.5h7V7', 'M6.5 13.5v-3.2h3v3.2'],
      projects: ['M2.8 4.6h4l1.2 1.6h5.2v6.2H2.8z'],
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
      chart: ['M2.8 13.2h10.4', 'M4.4 13.2V8.4', 'M8 13.2V4.6', 'M11.6 13.2v-3.4'],
    };

    /** 没显式给图标时，按标签猜一个，保证每张统计卡都有图标块。 */
    function iconForLabel(label) {
      const text = String(label || '');
      if (/率|缺口|差|节拍/.test(text)) return 'chart';
      if (/截止|提醒/.test(text)) return 'clock';
      if (/逾期|超期/.test(text)) return 'alert';
      if (/草稿|报表|简报/.test(text)) return 'draft';
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
      const color = 'currentColor';
      return h(
        'svg',
        { width: 26, height: 26, viewBox: '0 0 32 32', 'aria-hidden': true, fill: 'none' },
        h('rect', {
          x: 2, y: 2, width: 28, height: 28, rx: 8,
          fill: color,
          fillOpacity: active ? 0.2 : 0.12,
          stroke: color,
          strokeWidth: 1.9,
        }),
        h('path', {
          d: 'M11 8v16',
          stroke: color,
          strokeWidth: 1.2,
          strokeOpacity: 0.45,
        }),
        h('path', {
          d: 'm14.5 12 1.6 1.7 2.8-3',
          fill: 'none',
          stroke: color,
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M21.8 12h1.9',
          stroke: color,
          strokeWidth: 1.3,
          strokeOpacity: 0.7,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'm14.5 19 1.6 1.7 2.8-3',
          fill: 'none',
          stroke: color,
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M21.8 19h1.9',
          stroke: color,
          strokeWidth: 1.3,
          strokeOpacity: 0.7,
          strokeLinecap: 'round',
        }),
      );
    }

    /* ================= 今日（已合并原「待办」页） ================= */

    /**
     * 今日页 = 每天真正会用的那一屏，只有三节：
     *   1. 今日待办（所有未完成待办，没做完就一直留在这里）
     *   2. 新增待办（含重复任务模板的管理）
     *   3. 本周完成（绿色打勾）
     * 这一屏只回答「今天做什么」。
     */
    function TodayTab(props) {
      const api = props.api;
      const view = props.view;
      const busy = props.busy;
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
      // 顶部一排统计卡：本周完成 / 逾期 /（有草稿时）待归档草稿
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
        boot && boot.counts.draftReports > 0
          ? { label: '待归档草稿', value: String(boot.counts.draftReports), unit: '份', icon: 'draft' }
          : null,
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

        // 一排统计卡：本周完成 / 逾期 /（有草稿时）待归档草稿
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
                      onDrop: () => send('todo_drop', { id: todo.id, reason: '不做' }),
                      onDelete: () => send('todo_delete', { id: todo.id }),
                      onProgress: (progress) => send('todo_update', { id: todo.id, progress }),
                      onEdit: () => setEditing(todo),
                    }),
                  ),
                ),
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
                        ),
                      ),
                      todo.note ? h('span', { className: 'aw-note', title: todo.note }, '说明') : null,
                      h(
                        'div',
                        { className: 'aw-row-acts' },
                        h(Btn, { small: true, tone: 'ghost', disabled: busy, title: '修改标题 / 项目 / 说明…', onClick: () => setEditing(todo) }, '编辑'),
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
                      todo.note ? h('span', { className: 'aw-note', title: todo.note }, '说明') : null,
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
        todo.note ? h('span', { key: 'note', title: todo.note, style: { cursor: 'help' } }, '说明') : null,
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
                    title: '进度 / 放弃 / 删除',
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
                        title: '修改标题 / 项目 / 说明 / 截止日…',
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
        priority: item.priority || 'P1',
        dueDate: item.dueDate || '',
        progress: String(item.progress ?? 0),
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
          dueDate: draft.dueDate,
        };
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
            { label: '说明' },
            h('textarea', {
              className: 'aw-textarea',
              rows: 3,
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
              ? '这条已经完成：改标题 / 项目 / 说明都会同步到周报与统计。'
              : '完成度会写进周报的「1.事项名（30%）」；不填就按 30% 计。',
          ),
        ),
      );
    }

    /* ================= 今日页复用：新建表单 / 重复任务 ================= */

    function TodoCreator(props) {
      const api = props.api;
      const busy = props.busy;
      // priority 可由上层指定（看板每个象限的「+」直接落到该象限），默认 P1 重要不紧急。
      const initialPriority = PRIORITIES.includes(props.priority) ? props.priority : 'P1';
      const [draft, setDraft] = React.useState({
        title: '',
        note: '',
        projectId: '',
        priority: initialPriority,
        dueDate: '',
        repeatOn: false,
        freq: 'workdays',
        weekdays: [],
        monthDays: '',
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
            note: draft.note,
            projectId: draft.projectId || null,
            priority: draft.priority,
            dueDate: draft.dueDate || null,
            repeat,
          })
          .then((result) => {
            if (result.ok) {
              set({ title: '', note: '' });
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
          { label: '说明' },
          h('textarea', {
            className: 'aw-textarea',
            rows: 3,
            placeholder: '补充背景、验收标准…',
            value: draft.note,
            onChange: (event) => set({ note: event.target.value }),
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
            {
              className: 'aw-select',
              value: draft.priority,
              // 从看板象限的「+」进来时优先级已定死：要改就拖卡片，不在这里改
              title: props.lockPriority ? '从该象限新建，优先级已固定；想换象限请直接拖动卡片' : PRIORITY_TIP,
              disabled: !!props.lockPriority,
              onChange: (event) => set({ priority: event.target.value }),
            },
            PRIORITIES.map((value) => h('option', { key: value, value }, `${value} · ${PRIORITY_INFO[value].short}`)),
          ),
        ),
        h(
          Field,
          { label: '截止日期' },
          h('input', {
            className: 'aw-input',
            type: 'date',
            value: draft.dueDate,
            onChange: (event) => set({ dueDate: event.target.value }),
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

    /* ================= 看板（四象限） ================= */

    /** 看板的分类口径按钮。 */
    const BOARD_SCOPES = [
      { id: 'all', label: '全部' },
      { id: 'work', label: '仅工作' },
      { id: 'personal', label: '仅个人' },
    ];

    /**
     * 四象限看板。
     *
     * 交互：单击只是选中（视觉高亮），双击编辑；按住拖动排序，跨象限即改优先级。
     * 不用 HTML5 dragstart/drop —— 它给不了「虚线落点 + 松手轻微回弹」，触屏上也不稳。
     * 这里用 Pointer Events + 指针捕获：按下时 setPointerCapture，之后手指/鼠标移出卡片
     * 仍然能收到 move / up，落点由各象限列表的矩形算出来。
     */
    function BoardTab(props) {
      const { api, view, busy, boot } = props;
      // hook 下标是测试预设状态用的契约：
      // 0 selected / 1 drag / 2 landed / 3 toast / 4 adding / 5 addPriority / 6 editingId
      const [selected, setSelected] = React.useState(null);
      const [drag, setDrag] = React.useState(null);
      const [landed, setLanded] = React.useState(null);
      const [toast, setToast] = React.useState(null);
      const [adding, setAdding] = React.useState(false);
      const [addPriority, setAddPriority] = React.useState('P1');
      const [editingId, setEditingId] = React.useState(null);
      const [flipTick, setFlipTick] = React.useState(0);

      const dragRef = React.useRef(null);
      const pendingRef = React.useRef(null);
      const flipRef = React.useRef(null);
      const boardRef = React.useRef(null);
      // 卡片 / 象限列表的 DOM，拖动时用来算落点与做 FLIP
      const cardsRef = React.useRef({});
      const listsRef = React.useRef({});

      // 落定回弹 240ms 后摘掉，下一次移动还能再触发
      React.useEffect(() => {
        if (!landed) return undefined;
        const timer = setTimeout(() => setLanded(null), 240);
        return () => clearTimeout(timer);
      }, [landed]);

      // 移动提示 4 秒后自动消失（撤销就在这 4 秒里有效）
      React.useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(timer);
      }, [toast]);

      // FLIP：位置变化的那一帧，先按旧位置画出来，再用 transform 过渡回去 —— 卡片会「让开」
      React.useEffect(() => {
        const before = flipRef.current;
        if (!before) return;
        flipRef.current = null;
        if (typeof requestAnimationFrame !== 'function') return;
        for (const id of Object.keys(cardsRef.current)) {
          const el = cardsRef.current[id];
          const prev = before[id];
          if (!el || !prev || typeof el.getBoundingClientRect !== 'function' || !el.style) continue;
          const now = el.getBoundingClientRect();
          const dy = prev.top - now.top;
          if (Math.abs(dy) < 1) continue;
          el.style.transition = 'none';
          el.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => {
            el.style.transition = 'transform 180ms cubic-bezier(.2,.7,.2,1)';
            el.style.transform = 'translateY(0)';
          });
        }
      }, [flipTick]);

      // 选中的卡片支持 Delete 删除、Esc 取消选中；点卡片以外的任何地方也取消
      React.useEffect(() => {
        if (!selected || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onDown = (event) => {
          const target = event && event.target;
          if (target && typeof target.closest === 'function' && target.closest('[data-card-id]')) return;
          setSelected(null);
        };
        if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
          document.addEventListener('pointerdown', onDown);
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setSelected(null);
            return;
          }
          if (event.key !== 'Delete' && event.key !== 'Backspace') return;
          const tag = String((event.target && event.target.tagName) || '').toLowerCase();
          if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          api.send('todo_delete', { id: selected });
          setSelected(null);
        };
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('keydown', onKey);
          if (typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
            document.removeEventListener('pointerdown', onDown);
          }
        };
      }, [selected, api]);

      /** 记录一次卡片位置快照（FLIP 用）。 */
      function snapshotCards() {
        const map = {};
        for (const id of Object.keys(cardsRef.current)) {
          const el = cardsRef.current[id];
          if (el && typeof el.getBoundingClientRect === 'function') {
            const rect = el.getBoundingClientRect();
            map[id] = { top: rect.top, left: rect.left };
          }
        }
        return map;
      }

      /** 指针在哪个象限、落在第几个位置；不在任何象限里就返回 null。 */
      function dropTargetAt(x, y, movingId) {
        let hit = null;
        for (const priority of Object.keys(listsRef.current)) {
          const el = listsRef.current[priority];
          if (!el || typeof el.getBoundingClientRect !== 'function') continue;
          const rect = el.getBoundingClientRect();
          // 上下各放宽 10px，贴着边缘也不至于落空
          if (x >= rect.left && x <= rect.right && y >= rect.top - 10 && y <= rect.bottom + 10) {
            hit = priority;
            break;
          }
        }
        if (!hit) return null;
        const listEl = listsRef.current[hit];
        const siblings = listEl && typeof listEl.querySelectorAll === 'function'
          ? Array.from(listEl.querySelectorAll('[data-card-id]')).filter((el) => el.getAttribute('data-card-id') !== movingId)
          : [];
        let index = siblings.length;
        for (let i = 0; i < siblings.length; i += 1) {
          if (typeof siblings[i].getBoundingClientRect !== 'function') continue;
          const rect = siblings[i].getBoundingClientRect();
          if (y < rect.top + rect.height / 2) {
            index = i;
            break;
          }
        }
        return { priority: hit, index };
      }

      const setDragState = (next) => {
        dragRef.current = next;
        setDrag(next);
      };

      /** 按下：先记下起点，超过 5px 才算拖动（否则就是一次单击）。 */
      function onCardDown(event, todo, priority, index) {
        if (event.button !== undefined && event.button !== 0) return;
        const el = event.currentTarget;
        const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        // 捕获放在看板根节点上：拖动开始后源卡片会被移出列表（DOM 卸载），
        // 捕获在它身上会当场失效 —— 根节点不会动。
        const board = boardRef.current;
        if (board && typeof board.setPointerCapture === 'function' && event.pointerId !== undefined) {
          try {
            board.setPointerCapture(event.pointerId);
          } catch (error) {
            /* 不支持就算了，退化成普通点击 */
          }
        }
        const startX = Number(event.clientX) || 0;
        const startY = Number(event.clientY) || 0;
        // 记下「按下时抓住了卡片的哪个位置」：浮卡按这个偏移跟随指针，
        // 鼠标停在哪，卡片就停在哪 —— 不能用一个写死的偏移，否则一拖就跑偏。
        const grabX = rect ? Math.max(0, Math.min(rect.width, startX - rect.left)) : 0;
        const grabY = rect ? Math.max(0, Math.min(rect.height, startY - rect.top)) : 0;
        pendingRef.current = {
          id: todo.id,
          title: todo.title,
          dueDate: todo.dueDate,
          priority,
          index,
          x: startX,
          y: startY,
          grabX,
          grabY,
          width: rect ? rect.width : 320,
        };
        setSelected(todo.id);
      }

      function onCardMove(event) {
        const pending = pendingRef.current;
        if (!pending) return;
        const x = Number(event.clientX) || 0;
        const y = Number(event.clientY) || 0;
        const current = dragRef.current;
        if (!current) {
          if (Math.hypot(x - pending.x, y - pending.y) < 5) return;
          setDragState({
            id: pending.id,
            title: pending.title,
            dueDate: pending.dueDate,
            fromPriority: pending.priority,
            fromIndex: pending.index,
            x,
            y,
            grabX: pending.grabX,
            grabY: pending.grabY,
            width: pending.width,
            target: { priority: pending.priority, index: pending.index },
          });
          return;
        }
        // 出了象限就沿用上一个落点：宁可不动，也别在空白处松手把事挪丢
        const target = dropTargetAt(x, y, current.id) || current.target;
        const changed = !current.target || target.priority !== current.target.priority || target.index !== current.target.index;
        if (changed) flipRef.current = snapshotCards();
        setDragState({ ...current, x, y, target });
        if (changed) setFlipTick((value) => value + 1);
      }

      /** 松手：没超过阈值就只是单击；落在不同位置才写库。 */
      function onCardUp(event) {
        const board = boardRef.current;
        if (board && typeof board.releasePointerCapture === 'function' && event && event.pointerId !== undefined) {
          try {
            board.releasePointerCapture(event.pointerId);
          } catch (error) {
            /* ignore */
          }
        }
        pendingRef.current = null;
        const current = dragRef.current;
        if (!current) return;
        setDragState(null);
        const target = current.target;
        if (!target) return;
        const cross = target.priority !== current.fromPriority;
        if (!cross && target.index === current.fromIndex) return;
        moveTodo(current, target, cross);
      }

      /** 调 Host 的原子动作：优先级 + 顺序一次改完。 */
      function moveTodo(current, target, cross) {
        api.send('todo_move', { id: current.id, priority: target.priority, index: target.index }, { silent: true }).then((result) => {
          if (!result || result.ok !== true) return;
          setLanded(current.id);
          // 跨象限才有提示：同象限内的排序用户看得见，不必再说话
          if (cross) {
            setToast({
              text: `已移至【${PRIORITY_INFO[target.priority].short}】`,
              undo: { id: current.id, priority: current.fromPriority, index: current.fromIndex },
            });
          }
        });
      }

      const undoMove = () => {
        if (!toast || !toast.undo) return;
        const undo = toast.undo;
        setToast(null);
        api.send('todo_move', { id: undo.id, priority: undo.priority, index: undo.index }, { silent: true });
      };

      const quadrantList = view && Array.isArray(view.quadrants) ? view.quadrants : [];
      const projects = (boot && boot.projects) || [];
      const editing = editingId
        ? quadrantList.reduce((hit, quadrant) => hit || quadrant.todos.find((todo) => todo.id === editingId), null)
        : null;

      // 所有 hook 之后才允许提前返回，否则切换数据时 hook 数量会变
      if (!view || !Array.isArray(view.quadrants)) return h('div', { className: 'aw-note' }, '加载中…');

      /** 单张卡片：只有标题 + 截止日期（其余信息留给悬浮说明与编辑弹层）。 */
      function cardNode(todo, priority, index) {
        const isSel = selected === todo.id;
        const isDragging = !!drag && drag.id === todo.id;
        const dueClass = `aw-kcard-due${todo.dueDate ? '' : ' is-none'}${todo.overdue ? ' is-overdue' : ''}`;
        return h(
          'div',
          {
            key: todo.id,
            'data-card-id': todo.id,
            className: `aw-kcard${isSel ? ' is-sel' : ''}${isDragging ? ' is-drag' : ''}${landed === todo.id ? ' is-landed' : ''}`,
            tabIndex: 0,
            role: 'button',
            title: todo.note ? `${todo.title}\n${todo.note}` : todo.title,
            ref: (el) => {
              if (el) cardsRef.current[todo.id] = el;
              else delete cardsRef.current[todo.id];
            },
            onPointerDown: (event) => onCardDown(event, todo, priority, index),
            onDoubleClick: () => setEditingId(todo.id),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                if (typeof event.preventDefault === 'function') event.preventDefault();
                setSelected(todo.id);
              }
            },
          },
          [
            h('span', { key: 'bar', className: 'aw-kcard-bar', 'aria-hidden': 'true' }),
            h('span', { key: 'title', className: 'aw-kcard-title' }, todo.title),
            todo.note ? h('span', { key: 'note', className: 'aw-kcard-note', 'aria-hidden': 'true' }) : null,
            todo.note ? h('div', { key: 'tip', className: 'aw-kcard-tip' }, todo.note) : null,
            h('span', { key: 'due', className: dueClass }, todo.dueDate ? `${todo.dueDate} 截止` : '暂无截止'),
          ],
        );
      }

      /** 点在卡片以外的地方（空白、象限头、列表底）就取消选中。 */
      function onBoardDown(event) {
        const target = event && event.target;
        if (target && typeof target.closest === 'function' && target.closest('[data-card-id]')) return;
        if (selected) setSelected(null);
      }

      return h(
        'div',
        {
          className: 'aw-kb',
          ref: boardRef,
          // 卡片外的按下 = 取消选中；卡片自己的选中由 onCardDown 负责
          onPointerDown: onBoardDown,
          // 指针捕获挂在这里：即使源卡片会从列表里消失，move / up 仍然收得到
          onPointerMove: onCardMove,
          onPointerUp: onCardUp,
          onPointerCancel: onCardUp,
        },
        h(
          'div',
          { className: 'aw-kb-grid' },
          quadrantList.map((quadrant) => {
            const priority = quadrant.priority;
            const info = PRIORITY_INFO[priority];
            const isOver = !!drag && drag.target && drag.target.priority === priority;
            // 拖动中的卡片从原位拿掉，改由落点占位表达「会插到这里」
            const rows = quadrant.todos.filter((todo) => !(drag && drag.id === todo.id));
            if (isOver) rows.splice(Math.min(drag.target.index, rows.length), 0, { __placeholder: true, id: '__drop__' });
            return h(
              'section',
              {
                key: priority,
                className: `aw-q ${PRIORITY_CLASS[priority]}${isOver ? ' is-over' : ''}`,
                'data-q': priority,
              },
              [
                h(
                  'header',
                  { key: 'head', className: 'aw-q-head' },
                  [
                    h('span', { key: 'dot', className: 'aw-q-dot', 'aria-hidden': 'true' }),
                    h(
                      'div',
                      { key: 'text', className: 'aw-q-text' },
                      [
                        h('div', { key: 'title', className: 'aw-q-title' }, info.short),
                        h('div', { key: 'sub', className: 'aw-q-sub' }, info.action),
                      ],
                    ),
                    h('span', { key: 'badge', className: 'aw-q-badge' }, `${quadrant.count} 项`),
                    h(
                      'button',
                      {
                        key: 'add',
                        type: 'button',
                        className: 'aw-q-add',
                        title: `在「${info.short}」新建`,
                        'aria-label': `在「${info.short}」新建`,
                        onClick: () => {
                          setAddPriority(priority);
                          setAdding(true);
                        },
                      },
                      '+',
                    ),
                  ],
                ),
                h(
                  'div',
                  {
                    key: 'list',
                    className: 'aw-q-list',
                    ref: (el) => {
                      if (el) listsRef.current[priority] = el;
                      else delete listsRef.current[priority];
                    },
                  },
                  rows.length === 0
                    ? h('div', { key: 'empty', className: 'aw-q-empty' }, '暂无事项')
                    : rows.map((todo) =>
                        todo.__placeholder
                          ? h('div', { key: '__drop__', className: 'aw-q-drop' }, '松开鼠标，放到这里')
                          : cardNode(todo, priority, quadrant.todos.indexOf(todo)),
                      ),
                ),
              ],
            );
          }),
        ),
        drag
          ? h(
              'div',
              {
                className: `aw-kb-ghost ${PRIORITY_CLASS[drag.fromPriority]}`,
                // 浮层压在指针上方：落点提示留在指针下方，两者不打架
                style: {
                  // 保持按下时抓住的位置，浮卡才不会偏离指针
                  left: drag.x - (drag.grabX || 0),
                  top: Math.max(0, drag.y - (drag.grabY || 0)),
                  width: Math.max(160, drag.width || 320),
                },
                'aria-hidden': 'true',
              },
              [
                h('span', { key: 'bar', className: 'aw-kcard-bar' }),
                h('span', { key: 'title', className: 'aw-kcard-title' }, drag.title),
                h(
                  'span',
                  { key: 'due', className: `aw-kcard-due${drag.dueDate ? '' : ' is-none'}` },
                  drag.dueDate ? `${drag.dueDate} 截止` : '暂无截止',
                ),
              ],
            )
          : null,
        toast
          ? h(
              'div',
              { className: 'aw-kb-toast', role: 'status' },
              [
                h('span', { key: 'check', className: 'aw-kb-toast-check', 'aria-hidden': 'true' }, '✓'),
                h('span', { key: 'text' }, toast.text),
                toast.undo
                  ? h('button', { key: 'undo', type: 'button', className: 'aw-kb-undo', onClick: undoMove }, '撤销')
                  : null,
              ],
            )
          : null,
        h(
          Modal,
          {
            open: adding,
            closable: true,
            title: '新建待办',
            onClose: () => setAdding(false),
          },
          h(TodoCreator, {
            api,
            projects,
            busy,
            priority: addPriority,
            lockPriority: true,
            onDone: () => setAdding(false),
          }),
        ),
        h(TodoEditor, { api, todo: editing, projects, busy, onClose: () => setEditingId(null) }),
      );
    }

    /* ================= 项目 ================= */

    /**
     * 项目编辑器：新建与修改共用，字段包括项目名 / 分类 / 说明 / 状态。
     */
    function ProjectEditor(props) {
      const { api, project, busy, onClose } = props;
      const creating = !project;
      const initial = () => ({
        name: project?.name || '',
        category: project?.category || 'work',
        description: project?.description || '',
        status: project?.status || 'active',
      });
      const [draft, setDraft] = React.useState(initial);
      const set = (patch) => setDraft({ ...draft, ...patch });

      const save = () => {
        const name = draft.name.trim();
        if (!name) return;
        const payload = {
          name,
          category: draft.category,
          description: draft.description,
          status: draft.status,
        };
        if (!creating) payload.id = project.id;
        api.send(creating ? 'project_create' : 'project_update', payload).then((result) => {
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
          h('h3', null, creating ? '新增项目' : '修改项目'),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0,1fr))', gap: 10 } },
            h(Field, { label: '项目名', style: { gridColumn: 'span 6' } },
              h('input', { className: 'aw-input', value: draft.name, autoFocus: true, onChange: (event) => set({ name: event.target.value }) })),
            h(Field, { label: '分类', style: { gridColumn: 'span 3' } },
              h('select',
                { className: 'aw-select', value: draft.category, onChange: (event) => set({ category: event.target.value }) },
                h('option', { value: 'work' }, '工作'),
                h('option', { value: 'personal' }, '个人'))),
            h(Field, { label: '状态', style: { gridColumn: 'span 3' } },
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
            h(Btn, { tone: 'primary', disabled: busy || !draft.name.trim(), onClick: save }, creating ? '新建' : '保存'),
          ),
        ),
      );
    }

    function ProjectsTab(props) {
      const api = props.api;
      const view = props.view;
      const busy = props.busy;
      const [editing, setEditing] = React.useState(null);

      if (!Array.isArray(view)) return h(Empty, null, '加载中…');

      const statusText = { active: '进行中', paused: '暂停', archived: '已归档' };
      const categoryText = { work: '工作', personal: '个人' };
      const closeEditor = () => {
        setEditing(null);
        if (props.onCloseCreate) props.onCloseCreate();
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },

        view.length === 0
          ? h(Card, { children: h(Empty, null, '还没有项目。建一个，把待办挂上去。') })
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
                    h(Chip, { children: categoryText[project.category] || categoryText.work }),
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

        editing || props.createOpen
          ? h(ProjectEditor, {
              key: editing ? editing.id : 'new',
              api,
              project: editing,
              busy,
              onClose: closeEditor,
            })
          : null,
      );
    }

    function monthParams() {
      const today = localToday();
      return { date: today };
    }

    /* ================= 简报 ================= */

    function ReportsTab(props) {
      const api = props.api;
      const view = props.view;
      const busy = props.busy;
      const [dimension, setDimension] = React.useState('time');
      const [type, setType] = React.useState('weekly');
      const [date, setDate] = React.useState(localToday());
      // 周报区间：null 表示跟着 date 走（本周一~周五），有值表示用户改过
      const [weekCustom, setWeekCustom] = React.useState(null);
      const [projectId, setProjectId] = React.useState('');
      const [status, setStatus] = React.useState('all');
      const [q, setQ] = React.useState('');
      const [selected, setSelected] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [editing, setEditing] = React.useState(false);
      // 9：选中的周报文件（配置了多个时才有下拉）
      const [targetFile, setTargetFile] = React.useState('');
      // 分类口径与生成弹窗放在最后：不改动前面 use* 的下标（测试按顺序注入）。
      const [categoryScope, setCategoryScope] = React.useState('work');
      const [genOpen, setGenOpen] = React.useState(false);

      /** 打开生成弹窗：每次回来都是默认口径（本周 / 仅工作）。 */
      const openGenerate = () => {
        setDimension('time');
        setType('weekly');
        setDate(localToday());
        setWeekCustom(null);
        setProjectId('');
        setCategoryScope('work');
        setGenOpen(true);
      };

      React.useEffect(() => {
        api.open('reports', { status, q });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [status, q]);

      const projects = (view && view.projects) || props.boot?.projects || [];
      const reportFiles = (props.boot && props.boot.settings && props.boot.settings.reportFiles) || [];
      const currentFile = targetFile && reportFiles.includes(targetFile) ? targetFile : reportFiles[0] || '';
      const shortName = (key) => String(key).split('/').pop();

      /** 打开一份简报并载入正文。 */
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
          api.flash('error', `载入简报失败：${String(error.message || error)}`);
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
            ? { type: 'project', projectId, date, category: 'all' }
            : {
                type,
                date,
                // 项目维度已经由项目限定范围，分类口径不参与。
                category: categoryScope,
                ...(type === 'weekly' && weekCustom ? { from: week.from, to: week.to } : {}),
              };
        if (dimension === 'project' && !projectId) {
          api.flash('warn', '项目维度需要先选一个项目');
          return;
        }
        api.send('report_create', payload).then((result) => {
          if (result.ok && result.data && result.data.id) {
            setGenOpen(false);
            openReport(result.data.id);
          }
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
          title: h(
            'span',
            { className: 'aw-split-row' },
            '简报库 ',
            h(Chip, { children: `草稿 ${counts.draft}` }),
            h(Chip, { tone: 'ok', children: `已定稿 ${counts.final}` }),
            h(Chip, { tone: 'gold', children: `已归档 ${counts.archived}` }),
          ),
          extra: h(
            'span',
            { className: 'aw-split-row' },
            h(Btn, { small: true, tone: 'primary', disabled: busy, onClick: openGenerate }, '生成简报'),
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
              ? h(Empty, null, '还没有简报。点右上角「生成简报」选个范围。')
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
                          item.totals ? h('span', null, `${item.totals.done} 项`) : null,
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

        h(
          Modal,
          { open: genOpen, closable: true, title: '生成简报', onClose: () => setGenOpen(false) },
          h(
            'div',
            { className: 'aw-form-vertical' },
            // 一项一行：名称在上、控件占满整行，按填写顺序从上往下排。
            h(
              Field,
              { label: '维度' },
              h(
                'div',
                { className: 'aw-seg' },
                h(Btn, { on: dimension === 'time', onClick: () => setDimension('time') }, '时间维度'),
                h(Btn, { on: dimension === 'project', onClick: () => setDimension('project') }, '项目维度'),
              ),
            ),
            dimension === 'time'
              ? h(
                  Field,
                  { label: '类型' },
                  h(
                    'select',
                    { className: 'aw-select', value: type, onChange: (event) => setType(event.target.value) },
                    h('option', { value: 'weekly' }, '周报'),
                    h('option', { value: 'monthly' }, '月报'),
                    h('option', { value: 'yearly' }, '年报'),
                  ),
                )
              : h(
                  Field,
                  { label: '项目' },
                  h(
                    'select',
                    { className: 'aw-select', value: projectId, onChange: (event) => setProjectId(event.target.value) },
                    h('option', { value: '' }, '选择项目…'),
                    projects.map((project) => h('option', { key: project.id, value: project.id }, `${project.emoji}${project.name}`)),
                  ),
                ),
            // 项目维度已经由项目限定范围，不再给分类口径。
            dimension === 'time'
              ? h(
                  Field,
                  { label: '项目分类' },
                  h(
                    'select',
                    { className: 'aw-select', value: categoryScope, onChange: (event) => setCategoryScope(event.target.value) },
                    h('option', { value: 'all' }, '全部'),
                    h('option', { value: 'work' }, '仅工作'),
                    h('option', { value: 'personal' }, '仅个人'),
                  ),
                )
              : null,
            dimension === 'time' && type === 'weekly'
              ? [
                  h(
                    Field,
                    { key: 'wf', label: '区间起点' },
                    h('input', {
                      className: 'aw-input',
                      type: 'date',
                      value: (weekCustom ?? reportWeek(date)).from,
                      title: '周报区间起点',
                      onChange: (event) =>
                        setWeekCustom({ from: event.target.value, to: (weekCustom ?? reportWeek(date)).to }),
                    }),
                  ),
                  h(
                    Field,
                    { key: 'wt', label: '区间终点' },
                    h('input', {
                      className: 'aw-input',
                      type: 'date',
                      value: (weekCustom ?? reportWeek(date)).to,
                      title: '周报区间终点',
                      onChange: (event) =>
                        setWeekCustom({ to: event.target.value, from: (weekCustom ?? reportWeek(date)).from }),
                    }),
                  ),
                  weekCustom
                    ? h(
                        'div',
                        { key: 'reset', style: { display: 'flex', justifyContent: 'flex-start' } },
                        h(Btn, { small: true, tone: 'ghost', onClick: () => setWeekCustom(null), title: '回到本周一 ~ 本周五' }, '回到默认'),
                      )
                    : null,
                ]
              : h(
                  Field,
                  { label: dimension === 'time' ? '定位日期' : '定位月份' },
                  h('input', {
                    className: 'aw-input',
                    type: 'date',
                    value: date,
                    onChange: (event) => {
                      setDate(event.target.value);
                      setWeekCustom(null);
                    },
                    title: dimension === 'time' ? '以这一天定位所在周 / 月 / 年' : '以这一天定位所在月',
                  }),
                ),
          ),
          h(
            'div',
            { className: 'aw-form', style: { justifyContent: 'flex-end' } },
            h(Btn, { tone: 'ghost', onClick: () => setGenOpen(false) }, '取消'),
            h(Btn, { tone: 'primary', disabled: busy, onClick: generate }, '生成简报'),
          ),
        ),
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
     * 周报的默认区间：本周一到本周五（与宿主 resolveReportRange 一致）。
     */
    function reportWeek(key) {
      const base = new Date(`${key}T00:00:00`);
      const safe = Number.isNaN(base.getTime()) ? new Date() : base;
      const back = (safe.getDay() + 6) % 7; // 0=周一 … 6=周日
      const from = new Date(safe);
      from.setDate(from.getDate() - back);
      const to = new Date(from);
      to.setDate(to.getDate() + 4);
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

      if (!view || !view.totals || !Array.isArray(view.buckets)) {
        return h(Empty, null, '加载中…');
      }

      const peak = Math.max(1, ...view.buckets.map((bucket) => bucket.done));
      const totals = view.totals;

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
              h(Metric, { label: '漏做 / 放弃', value: `${totals.missed} / ${totals.dropped}` }),
            ),
            h(Bar, { ratio: totals.completionRate / 100, tone: totals.completionRate >= 80 ? undefined : 'gold' }),
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
                  { className: 'aw-trend-col', key: bucket.key, title: `${bucket.label}\n完成 ${bucket.done} · 计划 ${bucket.planned} · 完成率 ${bucket.completionRate}%` },
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
                          title: `${cell.date} 完成 ${cell.count} 项`,
                        }),
                      );
                    }
                    return cells;
                  })(),
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
        reportFooter: boot.settings.reportFooter || '',
        reportFiles: (boot.settings.reportFiles || []).join('\n'),
        reportSignature: boot.settings.reportSignature ?? '',
        reportTemplate: boot.settings.reportTemplate || '',
        reportTitlePrefix: boot.settings.reportTitlePrefix ?? '周报',
      };
    }

    /**
     * 设置弹窗的内容：一行一项，左边名称、右边控件；分组标题 + 组间大留白。
     * 外框由 Modal 承担，这里只放内容，不再套一层卡片。
     */
    function SettingsModal(props) {
      const { api, boot, skin, onSkin, onClose } = props;
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
              reportFooter: draft.reportFooter,
              reportFiles: draft.reportFiles
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
              reportSignature: draft.reportSignature,
              reportTemplate: draft.reportTemplate,
              reportTitlePrefix: draft.reportTitlePrefix,
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
            { label: '皮肤' },
            h(
              'select',
              { className: 'aw-select', 'aria-label': '皮肤', value: skin, onChange: (event) => onSkin(event.target.value) },
              SKINS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
            ),
          ),
        ),

        /* ── 简报 ── */
        h(
          SetGroup,
          { title: '简报' },
          h(
            SetRow,
            { label: '简报标题前缀', hint: '周报正文首行：前缀（2026.11.9-2026.11.13）' },
            h('input', {
              className: 'aw-input',
              placeholder: '周报',
              value: draft.reportTitlePrefix,
              onChange: (event) => setDraft({ ...draft, reportTitlePrefix: event.target.value }),
            }),
          ),
          h(
            SetRow,
            { label: '简报落款 / 附加说明' },
            h('input', { className: 'aw-input', value: draft.reportFooter, onChange: (event) => setDraft({ ...draft, reportFooter: event.target.value }) }),
          ),
          h(
            SetRow,
            { label: '追加时的署名' },
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
              label: '自定义简报模板',
              hint: '留空用内置版式；支持 {{title}} / {{weeklyCompleted}} / {{nextPlan}} / {{nextWeek}} / {{completed}} / {{stats}} 等占位符',
              stacked: true,
            },
            h('textarea', {
              className: 'aw-textarea',
              rows: 5,
              placeholder: '{{title}}\n一、本周总结\n{{weeklyCompleted}}\n二、下周计划\n{{nextPlan}}',
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
            { label: '添加覆盖' },
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
        ),

        /* ── 危险操作：删除类单独一组 ── */
        h(
          SetGroup,
          { title: '危险操作', tone: 'danger' },
          h(
            SetRow,
            { label: '已覆盖的日期', stacked: true },
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
            { label: '清除全部覆盖' },
            h(Btn, { tone: 'danger', disabled: Object.keys(overrides).length === 0, onClick: clearAll }, '清除全部'),
          ),
        ),

        /* 底部：关闭 / 保存 */
        h(
          'div',
          { className: 'aw-set-foot' },
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
      const boot = snap.boot;
      // 分类口径存在 Host 设置里：切到「仅个人」，下次打开还是「仅个人」
      const boardScope = (boot && boot.settings && boot.settings.boardCategory) || 'all';
      // initialTab 只有本地渲染台（test/browser）会传，用来给每个分页一个可截图的 URL；
      // DSH 里不传：打开插件先看「看板」——四象限是每天最先要决定的一次取舍。
      const [tab, setTab] = React.useState(props.initialTab || 'board');
      // initialSettings 同样只有本地渲染台会传：?settings=1 直接打开设置弹层，
      // 好让设置页也有一个可截图的 URL。
      const [settingsOpen, setSettingsOpen] = React.useState(!!props.initialSettings);
      const [projectCreateOpen, setProjectCreateOpen] = React.useState(false);
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

      // 首次挂载：拉启动快照（分页内容由下面的 tab effect 负责）。
      React.useEffect(() => {
        api.refreshBoot();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [api]);

      // 分页切换时按需拉取。
      React.useEffect(() => {
        setProjectCreateOpen(false);
        if (tab === 'today') api.open('today');
        else if (tab === 'board') api.open('board', { category: boardScope });
        else if (tab === 'projects') api.open('projects');
        else if (tab === 'reports') api.open('reports', { status: 'all' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab, tab === 'board' ? boardScope : '']);

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
        ensureStyle(pageRef.current);
      }, [skin]);

      const view = snap.viewName === tab ? snap.view : null;
      const tabs = [
        { id: 'board', label: '看板' },
        { id: 'today', label: '今日' },
        { id: 'projects', label: '项目' },
        { id: 'reports', label: '简报' },
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

          /* 左栏：品牌 + 导航 + 今日待办卡 */
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
                h('div', { className: 'aw-brand-sub' }, '待办 · 简报 · 统计'),
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
                  { className: 'aw-promo', title: '今日完成进度' },
                  h('div', { className: 'aw-promo-label' }, '今日待办'),
                  h('div', { className: 'aw-promo-value' }, `${boot.counts.todayPlanned ?? 0} 项`),
                  h(
                    'div',
                    { className: 'aw-promo-bar' },
                    h('i', {
                      style: {
                        width: `${Math.min(
                          100,
                          ((Number(boot.counts.todayDone) || 0) /
                            Math.max(1, (Number(boot.counts.todayDone) || 0) + (Number(boot.counts.todayPlanned) || 0))) *
                            100,
                        )}%`,
                      },
                    }),
                  ),
                  h(
                    'div',
                    { className: 'aw-promo-note' },
                    h('span', null, `完成 ${boot.counts.todayDone ?? 0}`),
                    boot.counts.draftReports > 0 ? h('span', null, `草稿 ${boot.counts.draftReports}`) : null,
                  ),
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
                  // 看板的分类口径属于「这一页怎么看」，放在页头右侧，和标题同一视线
                  tab === 'board'
                    ? h(
                        'div',
                        { className: 'aw-kb-scope', role: 'group', 'aria-label': '分类口径' },
                        BOARD_SCOPES.map((scope) =>
                          h(
                            Btn,
                            {
                              key: scope.id,
                              small: true,
                              on: boardScope === scope.id,
                              title: `分类口径：${scope.label}`,
                              onClick: () =>
                                api.send(
                                  'settings_update',
                                  {
                                    settings: { boardCategory: scope.id },
                                    view: 'board',
                                    viewParams: { category: scope.id },
                                  },
                                  { silent: true },
                                ),
                            },
                            scope.label,
                          ),
                        ),
                      )
                    : null,
                  tab === 'projects'
                    ? h('button', { type: 'button', className: 'aw-btn is-primary is-small', onClick: () => setProjectCreateOpen(true) }, '新增项目')
                    : null,
                  h('button', { type: 'button', className: 'aw-btn is-ghost is-small', onClick: () => setSettingsOpen(true), title: '设置' }, '设置'),
                ),
              ),

                        snap.error
            ? h(Card, { children: h('div', { style: { color: 'var(--aw-danger)', fontWeight: 600 } }, `${snap.error}`) })
            : null,

          // 只把「确实属于当前分页」的视图喂给分页组件。切换分页时新数据还没到，
          // view 就是 null，各分页会退化成「加载中…」，而不是拿错数据崩掉。
          tab === 'board'
            ? h(BoardTab, { api, view, busy: snap.busy, boot })
            : tab === 'today'
            ? h(TodayTab, { api, view, busy: snap.busy, boot })
              : tab === 'projects'
                ? h(ProjectsTab, { api, view, busy: snap.busy, createOpen: projectCreateOpen, onCloseCreate: () => setProjectCreateOpen(false) })
                : tab === 'reports'
                  ? h(ReportsTab, { api, view, busy: snap.busy, boot })
                  : h(StatsTab, { api, view, busy: snap.busy }),

              h(
                'div',
                { className: 'aw-note', style: { textAlign: 'center', paddingTop: 6 } },
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
