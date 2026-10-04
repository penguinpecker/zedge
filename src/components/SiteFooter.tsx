import type { ReactNode } from "react";
import type { AppMode } from "../chain/mode";
import "./site-footer.css";

const LINKS = [
  ["/terms", "Terms of Service"],
  ["/privacy", "Privacy"],
  ["/risk-disclosure", "Risk disclosure"],
  ["/market-rules", "Market rules"],
  ["/support", "Support"],
] as const;

export default function SiteFooter({ mode, status, action }: {
  mode: AppMode;
  status?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <footer className="site-footer">
      <div className="site-footer-status">{status ?? <span>ZEDGE</span>}</div>
      <nav aria-label="Help and legal" className="site-footer-links">
        {LINKS.map(([path, label]) => <a key={path} href={`${path}?mode=${mode}`}>{label}</a>)}
        {action}
      </nav>
    </footer>
  );
}
