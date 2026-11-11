import { Poppins } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "./ThemeProvider";
import mkuLogo from "../../Logo/MKU_Logos-high-resolution-1.png";

const poppins = Poppins({
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  variable: "--font-poppins",
  subsets: ["latin"],
});

export const metadata = {
  title: "Lien | Mount Kigali University",
  description: "Find study partners, form groups, and learn together with Lien.",
  icons: {
    icon: mkuLogo.src,
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${poppins.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
