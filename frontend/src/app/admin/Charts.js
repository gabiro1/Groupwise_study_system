"use client";

import { useRef, useState } from "react";

/**
 * Dependency-free SVG charts.
 *
 * The project ships no charting library, and pulling one in for two small
 * visualisations would cost more than it returns. Both charts are plain SVG,
 * scale to their container via `viewBox`, and expose an accessible summary —
 * a chart that only exists as pixels is unreadable to a screen reader.
 */

export const CHART_COLORS = {
  blue: "#3B82F6",
  green: "#12835B",
  orange: "#F59E0B",
  teal: "#0D9488",
  red: "#F43F5E",
  slate: "#94A3B8",
  gold: "#56BD8A",
};

function niceMax(value) {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

export function LineChart({
  labels = [],
  series = [],
  height = 250,
  ariaLabel = "Line chart",
  emptyMessage = "There is not enough data to draw this chart yet.",
}) {
  const width = 720;
  const padding = { top: 18, right: 18, bottom: 32, left: 40 };
  const [hoverIndex, setHoverIndex] = useState(null);
  const svgRef = useRef(null);

  const hasData = series.some((line) => line.values.some((value) => value != null));

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const allValues = series.flatMap((line) => line.values).filter((value) => value != null);
  const max = niceMax(Math.max(1, ...allValues));

  const xAt = (index) =>
    labels.length <= 1 ? padding.left : padding.left + (index / (labels.length - 1)) * plotWidth;
  const yAt = (value) => padding.top + plotHeight - (value / max) * plotHeight;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(max * fraction));

  const xLabelStep = Math.max(1, Math.ceil(labels.length / 6));

  function handleMove(event) {
    if (!svgRef.current || labels.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relativeX = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = (relativeX - padding.left) / plotWidth;
    const index = Math.round(ratio * (labels.length - 1));
    setHoverIndex(Math.min(labels.length - 1, Math.max(0, index)));
  }

  if (!hasData) {
    return <p className="admin-chart-empty">{emptyMessage}</p>;
  }

  return (
    <figure className="admin-chart">
      <div className="admin-chart-legend">
        {series.map((line) => (
          <span className="admin-chart-legend-item" key={line.label}>
            <span className="admin-chart-swatch" style={{ background: line.color }} aria-hidden="true" />
            {line.label}
          </span>
        ))}
      </div>

      <div className="admin-chart-canvas">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          className="admin-chart-svg"
          role="img"
          aria-label={ariaLabel}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <title>{ariaLabel}</title>

          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={yAt(tick)}
                y2={yAt(tick)}
                stroke="#EEF1F6"
                strokeWidth="1"
              />
              <text x={padding.left - 8} y={yAt(tick) + 4} textAnchor="end" className="admin-chart-axis">
                {tick}
              </text>
            </g>
          ))}

          {labels.map((label, index) =>
            index % xLabelStep === 0 || index === labels.length - 1 ? (
              <text key={label} x={xAt(index)} y={height - 10} textAnchor="middle" className="admin-chart-axis">
                {label.slice(5)}
              </text>
            ) : null,
          )}

          {series.map((line) => {
            let path = "";
            let open = false;
            line.values.forEach((value, index) => {
              if (value == null) {
                open = false;
                return;
              }
              path += `${open ? "L" : "M"}${xAt(index)} ${yAt(value)} `;
              open = true;
            });
            return (
              <path
                key={line.label}
                d={path.trim()}
                fill="none"
                stroke={line.color}
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}

          {hoverIndex != null && (
            <>
              <line
                x1={xAt(hoverIndex)}
                x2={xAt(hoverIndex)}
                y1={padding.top}
                y2={padding.top + plotHeight}
                stroke="#C7CEDB"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              {series.map((line) =>
                line.values[hoverIndex] == null ? null : (
                  <circle
                    key={line.label}
                    cx={xAt(hoverIndex)}
                    cy={yAt(line.values[hoverIndex])}
                    r="4"
                    fill="#fff"
                    stroke={line.color}
                    strokeWidth="2.4"
                  />
                ),
              )}
            </>
          )}
        </svg>

        {hoverIndex != null && (
          <div
            className="admin-chart-tooltip"
            style={{
              left: `${(xAt(hoverIndex) / width) * 100}%`,
            }}
          >
            <strong>{labels[hoverIndex]}</strong>
            {series.map((line) => (
              <span key={line.label}>
                <span className="admin-chart-swatch" style={{ background: line.color }} aria-hidden="true" />
                {line.label}: {line.values[hoverIndex] ?? "—"}
              </span>
            ))}
          </div>
        )}
      </div>

      <figcaption className="admin-sr-only">
        {ariaLabel}. {series.map((line) => `${line.label}: ${line.values.filter((v) => v != null).length} data points`).join("; ")}.
      </figcaption>
    </figure>
  );
}

export function DonutChart({ data = [], size = 176, thickness = 20, centerValue, centerLabel, ariaLabel = "Distribution chart" }) {
  const total = data.reduce((sum, slice) => sum + slice.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  let offset = 0;

  return (
    <figure className="admin-donut">
      <svg viewBox={`0 0 ${size} ${size}`} className="admin-donut-svg" role="img" aria-label={ariaLabel}>
        <title>{ariaLabel}</title>
        <circle cx={center} cy={center} r={radius} fill="none" stroke="#EEF1F6" strokeWidth={thickness} />
        {total > 0 &&
          data
            .filter((slice) => slice.value > 0)
            .map((slice) => {
              const length = (slice.value / total) * circumference;
              const element = (
                <circle
                  key={slice.key}
                  cx={center}
                  cy={center}
                  r={radius}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${center} ${center})`}
                  strokeLinecap="butt"
                />
              );
              offset += length;
              return element;
            })}
      </svg>
      <div className="admin-donut-center" aria-hidden="true">
        <strong>{centerValue}</strong>
        <span>{centerLabel}</span>
      </div>
      <figcaption className="admin-sr-only">
        {ariaLabel}. {data.map((slice) => `${slice.label}: ${slice.value}`).join("; ")}.
      </figcaption>
    </figure>
  );
}
