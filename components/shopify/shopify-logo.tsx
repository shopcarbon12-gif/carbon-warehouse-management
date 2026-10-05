/** Shopify's green shopping-bag mark (drawn inline — no external asset). */
export function ShopifyLogo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <path d="M8.4 7.2V5.6a3.6 3.6 0 0 1 7.2 0v1.6" fill="none" stroke="#5E8E3E" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M4.3 7.2h15.4l-1.25 13.9a1.7 1.7 0 0 1-1.7 1.5H7.25a1.7 1.7 0 0 1-1.7-1.5Z" fill="#95BF47" />
      <path d="M15.6 7.2h4.1l-1.25 13.9a1.7 1.7 0 0 1-1.7 1.5h-1.9Z" fill="#5E8E3E" />
      <text
        x="11.2"
        y="19.4"
        textAnchor="middle"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="800"
        fontSize="10.5"
        fill="#fff"
      >
        S
      </text>
    </svg>
  );
}
