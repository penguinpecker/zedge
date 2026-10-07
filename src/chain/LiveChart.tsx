import { useEffect, useMemo, useRef, useState } from "react";
import { AreaSeries, ColorType, createChart, CrosshairMode, LastPriceAnimationMode, LineStyle, type AutoscaleInfo, type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp } from "lightweight-charts";
import { parseUnits } from "viem";
import { price } from "../lib/market";
import { observationPrice } from "./gateway.ts";
import { createPriceFeed, type FeedStatus, type Tick } from "./price-feed.ts";
import "./live-chart.css";

const LINE = "#c7f86f", TARGET = "#e9eddf", MUTED = "#8f9a86";
/** Seconds of price drawn before the first shown minute, so the line runs in from the left edge. */
const LEAD = 300;
/** The viewer's local time, 24-hour like the rest of the site. */
const clock = (ms: number, seconds = false) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined });
const ZONE = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "";
const usd = (value: number) => `$${price(value)}`;
const axisPrices = (values: number[]) => {
  const whole = values.every((v) => Math.abs(v - Math.round(v)) < 1e-6);
  return values.map((v) => `$${v.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`);
};
const axisTime = (time: Time) => clock((time as number) * 1000);

/** What the one-click order reads from the display feed: the latest tick, the last completed one-minute closes, the feed's
 * state, and the report observed at the round's start (display precision, null until read). */
export type MarketFeed = { spot: Tick | null; closes: number[]; status?: FeedStatus; startTick?: Tick | null };
type Marks = { start: HTMLDivElement | null; cutoff: HTMLDivElement | null; end: HTMLDivElement | null; closed: HTMLDivElement | null; target: HTMLDivElement | null; tip: HTMLDivElement | null };

/** Live BTC/USD line for one round, one Chainlink report a minute (TradingView Lightweight Charts). Round times are unix
 * seconds; `priceToBeat` is the verified Chainlink opening observation as an exact decimal, or null before it is recorded. */
export default function LiveChart({ start, cutoff, end, priceToBeat, onMarket }: { start: number; cutoff: number; end: number; priceToBeat: string | null; onMarket?: (feed: MarketFeed) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const marks = useRef<Marks>({ start: null, cutoff: null, end: null, closed: null, target: null, tip: null });
  const chart = useRef<{ api: IChartApi; series: ISeriesApi<"Area">; line: IPriceLine | null; place: () => void } | null>(null);
  const goal = useRef<number | null>(null);
  const [version, setVersion] = useState(0);
  const report = useRef(onMarket);
  useEffect(() => { report.current = onMarket; });
  // The whole round is in view. A round that has not started also shows the round before it, so its start line has context.
  const { feed, view } = useMemo(() => {
    const view = Date.now() < start * 1000 ? 2 * start - end : start;
    return { view, feed: createPriceFeed((view - LEAD) * 1000, end * 1000) };
  }, [start, end]);
  // The header's string, from the same exact value through the same function, so chart and header always agree.
  const target = priceToBeat === null ? null : observationPrice(parseUnits(priceToBeat, 18), -18);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const api = createChart(element, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: MUTED, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, attributionLogo: false },
      localization: { priceFormatter: usd, tickmarksPriceFormatter: axisPrices, timeFormatter: axisTime },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.18, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, lockVisibleTimeRangeOnResize: true, tickMarkFormatter: axisTime },
      crosshair: { mode: CrosshairMode.Magnet, horzLine: { visible: false, labelVisible: false }, vertLine: { color: "rgba(233,237,223,0.25)", style: LineStyle.Solid, labelBackgroundColor: "#2b322b" } },
      handleScroll: false, handleScale: false,
    });
    const series = api.addSeries(AreaSeries, {
      lineColor: LINE, lineWidth: 2, topColor: "rgba(199,248,111,0.22)", bottomColor: "rgba(199,248,111,0)",
      priceLineVisible: false, lastPriceAnimation: LastPriceAnimationMode.Continuous,
      // The price to beat always stays on the plot.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original(), g = goal.current;
        return info?.priceRange && g !== null ? { ...info, priceRange: { minValue: Math.min(info.priceRange.minValue, g), maxValue: Math.max(info.priceRange.maxValue, g) } } : info;
      },
    });
    // START, CUTOFF, END, the price-to-beat tag and the tooltip are HTML over the canvas, placed after the chart draws.
    // The cutoff lies inside its minute: placed between that minute's start and the end.
    const layout = () => {
      const scale = api.timeScale(), width = scale.width(), m = marks.current;
      element.parentElement?.style.setProperty("--axis", `${scale.height()}px`);
      const x = (time: number) => scale.timeToCoordinate(time as UTCTimestamp);
      const inside = (at: number | null) => at !== null && at >= 0 && at <= width ? at : null;
      const last = x(end - 60), finish = inside(x(end)), cut = inside(last === null || finish === null ? null : last + (finish - last) * (cutoff - (end - 60)) / 60);
      const put = (el: HTMLDivElement | null, at: number | null) => { if (el) { el.style.display = at === null ? "none" : ""; if (at !== null) el.style.left = `${at}px`; } };
      put(m.start, inside(x(start))); put(m.cutoff, cut); put(m.end, finish);
      if (m.closed) { m.closed.style.display = cut === null || finish === null ? "none" : ""; if (cut !== null && finish !== null) { m.closed.style.left = `${cut}px`; m.closed.style.width = `${finish - cut}px`; } }
      // END's label drops to a second row when it would touch CUTOFF's (narrow screens).
      const cutLabel = m.cutoff?.firstElementChild?.getBoundingClientRect(), endLabel = m.end?.firstElementChild;
      endLabel?.classList.remove("low");
      if (cutLabel?.width && endLabel && cutLabel.right + 6 > endLabel.getBoundingClientRect().left) endLabel.classList.add("low");
      // The price-to-beat tag sits at the right end of its line, on the side the price line does not reach under the tag
      // (plus one minute to its left); if it reaches both, on the side away from the latest price.
      const g = goal.current, y = g === null ? null : series.priceToCoordinate(g);
      if (m.target) {
        m.target.style.display = y === null ? "none" : "";
        if (y !== null && g !== null) {
          const step = (finish ?? 0) - (last ?? 0), from = width - 6 - m.target.offsetWidth - step;
          const near = feed.points().filter((p) => p.value !== undefined && (x(p.time) ?? -1) >= from).map((p) => p.value as number);
          const up = near.some((v) => v > g), down = near.some((v) => v < g);
          m.target.style.left = `${width - 6}px`; m.target.style.top = `${y}px`;
          m.target.classList.toggle("below", up && down ? (feed.last()?.p ?? g) >= g : up);
        }
      }
    };
    let frame = 0;
    const place = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
    api.subscribeCrosshairMove((param) => {
      const tip = marks.current.tip;
      if (!tip) return;
      const point = param.point, item = param.time === undefined ? undefined : param.seriesData.get(series);
      const value = item && "value" in item && typeof item.value === "number" ? item.value : null;
      if (!point || !item || value === null) { tip.style.display = "none"; return; }
      tip.textContent = `${usd(value)} · ${axisTime(item.time)}`;
      tip.style.display = "";
      const half = tip.offsetWidth / 2, y = series.priceToCoordinate(value) ?? point.y;
      tip.style.left = `${Math.min(Math.max(point.x, half), api.timeScale().width() - half)}px`;
      tip.style.top = `${y}px`;
      tip.classList.toggle("below", y < 48);
    });
    api.timeScale().subscribeVisibleLogicalRangeChange(place);
    api.timeScale().subscribeSizeChange(place);
    chart.current = { api, series, line: null, place };
    return () => { cancelAnimationFrame(frame); api.timeScale().unsubscribeVisibleLogicalRangeChange(place); api.timeScale().unsubscribeSizeChange(place); api.remove(); chart.current = null; };
  }, [start, cutoff, end, feed]);

  useEffect(() => {
    // The socket is closed while the tab is hidden; on return the backfill fills the gap.
    const visibility = () => document.visibilityState === "hidden" ? feed.pause() : feed.resume();
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => setVersion(feed.version), 500);
    return () => { feed.pause(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [feed]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    // Redrawn on every feed change: one point a minute, an empty slot for each missing report, so the round's time axis
    // stays fixed from the first shown minute to the end.
    c.series.setData(feed.points().map((p) => ({ ...p, time: p.time as UTCTimestamp })));
    c.api.timeScale().setVisibleRange({ from: view as UTCTimestamp, to: end as UTCTimestamp });
    c.place();
    report.current?.({ spot: feed.last(), closes: feed.closes(), status: feed.status, startTick: feed.at(start * 1000) });
  }, [version, feed, view, start, cutoff, end]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (c.line) c.series.removePriceLine(c.line);
    // Placed at the shown cents, so its axis label reads exactly the header's string.
    goal.current = target === null ? null : Number(target.replace(/[$,]/g, ""));
    c.line = goal.current === null ? null : c.series.createPriceLine({ price: goal.current, color: TARGET, lineWidth: 1, lineStyle: LineStyle.LargeDashed, axisLabelVisible: true, axisLabelColor: TARGET, axisLabelTextColor: "#111410", title: "" });
    c.place();
  }, [target, start, cutoff, end, feed]);

  const last = feed.last();
  return <div className="live-chart">
    <div className="live-chart-frame" role="img"
      aria-label={`Bitcoin price from ${feed.source}, one report a minute. ${target === null ? "Price to beat not recorded yet" : `Price to beat ${target}`}${last ? `; latest ${usd(last.p)} at ${clock(last.t)} ${ZONE}` : ""}.`}>
      <div className="live-chart-canvas" ref={box} />
      <div className="live-chart-closed" ref={(el) => { marks.current.closed = el; }} aria-hidden="true" />
      {(["start", "cutoff", "end"] as const).map((name) => <div key={name} className={`live-chart-mark ${name}`} ref={(el) => { marks.current[name] = el; }} aria-hidden="true">
        <span>{name === "cutoff" ? `CUTOFF ${clock(cutoff * 1000, true)}` : name.toUpperCase()}</span></div>)}
      <div className="live-chart-target" ref={(el) => { marks.current.target = el; }} aria-hidden="true" style={{ display: "none" }}>PRICE TO BEAT</div>
      <div className="live-chart-tip" ref={(el) => { marks.current.tip = el; }} aria-hidden="true" style={{ display: "none" }} />
      {!last && <p className="live-chart-wait" role="status">Connecting to the live price…</p>}
    </div>
    <p className="live-chart-source"><span className={`status-dot ${feed.status === "live" ? "" : "paused"}`} />
      <span>Chainlink BTC/USD · one report a minute{last ? ` · last ${clock(last.t)} ${ZONE}` : ""}{feed.status === "reconnecting" ? " · Reconnecting…" : ""}</span>
      <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Chart by TradingView</a></p>
  </div>;
}
