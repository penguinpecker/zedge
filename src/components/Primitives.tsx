import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle,
  CurrencyBtc,
  CurrencyEth,
  Info,
  X,
} from "@phosphor-icons/react";
import type { Asset, ExchangeState, Outcome } from "../lib/market";

export function Coin({
  asset,
  small = false,
}: {
  asset: Asset;
  small?: boolean;
}) {
  const Icon = asset === "BTC" ? CurrencyBtc : CurrencyEth;
  return (
    <span
      className={`coin ${asset.toLowerCase()} ${small ? "small" : ""}`}
      aria-hidden="true"
    >
      <Icon weight={asset === "BTC" ? "bold" : "fill"} />
    </span>
  );
}

export function Direction({
  outcome,
  children,
}: {
  outcome: Outcome;
  children?: ReactNode;
}) {
  const Icon = outcome === "up" ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`direction ${outcome}`}>
      <Icon weight="bold" />
      {children ?? (outcome === "up" ? "Up" : "Down")}
    </span>
  );
}

export function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>("input")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      requestAnimationFrame(() => {
        if (opener?.isConnected && !document.querySelector("dialog[open]"))
          opener.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-heading">
        <div>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={21} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Toast({ notice }: { notice: ExchangeState["notice"] }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setDismissed(notice.id), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice || dismissed === notice.id)
    return <div className="sr-only" role="status" />;
  return (
    <div
      className={`toast ${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      {notice.kind === "error" ? (
        <Info size={23} />
      ) : (
        <CheckCircle size={23} weight="fill" />
      )}
      <p>{notice.message}</p>
      <button
        className="icon-button"
        aria-label="Dismiss notification"
        onClick={() => setDismissed(notice.id)}
      >
        <X size={17} />
      </button>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
