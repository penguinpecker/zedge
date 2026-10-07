import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, CrosshairMode, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp, type WhitespaceData, type CandlestickData } from "lightweight-charts";
import { price } from "../lib/market";
import { createPriceFeed, type Tick } from "./price-feed.ts";
import "./live-chart.css";

const UP = "#c7f86f", DOWN = "#ef9a87", MUTED = "#8f9a86";
const clock = (time: number) => new Date(time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
/** What the one-click order reads from the display feed: the latest tick and the last completed one-minute closes. */
export type MarketFeed = { spot: Tick | null; closes: number[] };

/** Live BTC/USD one-minute candles for one round (TradingView Lightweight Charts). Round times are unix seconds; `priceToBeat`
 * is the verified Chainlink opening observation as an exact decimal, or null before it is recorded. */
export default function LiveChart({ start, cutoff, end, priceToBeat, onMarket }: { start: number; cutoff: number; end: number; priceToBeat: string | null; onMarket?: (feed: MarketFeed) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const marks = useRef<{ start: HTMLDivElement | null; cutoff: HTMLDivElement | null; end: HTMLDivElement | null; closed: HTMLDivElement | null }>({ start: null, cutoff: null, end: null, closed: null });
  const chart = useRef<{ api: IChartApi; series: ISeriesApi<"Candlestick">; line: IPriceLine | null; place: () => void } | null>(null);
  const [version, setVersion] = useState(0);
  const report = useRef(onMarket);
  useEffect(() => { report.current = onMarket; });
  // A round that has not started also shows the round length before it, so its start line has context.
  const feed = useMemo(() => createPriceFeed(Date.now() < start * 1000 ? (2 * start - end) * 1000 : start * 1000, end * 1000), [start, end]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const api = createChart(element, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: MUTED, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, attributionLogo: true },
      grid: { vertLines: { color: "rgba(255,255,255,0.035)" }, horzLines: { color: "rgba(255,255,255,0.035)" } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: CrosshairMode.Normal }, handleScroll: false, handleScale: false,
    });
    const series = api.addSeries(CandlestickSeries, { upColor: UP, wickUpColor: UP, downColor: DOWN, wickDownColor: DOWN, borderVisible: false, priceLineColor: MUTED });
    // START, CUTOFF and END are HTML lines over the canvas. The cutoff lies inside its minute: placed between that minute's start and the end.
    const place = () => {
      const x = (time: number) => api.timeScale().timeToCoordinate(time as UTCTimestamp);
      const last = x(end - 60), finish = x(end), cut = last === null || finish === null ? null : last + (finish - last) * (cutoff - (end - 60)) / 60;
      const put = (el: HTMLDivElement | null, at: number | null) => { if (el) { el.style.display = at === null ? "none" : ""; if (at !== null) el.style.left = `${at}px`; } };
      put(marks.current.start, x(start)); put(marks.current.cutoff, cut); put(marks.current.end, finish);
      const zone = marks.current.closed;
      if (zone) { zone.style.display = cut === null || finish === null ? "none" : ""; if (cut !== null && finish !== null) { zone.style.left = `${cut}px`; zone.style.width = `${Math.max(0, finish - cut)}px`; } }
    };
    api.timeScale().subscribeVisibleLogicalRangeChange(place);
    api.timeScale().subscribeSizeChange(place);
    chart.current = { api, series, line: null, place };
    return () => { api.timeScale().unsubscribeVisibleLogicalRangeChange(place); api.timeScale().unsubscribeSizeChange(place); api.remove(); chart.current = null; };
  }, [start, cutoff, end]);

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
    // Redrawn on every feed change. Whitespace minutes up to the end keep the whole round on the time axis.
    const candles = feed.candles();
    const data: (CandlestickData | WhitespaceData)[] = candles.map((x) => ({ ...x, time: x.time as UTCTimestamp }));
    for (let t = (candles.at(-1)?.time ?? feed.from / 1000 - 60) + 60; t <= end; t += 60) data.push({ time: t as UTCTimestamp });
    c.series.setData(data);
    c.api.timeScale().fitContent();
    c.place();
    report.current?.({ spot: feed.last(), closes: feed.closes() });
  }, [version, feed, end]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (c.line) c.series.removePriceLine(c.line);
    c.line = priceToBeat === null ? null : c.series.createPriceLine({ price: Number(priceToBeat), color: MUTED, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "PRICE TO BEAT" });
  }, [priceToBeat, start, cutoff, end]);

  const last = feed.last(), latest = feed.candles().at(-1);
  return <div className="live-chart">
    <div className="live-chart-frame" role="img"
      aria-label={`Bitcoin one-minute candles from ${feed.source}. ${priceToBeat === null ? "Price to beat not recorded yet" : `Price to beat $${priceToBeat}`}${latest ? `; latest $${price(latest.close)}${last ? ` at ${clock(last.t)} UTC` : ""}` : ""}.`}>
      <div className="live-chart-canvas" ref={box} />
      <div className="live-chart-closed" ref={(el) => { marks.current.closed = el; }} aria-hidden="true" />
      {(["start", "cutoff", "end"] as const).map((name) => <div key={name} className={`live-chart-mark ${name}`} ref={(el) => { marks.current[name] = el; }} aria-hidden="true">
        <span>{name === "cutoff" ? `CUTOFF ${clock(cutoff * 1000)}` : name.toUpperCase()}</span></div>)}
      {!latest && <p className="live-chart-wait" role="status">Connecting to the live price…</p>}
    </div>
    <p className="live-chart-source"><span className={`status-dot ${feed.status === "live" ? "" : "paused"}`} />
      <span>Chainlink BTC/USD{feed.status === "reconnecting" ? " · Reconnecting…" : ""}</span></p>
  </div>;
}
