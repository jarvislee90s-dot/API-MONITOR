import { ExternalLink, Link2, ShieldCheck } from "lucide-react";
import type { RawLinkItem } from "../api/client";

interface RawLinksProps {
  links: RawLinkItem[];
}

const toneClassName: Record<NonNullable<RawLinkItem["tone"]>, string> = {
  neutral: "link-chip--neutral",
  brand: "link-chip--brand",
  warning: "link-chip--warning",
};

export function RawLinks({ links }: RawLinksProps) {
  return (
    <div className="link-list" aria-label="原网页和状态链接">
      {links.map((link) => {
        const Icon =
          link.tone === "warning" ? ShieldCheck : link.tone === "brand" ? Link2 : ExternalLink;

        return (
          <a
            key={`${link.label}-${link.href}`}
            className={`link-chip ${toneClassName[link.tone ?? "neutral"]}`}
            href={link.href}
            target="_blank"
            rel="noreferrer"
          >
            <Icon size={14} aria-hidden="true" />
            <span>{link.label}</span>
          </a>
        );
      })}
    </div>
  );
}

