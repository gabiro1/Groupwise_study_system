export default function BrandLogo({ className = "", title = "Lien" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 126 46"
      role="img"
      aria-label={title}
    >
      <defs>
        <linearGradient
          id="lien-brand-grad"
          gradientUnits="userSpaceOnUse"
          x1="8"
          y1="0"
          x2="118"
          y2="0"
        >
          <stop offset="0" stopColor="#138a63" />
          <stop offset="1" stopColor="#38cd96" />
        </linearGradient>
      </defs>
      <g
        fill="none"
        stroke="url(#lien-brand-grad)"
        strokeWidth="7.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 8 V38 H32" />
        <path d="M46 17 V38" />
        <path d="M58 27 H86" />
        <path d="M86 27 A14 11 0 1 0 78.6 36.7" />
        <path d="M98 38 V21 C98 15 101.5 12.5 106 12.5 C110.5 12.5 114 15 114 21 V38" />
      </g>
      <circle cx="46" cy="8" r="3.4" fill="url(#lien-brand-grad)" />
    </svg>
  );
}
