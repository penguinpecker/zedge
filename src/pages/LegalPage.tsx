import { useEffect } from "react";
import { ArrowLeft, ArrowUp } from "@phosphor-icons/react";
import SiteFooter from "../components/SiteFooter";
import { legalDocuments, legalNavigation, type LegalPageId } from "./legal-content";
import "./legal.css";

export type { LegalPageId } from "./legal-content";

export default function LegalPage({ page, mode }: { page: LegalPageId; mode: "chain" | "demo" }) {
  const document = legalDocuments[page];
  const marketHref = `/?mode=${mode}`;

  useEffect(() => {
    window.document.title = `${document.title} — ZEDGE`;
  }, [document.title]);

  return <div className="legal-page" id="page-top">
    <a className="skip-link" href="#legal-content">Skip to content</a>
    <header className="legal-header">
      <a className="brand legal-brand" href={marketHref} aria-label="ZEDGE markets">
        <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 2h20v5L9 17h13v5H2v-5L15 7H2z" fill="currentColor" /></svg>
        <span>edge<span className="brand-period">.</span></span>
      </a>
      <a className="legal-return" href={marketHref}><ArrowLeft size={17} aria-hidden="true" /> Back to markets</a>
    </header>

    <div className="legal-layout">
      <aside className="legal-sidebar">
        <nav aria-label="Help and policies" className="legal-navigation">
          {legalNavigation.map(id => <a href={`/${id}?mode=${mode}`} key={id} aria-current={id === page ? "page" : undefined}>{legalDocuments[id].label}</a>)}
        </nav>
        <nav className="legal-contents" aria-label="On this page">
          <p>On this page</p>
          {document.sections.map(section => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
        </nav>
      </aside>

      <main className="legal-main" id="legal-content" tabIndex={-1}>
        <div className="legal-heading">
          <h1>{document.title}</h1>
          <p className="legal-summary">{document.summary}</p>
          <div className="legal-meta">
            {document.draft && <span className="legal-draft">Draft</span>}
            <span>Updated <time dateTime="2026-10-09">9 October 2026</time></span>
          </div>
        </div>

        <article className="legal-article" aria-label={document.title}>
          {document.sections.map(section => <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
            <h2 id={`${section.id}-title`}>{section.title}</h2>
            {section.content}
          </section>)}
        </article>

        <div className="legal-ending">
          <p>ZEDGE · The live market trades real USDC.</p>
          <a href="#page-top">Back to top <ArrowUp size={16} aria-hidden="true" /></a>
        </div>
      </main>
    </div>
    <SiteFooter mode={mode} />
  </div>;
}
