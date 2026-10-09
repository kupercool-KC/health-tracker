import type { CapacitorConfig } from "@capacitor/cli";

// Placeholder identifiers — replace appId/appName with the final Bundle ID and store name before the first upload.
const config: CapacitorConfig = {
  appId: "com.kupercool.lilly",
  appName: "Lily",
  // The app shell loads the live site (same code the browser uses); capacitor-www is only the offline placeholder.
  webDir: "capacitor-www",
  server: {
    url: "https://health-tracker-sepia.vercel.app",
    cleartext: false,
  },
  ios: {
    // "never": the web layout handles the notch / home-indicator itself via env(safe-area-inset-*); "always" left a white native strip at the bottom.
    contentInset: "never",
    backgroundColor: "#fbfaf7",
  },
  plugins: {
    FirebaseAuthentication: {
      providers: ["apple.com", "google.com"],
      skipNativeAuth: true,
    },
  },
};

export default config;
