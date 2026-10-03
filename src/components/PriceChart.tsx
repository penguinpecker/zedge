import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { clamp, marketSnapshot, price, spotAt, timeText } from "../lib/market";
import type { MarketId } from "../lib/market";

export function Sparkline({
  marketId,
  now,
  positive,
}: {
  marketId: MarketId;
  now: number;
  positive: boolean;
}) {
  const snap = marketSnapshot(marketId, now);
  const values = Array.from({ length: 40 }, (_, i) =>
    spotAt(snap.asset, snap.start + (i * (now - snap.start)) / 39),
  );
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const d = values
    .map(
      (v, i) =>
        `${i ? "L" : "M"}${((i / 39) * 112).toFixed(1)},${(36 - ((v - min) / span) * 29).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      className={`sparkline ${positive ? "up" : "down"}`}
      viewBox="0 0 114 44"
      aria-hidden="true"
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PriceChart({
  marketId,
  now,
  start,
  mode,
}: {
  marketId: MarketId;
  now: number;
  start: number;
  mode: "price" | "odds";
}) {
  const gradientId = useId().replace(/:/g, "");
  const crosshair = useRef<SVGGElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(920);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(280, Math.round(entry.contentRect.width))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const snapshot = marketSnapshot(marketId, now, start);
  const end = snapshot.end;
  const height = 240;
  const top = 20;
  const bottom = 203;
  const narrow = width < 500;
  const axisWidth = narrow ? 77 : 97;
  const right = width - axisWidth;
  const samples = useMemo(() => {
    const to = clamp(now, start, end);
    return Array.from(
      { length: Math.max(2, Math.min(170, Math.ceil((to - start) / 2000))) },
      (_, i) => i,
    );
  }, [now, start, end]);
  const points = samples.map((_, i) => {
    const t =
      start +
      ((clamp(now, start, end) - start) * i) / Math.max(1, samples.length - 1);
    return {
      time: t,
      value:
        mode === "price"
          ? spotAt(snapshot.asset, t)
          : marketSnapshot(marketId, t, start).up,
    };
  });
  const reference = mode === "price" ? snapshot.reference : 50;
  const minimumSpan =
    mode === "price" ? (snapshot.asset === "BTC" ? 30 : 2.2) : 25;
  const low = Math.min(reference, ...points.map((p) => p.value));
  const high = Math.max(reference, ...points.map((p) => p.value));
  const padding = Math.max(minimumSpan, high - low) * 0.24;
  const min = mode === "odds" ? Math.max(0, low - padding) : low - padding;
  const max =
    mode === "odds"
      ? Math.min(100, Math.max(high + padding, min + minimumSpan))
      : Math.max(high + padding, min + minimumSpan);
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);
  const x = (time: number) =>
    8 + ((time - start) / (end - start)) * (right - 8);
  const line = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`,
    )
    .join(" ");
  const last = points[points.length - 1];
  const lastX = x(last.time);
  const lastY = y(last.value);
  const color = last.value >= reference ? "#c7f86f" : "#ef9a87";
  const format = (n: number) =>
    mode === "price" ? price(n) : `${Math.round(n)}%`;
  const hover = (event: PointerEvent<SVGSVGElement>) => {
    if (!crosshair.current || !tooltip.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = clamp(
      ((event.clientX - rect.left) / rect.width) * width,
      8,
      lastX,
    );
    const index = Math.round(
      clamp((localX - 8) / Math.max(1, lastX - 8), 0, 1) * (points.length - 1),
    );
    const point = points[index];
    crosshair.current.style.opacity = "1";
    crosshair.current.setAttribute(
      "transform",
      `translate(${x(point.time)},0)`,
    );
    crosshair.current
      .querySelector("circle")
      ?.setAttribute("cy", String(y(point.value)));
    tooltip.current.textContent = `${timeText(point.time)} UTC · ${mode === "price" ? "$" : "Up "}${format(point.value)}`;
    tooltip.current.style.opacity = "1";
    tooltip.current.style.left = `${clamp((localX / width) * rect.width, 90, rect.width - 100)}px`;
  };
  return (
    <div className="price-chart" ref={container}>
      <div className="chart-tooltip" ref={tooltip} aria-hidden="true" />
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${snapshot.name} ${mode === "price" ? "price" : "Up probability"} chart. Reference ${format(reference)}; latest ${format(last.value)}.`}
        onPointerMove={hover}
        onPointerLeave={() => {
          if (crosshair.current) crosshair.current.style.opacity = "0";
          if (tooltip.current) tooltip.current.style.opacity = "0";
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.13" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
          <pattern
            id={`${gradientId}-dots`}
            width="28"
            height="28"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="0.6" fill="#626d62" opacity="0.3" />
          </pattern>
        </defs>
        <rect
          width={right}
          height={bottom + 5}
          fill={`url(#${gradientId}-dots)`}
        />
        {[0, 1, 2, 3].map((i) => {
          const yy = top + (i * (bottom - top)) / 3;
          const value = max - (i * (max - min)) / 3;
          return (
            <g key={i}>
              <line
                x1="0"
                y1={yy}
                x2={right}
                y2={yy}
                stroke="#ffffff"
                strokeOpacity="0.035"
              />
              <text x={right + 10} y={yy + 4} className="chart-axis">
                {format(value)}
              </text>
            </g>
          );
        })}
        <line
          x1="0"
          y1={y(reference)}
          x2={right}
          y2={y(reference)}
          stroke="#8f9a86"
          strokeWidth="1"
          strokeDasharray="4 5"
          strokeOpacity="0.5"
        />
        <rect
          x="12"
          y={y(reference) - 11}
          width={mode === "price" ? 105 : 77}
          height="22"
          rx="3"
          fill="#222820"
        />
        <text x="20" y={y(reference) + 3.5} className="chart-reference">
          {mode === "price" ? "PRICE TO BEAT" : "50% CHANCE"}
        </text>
        <path
          d={`${line} L${lastX.toFixed(1)},${bottom} L8,${bottom} Z`}
          fill={`url(#${gradientId})`}
        />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <line
          x1={lastX}
          y1={top}
          x2={lastX}
          y2={bottom}
          stroke={color}
          strokeOpacity="0.13"
        />
        <circle cx={lastX} cy={lastY} r="8" fill={color} fillOpacity="0.12" />
        <circle cx={lastX} cy={lastY} r="3.5" fill={color} />
        <line
          x1={lastX + 6}
          y1={lastY}
          x2={right + 2}
          y2={lastY}
          stroke={color}
          strokeOpacity="0.3"
          strokeDasharray="3 4"
        />
        <rect
          x={right + 4}
          y={lastY - 12}
          width={axisWidth - 7}
          height="24"
          rx="4"
          fill={color}
        />
        <text
          x={right + (axisWidth + 1) / 2}
          y={lastY + 4}
          textAnchor="middle"
          className="chart-current"
        >
          {format(last.value)}
        </text>
        {(narrow ? [0, 1] : [0, 0.2, 0.4, 0.6, 0.8, 1]).map((fraction) => (
          <text
            key={fraction}
            x={8 + (right - 8) * fraction}
            y="234"
            textAnchor={
              fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"
            }
            className="chart-axis"
          >
            {timeText(start + (end - start) * fraction)}
          </text>
        ))}
        <g ref={crosshair} style={{ opacity: 0 }} pointerEvents="none">
          <line
            x1="0"
            y1={top}
            x2="0"
            y2={bottom}
            stroke="#c0c7ba"
            strokeDasharray="3 3"
          />
          <circle
            cx="0"
            cy="0"
            r="4"
            fill="#ecf2e5"
            stroke="#101311"
            strokeWidth="2"
          />
        </g>
      </svg>
    </div>
  );
}
