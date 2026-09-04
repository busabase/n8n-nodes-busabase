import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "credentials/BusabaseApi.credentials": "credentials/BusabaseApi.credentials.ts",
    "nodes/Busabase/Busabase.node": "nodes/Busabase/Busabase.node.ts",
    "nodes/Busabase/GenericFunctions": "nodes/Busabase/GenericFunctions.ts",
    "nodes/BusabaseTrigger/BusabaseTrigger.node": "nodes/BusabaseTrigger/BusabaseTrigger.node.ts",
  },
  format: ["cjs"],
  // n8n loads community nodes as CommonJS (`require(...)`); ESM output is not
  // supported by n8n's node loader regardless of this package's own `"type"`.
  dts: false,
  clean: true,
  outExtensions: () => ({ js: ".js" }),
  external: [/^n8n-workflow/],
});
