// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ["@nuxtjs/tailwindcss"],
  tailwindcss: {
    cssPath: "~/assets/css/main.css"
  },
  devServer: {
    // NUXT_PORT/PORT envs win natively; this is just the documented default
    port: Number.parseInt(
      process.env.NUXT_PORT ?? process.env.PORT ?? "3001",
      10
    )
  },
  runtimeConfig: {
    // Server-only: the api-gateway address never reaches the client bundle —
    // all browser/SSR traffic goes through same-origin /api/* server routes.
    gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3000"
  },
  compatibilityDate: "2025-10-01"
});
