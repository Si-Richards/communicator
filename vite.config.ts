import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",         // listen on all interfaces (IPv6 + IPv4)
    port: 8080,
    strictPort: true,
    allowedHosts: ["softphone.voicehost.io"],

    // If you access dev server through the domain/proxy, keep HMR stable:
    // Comment these out if you access directly via IP:port
    hmr: {
      host: "softphone.voicehost.io",
      port: 8080,       // or the external port you expose
      // protocol: "wss", // uncomment if you’re serving over HTTPS
    },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    global: "globalThis",
  },
}));
