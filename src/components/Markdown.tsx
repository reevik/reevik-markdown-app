import { useMemo, type ReactNode } from "react";
import { lexer, Lexer, type Token, type Tokens } from "marked";
import { openExternal } from "../lib/api";

/**
 * Markdown from the AI, rendered as React elements — never as HTML.
 *
 * Model output can be steered by whatever it read: the note itself, or a web
 * page during reference search. This webview can call Tauri commands that
 * write and delete files, so model text must not reach `innerHTML`. Instead
 * the text is parsed with `marked`'s lexer and each token becomes an element;
 * raw HTML in a reply is shown as literal text, and links open in the user's
 * browser rather than navigating the app.
 */
export default function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const tokens = useMemo(() => lexer(text), [text]);
  return <div className={`md ${className}`}>{blocks(tokens)}</div>;
}

/** One line of Markdown with no blocks — for short fields like a summary. */
export function InlineMarkdown({ text }: { text: string }) {
  const tokens = useMemo(() => Lexer.lexInline(text), [text]);
  return <>{inline(tokens)}</>;
}

function blocks(tokens: Token[]): ReactNode[] {
  return tokens.map((t, i) => block(t, i));
}

function block(t: Token, key: number): ReactNode {
  switch (t.type) {
    case "space":
      return null;
    case "paragraph":
      return <p key={key}>{inline((t as Tokens.Paragraph).tokens)}</p>;
    case "heading": {
      // Real <h1>s are far too loud in a narrow side panel; keep the
      // hierarchy with weight and size instead.
      const h = t as Tokens.Heading;
      return (
        <p key={key} className={`md-h md-h${Math.min(h.depth, 4)}`}>
          {inline(h.tokens)}
        </p>
      );
    }
    case "code":
      return (
        <pre key={key}>
          <code>{(t as Tokens.Code).text}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote key={key}>{blocks((t as Tokens.Blockquote).tokens)}</blockquote>;
    case "list": {
      const l = t as Tokens.List;
      const items = l.items.map((item, j) => (
        <li key={j} className={item.task ? "md-task" : undefined}>
          {blocks(item.tokens)}
        </li>
      ));
      return l.ordered ? (
        <ol key={key} start={typeof l.start === "number" ? l.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "checkbox":
      return <Checkbox key={key} checked={(t as Tokens.Checkbox).checked} />;
    case "hr":
      return <hr key={key} />;
    case "table": {
      const tb = t as Tokens.Table;
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {tb.header.map((c, j) => (
                  <th key={j} style={{ textAlign: c.align ?? undefined }}>
                    {inline(c.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, j) => (
                    <td key={j} style={{ textAlign: c.align ?? undefined }}>
                      {inline(c.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "html":
      // Shown, not rendered: see the note at the top of the file.
      return <p key={key}>{(t as Tokens.HTML).text}</p>;
    case "text": {
      // Inside a tight list item, the item's text arrives as a block-level
      // `text` token whose children are the inline tokens.
      const tx = t as Tokens.Text;
      return <span key={key}>{tx.tokens ? inline(tx.tokens) : tx.text}</span>;
    }
    default: {
      // An extension or future token type: show its children, or its source.
      const g = t as Tokens.Generic;
      return g.tokens ? <span key={key}>{inline(g.tokens)}</span> : <span key={key}>{g.raw}</span>;
    }
  }
}

function inline(tokens: Token[] | undefined): ReactNode[] {
  return (tokens ?? []).map((t, i) => span(t, i));
}

function span(t: Token, key: number): ReactNode {
  switch (t.type) {
    case "text": {
      const tx = t as Tokens.Text;
      return tx.tokens ? <span key={key}>{inline(tx.tokens)}</span> : tx.text;
    }
    case "escape":
      return (t as Tokens.Escape).text;
    case "strong":
      return <strong key={key}>{inline((t as Tokens.Strong).tokens)}</strong>;
    case "em":
      return <em key={key}>{inline((t as Tokens.Em).tokens)}</em>;
    case "del":
      return <del key={key}>{inline((t as Tokens.Del).tokens)}</del>;
    case "codespan":
      return <code key={key}>{(t as Tokens.Codespan).text}</code>;
    case "br":
      return <br key={key} />;
    case "link": {
      const l = t as Tokens.Link;
      return (
        <ExternalLink key={key} href={l.href} title={l.title ?? undefined}>
          {inline(l.tokens)}
        </ExternalLink>
      );
    }
    case "image": {
      // Not loaded: a remote image in a reply could be used to track that it
      // was read. Show it as a link to open instead.
      const im = t as Tokens.Image;
      return (
        <ExternalLink key={key} href={im.href} title={im.title ?? undefined}>
          {im.text || "image"}
        </ExternalLink>
      );
    }
    case "checkbox":
      return <Checkbox key={key} checked={(t as Tokens.Checkbox).checked} />;
    case "html":
      return (t as Tokens.Tag).text;
    default: {
      const g = t as Tokens.Generic;
      return g.tokens ? <span key={key}>{inline(g.tokens)}</span> : g.raw;
    }
  }
}

/** Opens web and mail links in the user's browser; anything else stays text. */
function ExternalLink({ href, title, children }: { href: string; title?: string; children: ReactNode }) {
  const safe = /^(https?:|mailto:)/i.test(href.trim());
  if (!safe) return <span title={href}>{children}</span>;
  return (
    <a
      href={href}
      title={title ?? href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href).catch((err) => console.error(err));
      }}
    >
      {children}
    </a>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return <input type="checkbox" checked={checked} disabled readOnly className="md-checkbox" />;
}
