export function BrandMark({
  className = "h-6 w-6",
}: {
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="6" fill="hsl(27 90% 52%)" />
      <path
        d="M6 8 L11 24 L16 8"
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="18"
        y1="8"
        x2="28"
        y2="8"
        stroke="rgba(255,255,255,0.75)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <line
        x1="23"
        y1="8"
        x2="23"
        y2="24"
        stroke="rgba(255,255,255,0.75)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
