/** Vega-Lite theme shared by the live editor and the PDF/print renderer. */
export const VEGA_CONFIG = {
  background: "transparent",
  font: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
  title: { color: "#1d1d1f", fontSize: 14, fontWeight: 600 },
  axis: {
    labelColor: "#565660",
    titleColor: "#1d1d1f",
    gridColor: "rgba(0,0,0,0.06)",
    domainColor: "rgba(0,0,0,0.18)",
    tickColor: "rgba(0,0,0,0.18)",
  },
  legend: { labelColor: "#565660", titleColor: "#1d1d1f" },
  view: { stroke: "transparent" },
  range: {
    category: ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"],
    ramp: ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"],
  },
};

export const MERMAID_INIT = {
  startOnLoad: false,
  theme: "default" as const,
  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
};
