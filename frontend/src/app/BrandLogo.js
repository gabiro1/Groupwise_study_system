import Image from "next/image";
import mkuLogo from "../../Logo/MKU_Logos-high-resolution-1.png";

export default function BrandLogo({ className = "", title = "Mount Kigali University" }) {
  return (
    <Image
      className={className}
      src={mkuLogo}
      alt={title}
      title={title}
      loading="eager"
      sizes="(max-width: 620px) 150px, 220px"
    />
  );
}
