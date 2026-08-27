import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { EditSpec } from "./CodeMirrorEditor";

interface Pos {
  x: number;
  y: number;
}
function loadPos(): Pos | null {
  try {
    const s = localStorage.getItem("insertToolbar.pos.v2");
    return s ? (JSON.parse(s) as Pos) : null;
  } catch {
    return null;
  }
}

const CHART_TEMPLATE = `{
  "data": {"values": [{"x": "A", "y": 30}, {"x": "B", "y": 55}, {"x": "C", "y": 43}]},
  "mark": "bar",
  "encoding": {"x": {"field": "x", "type": "nominal"}, "y": {"field": "y", "type": "quantitative"}}
}`;

const MERMAID_TEMPLATE = `flowchart LR
  A[Start] --> B{Decision}
  B -->|Yes| C[OK]
  B -->|No| D[Stop]`;

const TABLE_TEMPLATE = `| Column A | Column B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |`;

// --- Icons ---

function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={`leading-none ${className ?? ""}`}>{children}</span>;
}
function svg(children: ReactNode) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
const CodeIcon = () => svg(<><path d="M16 18l6-6-6-6" /><path d="M8 6l-6 6 6 6" /></>);
const LinkIcon = () => svg(<><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>);
const ListIcon = () => svg(<><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none" /></>);
const CheckIcon = () => svg(<><rect x="3" y="4" width="8" height="8" rx="2" /><path d="M5 8l1.6 1.6L9.5 6.5" /><line x1="14" y1="8" x2="21" y2="8" /><line x1="14" y1="16" x2="21" y2="16" /><rect x="3" y="14" width="8" height="8" rx="2" /></>);
const QuoteIcon = () => svg(<><path d="M7 7H4v5h4V9c0 1.7-1 3-3 3.5" /><path d="M17 7h-3v5h4V9c0 1.7-1 3-3 3.5" /></>);
const BracesIcon = () => svg(<><path d="M8 4c-2 0-2 3-2 4s0 2-2 2c2 0 2 1 2 2s0 4 2 4" /><path d="M16 4c2 0 2 3 2 4s0 2 2 2c-2 0-2 1-2 2s0 4-2 4" /></>);
const TableIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="10" x2="21" y2="10" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="12" y1="4" x2="12" y2="20" /></>);
const ImageIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5-9 9" /></>);
const ChartIcon = () => svg(<><line x1="4" y1="20" x2="20" y2="20" /><rect x="6" y="11" width="3" height="7" fill="currentColor" stroke="none" /><rect x="11" y="7" width="3" height="11" fill="currentColor" stroke="none" /><rect x="16" y="13" width="3" height="5" fill="currentColor" stroke="none" /></>);
const DiagramIcon = () => svg(<><rect x="9" y="3" width="6" height="4" rx="1" /><rect x="3" y="17" width="6" height="4" rx="1" /><rect x="15" y="17" width="6" height="4" rx="1" /><path d="M12 7v4M12 11H6v6M12 11h6v6" /></>);
const ContentsIcon = () => svg(<><line x1="9" y1="6" x2="20" y2="6" /><line x1="11" y1="12" x2="20" y2="12" /><line x1="13" y1="18" x2="20" y2="18" /><circle cx="5" cy="6" r="1.1" fill="currentColor" stroke="none" /><circle cx="7" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none" /></>);

export interface Item {
  key: string;
  title: string;
  icon: ReactNode;
  spec: EditSpec;
}

const GROUPS: Item[][] = [
  [
    { key: "h", title: "Heading", icon: <Glyph className="text-[13px] font-bold">H</Glyph>, spec: { before: "## ", placeholder: "Heading", block: true } },
    { key: "b", title: "Bold", icon: <Glyph className="text-[12px] font-bold">B</Glyph>, spec: { before: "**", after: "**", placeholder: "bold" } },
    { key: "i", title: "Italic", icon: <Glyph className="text-[12px] font-semibold italic">I</Glyph>, spec: { before: "*", after: "*", placeholder: "italic" } },
    { key: "s", title: "Strikethrough", icon: <Glyph className="text-[12px] font-semibold line-through">S</Glyph>, spec: { before: "~~", after: "~~", placeholder: "text" } },
    { key: "code", title: "Inline code", icon: <CodeIcon />, spec: { before: "`", after: "`", placeholder: "code" } },
    { key: "link", title: "Link", icon: <LinkIcon />, spec: { before: "[", after: "](url)", placeholder: "text" } },
  ],
  [
    { key: "ul", title: "Bulleted list", icon: <ListIcon />, spec: { before: "- ", placeholder: "item", block: true } },
    { key: "task", title: "Checklist", icon: <CheckIcon />, spec: { before: "- [ ] ", placeholder: "task", block: true } },
    { key: "quote", title: "Quote", icon: <QuoteIcon />, spec: { before: "> ", placeholder: "quote", block: true } },
  ],
  [
    { key: "codeblock", title: "Code block", icon: <BracesIcon />, spec: { before: "```\n", after: "\n```", placeholder: "code", block: true } },
    { key: "table", title: "Table", icon: <TableIcon />, spec: { placeholder: TABLE_TEMPLATE, block: true } },
    { key: "hr", title: "Divider", icon: <Glyph className="text-[13px] font-bold">―</Glyph>, spec: { before: "---", block: true } },
    { key: "img", title: "Image", icon: <ImageIcon />, spec: { before: "![", after: "](path)", placeholder: "alt", block: true } },
  ],
  [
    { key: "chart", title: "Chart (Vega-Lite)", icon: <ChartIcon />, spec: { before: "```vega-lite\n", after: "\n```", placeholder: CHART_TEMPLATE, block: true } },
    { key: "diagram", title: "Diagram (Mermaid)", icon: <DiagramIcon />, spec: { before: "```mermaid\n", after: "\n```", placeholder: MERMAID_TEMPLATE, block: true } },
    { key: "math", title: "Math (LaTeX)", icon: <Glyph className="text-[13px] font-semibold">∑</Glyph>, spec: { before: "$$\n", after: "\n$$", placeholder: "e = mc^2", block: true } },
    // The fence is the whole component — the list itself is read from the vault.
    { key: "contents", title: "Content index", icon: <ContentsIcon />, spec: { before: "```content-index\n```", block: true } },
  ],
];

/** Flat list of every insertable element — also drives the command palette. */
export const INSERT_ACTIONS: Item[] = GROUPS.flat();

interface ToolbarProps {
  onInsert: (spec: EditSpec) => void;
  /** Only used to pick a sensible first-run position (inside the editor pane). */
  anchorRef?: RefObject<HTMLElement | null>;
}

export default function InsertToolbar({ onInsert, anchorRef }: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(loadPos);

  /** Keep the toolbar fully inside the window. */
  const clamp = (x: number, y: number, el: HTMLElement): Pos => ({
    x: Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, x)),
    y: Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, y)),
  });

  // Position before paint: re-clamp a saved spot, or default to the editor's left edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos((p) => {
      if (p) return clamp(p.x, p.y, el);
      const r = anchorRef?.current?.getBoundingClientRect();
      return r
        ? clamp(r.left + 10, r.top + r.height / 2 - el.offsetHeight / 2, el)
        : clamp(12, window.innerHeight / 2 - el.offsetHeight / 2, el);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A shrinking window must not strand the toolbar off-screen.
  useEffect(() => {
    const onResize = () => {
      const el = ref.current;
      if (el) setPos((p) => (p ? clamp(p.x, p.y, el) : p));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    document.body.style.cursor = "grabbing";
    const onMove = (ev: MouseEvent) => {
      setPos(clamp(ev.clientX - grabX, ev.clientY - grabY, el));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      setPos((p) => {
        if (p) localStorage.setItem("insertToolbar.pos.v2", JSON.stringify(p));
        return p;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Portalled to <body>: the editor pane clips overflow, and `.content-pane`'s
  // backdrop-filter would otherwise make it the containing block for `fixed`.
  return createPortal(
    <div
      ref={ref}
      className="insert-toolbar"
      style={pos ? { left: pos.x, top: pos.y, transform: "none" } : undefined}
    >
      <div className="insert-handle" title="Drag to move" onMouseDown={startDrag}>
        <svg viewBox="0 0 16 8" width="16" height="8" fill="currentColor">
          <circle cx="4" cy="2" r="1" />
          <circle cx="8" cy="2" r="1" />
          <circle cx="12" cy="2" r="1" />
          <circle cx="4" cy="6" r="1" />
          <circle cx="8" cy="6" r="1" />
          <circle cx="12" cy="6" r="1" />
        </svg>
      </div>
      {GROUPS.map((group, gi) => (
        <div key={gi} className="insert-group">
          {group.map((item) => (
            <button
              key={item.key}
              title={item.title}
              aria-label={item.title}
              // mousedown (not click) so the editor keeps its selection.
              onMouseDown={(e) => {
                e.preventDefault();
                onInsert(item.spec);
              }}
              className="insert-btn"
            >
              {item.icon}
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  );
}
